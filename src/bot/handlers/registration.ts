import { Markup } from "telegraf";
import type { Telegraf, Context } from "telegraf";
import type { BotDeps } from "../deps";
import { showMainMenu } from "../ui";
import { formatCarInfo, formatTrustProfile } from "../../utils";

// Imported lazily to avoid circular deps — registration completes and may hand off to drive posting
import type { BotDeps as _Deps } from "../deps";

type StartDriveFlow = (ctx: Context, telegramId: number) => Promise<void>;
type CreateWazeDrive = (ctx: Context, telegramId: number, url: string) => Promise<boolean>;

export function registerRegistrationHandlers(
  bot: Telegraf,
  deps: BotDeps,
  startDrivePostingFlow: StartDriveFlow,
  createWazeDriveFromUrl: CreateWazeDrive,
): void {
  const { repo, sessions } = deps;

  async function finishRegistration(ctx: Context, telegramId: number): Promise<void> {
    const session = sessions.get(telegramId);
    if (!session.userId) return;
    const user = repo.getUserById(session.userId)!;
    const verifications = repo.getVerifications(session.userId);
    const profile = formatTrustProfile(user, verifications);

    await ctx.reply(`You're all set! 🎉\n\nYour trust profile:\n${profile}`);
    await showMainMenu(ctx, user.firstName);

    if (session.data.pendingWazeDriveUrl) {
      await createWazeDriveFromUrl(ctx, telegramId, session.data.pendingWazeDriveUrl);
    }
  }

  // --- Gender selection callbacks ---
  for (const g of ["male", "female", "other"] as const) {
    bot.action(`gender_${g}`, async (ctx) => {
      await ctx.answerCbQuery();
      const telegramId = ctx.from!.id;
      sessions.updateData(telegramId, { gender: g });

      // Try to use their existing Telegram profile photo — avoids asking for a selfie
      try {
        const profilePhotos = await ctx.telegram.getUserProfilePhotos(telegramId, 0, 1);
        if (profilePhotos.total_count > 0) {
          const largest = profilePhotos.photos[0][profilePhotos.photos[0].length - 1];
          const firstName = sessions.get(telegramId).data.firstName;

          const user = repo.createUser(telegramId, firstName);
          repo.updateUserProfile(user.id, {
            gender: g,
            photoFileId: largest.file_id,
            phone: String(telegramId),
          });
          repo.addVerification(user.id, "phone");
          repo.addVerification(user.id, "photo");

          sessions.setUserId(telegramId, user.id);
          sessions.setScene(telegramId, "idle");

          await ctx.editMessageText(`Got it! 👍`);
          await finishRegistration(ctx, telegramId);
          return;
        }
      } catch {
        // Fall through to manual photo upload
      }

      sessions.setScene(telegramId, "registration_photo");
      await ctx.editMessageText(
        `Got it.\n\nNow, send me a photo of yourself. ` +
          `This helps the other party recognize you.`,
      );
    });
  }

  // --- Car confirmation callbacks ---
  bot.action("car_confirm_yes", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    const { carDetails, carPhotoFileId } = session.data;

    if (!session.userId || !carDetails) return;

    const car = repo.addCar(
      session.userId,
      carDetails.plateNumber,
      carDetails.make,
      carDetails.model,
      carDetails.color,
      carDetails.year,
      carDetails.seatCount,
      carPhotoFileId,
    );

    repo.addVerification(session.userId, "car");

    await ctx.editMessageText(`Car registered! ✅\n\n` + formatCarInfo(car));

    if (session.data.pendingWazeDriveUrl) {
      await createWazeDriveFromUrl(ctx, telegramId, session.data.pendingWazeDriveUrl);
      return;
    }

    // Auto-continue into the drive posting flow
    await startDrivePostingFlow(ctx, telegramId);
  });

  bot.action("car_confirm_retry", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    sessions.setScene(telegramId, "car_registration_photo", {});
    await ctx.editMessageText("No problem. Send another photo of your car.");
  });

  bot.action("car_confirm_edit", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      "What do you want to fix?",
      Markup.inlineKeyboard([
        [Markup.button.callback("Plate number", "car_edit_plate")],
        [Markup.button.callback("Seats available", "car_edit_seats")],
        [Markup.button.callback("Make / model", "car_edit_make")],
        [Markup.button.callback("Year", "car_edit_year")],
        [Markup.button.callback("Try another photo instead", "car_confirm_retry")],
      ]),
    );
  });

  const carEditPrompts: Record<string, string> = {
    plate: "Enter the correct plate number:",
    seats: "How many passenger seats? (not counting the driver, 1–8)",
    make: "Enter the make and model (e.g. *Toyota Corolla*):",
    year: "Enter the year of manufacture (e.g. *2019*):",
  };

  for (const field of ["plate", "seats", "make", "year"] as const) {
    bot.action(`car_edit_${field}`, async (ctx) => {
      await ctx.answerCbQuery();
      const telegramId = ctx.from!.id;
      sessions.updateData(telegramId, { carEditField: field });
      sessions.setScene(telegramId, "car_edit");
      await ctx.editMessageText(carEditPrompts[field], { parse_mode: "Markdown" });
    });
  }
}

export async function handleRegistrationMessage(
  ctx: Context,
  deps: BotDeps,
  finishRegistrationCb: (ctx: Context, telegramId: number) => Promise<void>,
): Promise<boolean> {
  const telegramId = ctx.from!.id;
  const { repo, sessions, carRecognition } = deps;
  const session = sessions.get(telegramId);
  const msg = (ctx as any).message;

  // --- Registration: name ---
  if (session.scene === "registration_name" && "text" in msg) {
    const firstName = msg.text.trim();
    if (!firstName || firstName.length > 50) {
      await ctx.reply("Please enter a valid first name.");
      return true;
    }

    sessions.updateData(telegramId, { firstName });
    sessions.setScene(telegramId, "registration_gender");

    await ctx.reply(
      `Nice to meet you, ${firstName}!\n\nWhat's your gender?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Male", "gender_male")],
        [Markup.button.callback("Female", "gender_female")],
        [Markup.button.callback("Other", "gender_other")],
      ]),
    );
    return true;
  }

  // --- Registration: photo (fallback if no Telegram profile photo) ---
  if (session.scene === "registration_photo" && "photo" in msg) {
    const photos = msg.photo;
    const largest = photos[photos.length - 1];

    const user = repo.createUser(telegramId, session.data.firstName);
    repo.updateUserProfile(user.id, {
      gender: session.data.gender,
      photoFileId: largest.file_id,
      phone: ctx.from?.id ? String(ctx.from.id) : undefined,
    });

    repo.addVerification(user.id, "phone");
    repo.addVerification(user.id, "photo");

    sessions.setUserId(telegramId, user.id);
    sessions.setScene(telegramId, "idle");

    await finishRegistrationCb(ctx, telegramId);
    return true;
  }

  if (session.scene === "registration_photo" && !("photo" in msg)) {
    await ctx.reply("Please send a photo of yourself (just a normal selfie).");
    return true;
  }

  // --- Car registration: photo ---
  if (session.scene === "car_registration_photo" && "photo" in msg) {
    const photos = msg.photo;
    const largest = photos[photos.length - 1];

    await ctx.reply("Analyzing your car photo... 🔍");

    const carDetails = await carRecognition.extractFromTelegramPhoto(largest.file_id);

    if (!carDetails) {
      await ctx.reply(
        "I couldn't read the car details from that photo. " +
          "Please try again with a clearer shot of the rear of the car, " +
          "with the license plate visible.",
      );
      return true;
    }

    sessions.updateData(telegramId, { carDetails, carPhotoFileId: largest.file_id });
    sessions.setScene(telegramId, "car_registration_confirm");

    await ctx.reply(
      `Got it! Here's what I found:\n\n` +
        `🚗 ${carDetails.make} ${carDetails.model}, ${carDetails.color}` +
        (carDetails.year ? `, ${carDetails.year}` : "") +
        `\n` +
        `🔢 Plate: ${carDetails.plateNumber}\n` +
        `👥 Seats: ${carDetails.seatCount}\n\n` +
        `Does this look right?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Yes, looks good", "car_confirm_yes")],
        [Markup.button.callback("Fix something", "car_confirm_edit")],
        [Markup.button.callback("Try another photo", "car_confirm_retry")],
      ]),
    );
    return true;
  }

  // --- Car field editing ---
  if (session.scene === "car_edit" && "text" in msg) {
    const field = session.data.carEditField as string;
    const carDetails = { ...session.data.carDetails };
    const text = msg.text.trim();

    if (field === "plate") {
      carDetails.plateNumber = text;
    } else if (field === "seats") {
      const seats = parseInt(text, 10);
      if (isNaN(seats) || seats < 1 || seats > 8) {
        await ctx.reply("Please enter a number between 1 and 8.");
        return true;
      }
      carDetails.seatCount = seats;
    } else if (field === "make") {
      const parts = text.split(" ");
      carDetails.make = parts[0];
      if (parts.length > 1) carDetails.model = parts.slice(1).join(" ");
    } else if (field === "year") {
      const year = parseInt(text, 10);
      if (isNaN(year) || year < 1990 || year > new Date().getFullYear() + 1) {
        await ctx.reply("Please enter a valid year.");
        return true;
      }
      carDetails.year = year;
    }

    sessions.updateData(telegramId, { carDetails, carEditField: undefined });
    sessions.setScene(telegramId, "car_registration_confirm");

    await ctx.reply(
      `Updated! Here's what I have:\n\n` +
        `🚗 ${carDetails.make} ${carDetails.model}, ${carDetails.color}` +
        (carDetails.year ? `, ${carDetails.year}` : "") +
        `\n` +
        `🔢 Plate: ${carDetails.plateNumber}\n` +
        `👥 Seats: ${carDetails.seatCount}\n\nDoes this look right?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Yes, looks good", "car_confirm_yes")],
        [Markup.button.callback("Fix something", "car_confirm_edit")],
        [Markup.button.callback("Try another photo", "car_confirm_retry")],
      ]),
    );
    return true;
  }

  return false;
}
