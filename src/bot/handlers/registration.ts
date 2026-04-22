import { Markup } from "telegraf";
import type { Telegraf, Context } from "telegraf";
import type { BotDeps } from "../deps";
import { showMainMenu } from "../ui";
import { formatCarInfo } from "../../utils";

type StartDriveFlow = (args: { ctx: Context; telegramId: number }) => Promise<void>;
type StartRideFlow = (args: { ctx: Context; telegramId: number }) => Promise<void>;
type CreateWazeDrive = (args: {
  ctx: Context;
  telegramId: number;
  url: string;
}) => Promise<boolean>;

export interface RegisterRegistrationHandlersArgs {
  bot: Telegraf;
  deps: BotDeps;
  startDrivePostingFlow: StartDriveFlow;
  startRideRequestFlow: StartRideFlow;
  createWazeDriveFromUrl: CreateWazeDrive;
}

export function registerRegistrationHandlers({
  bot,
  deps,
  startDrivePostingFlow,
  startRideRequestFlow,
  createWazeDriveFromUrl,
}: RegisterRegistrationHandlersArgs): { handleMessage: (ctx: Context) => Promise<boolean> } {
  const { repo, sessions, logger, carRecognition } = deps;

  async function afterProfileComplete(ctx: Context, telegramId: number): Promise<void> {
    const session = sessions.get(telegramId);
    const pendingAction = session.data.pendingAction as string | undefined;
    const user = repo.getUserById(session.userId!)!;

    if (pendingAction === "drive") {
      await startDrivePostingFlow({ ctx, telegramId });
    } else if (pendingAction === "ride") {
      await startRideRequestFlow({ ctx, telegramId });
    } else {
      await showMainMenu(ctx, user.firstName);
    }
  }

  // --- Gender selection callbacks ---
  for (const g of ["male", "female", "other"] as const) {
    bot.action(`gender_${g}`, async (ctx) => {
      await ctx.answerCbQuery();
      const telegramId = ctx.from!.id;
      const session = sessions.get(telegramId);
      if (!session.userId) return;

      repo.updateUserProfile(session.userId, { gender: g });
      logger.info("profile_gender_set", { telegramId, userId: session.userId, gender: g });

      // Try Telegram profile photo if not yet set
      const user = repo.getUserById(session.userId)!;
      if (!user.photoFileId) {
        try {
          const profilePhotos = await ctx.telegram.getUserProfilePhotos(telegramId, 0, 1);
          if (profilePhotos.total_count > 0) {
            const largest = profilePhotos.photos[0][profilePhotos.photos[0].length - 1];
            repo.updateUserProfile(session.userId, { photoFileId: largest.file_id });
            const verifications = repo.getVerifications(session.userId);
            if (!verifications.find((v) => v.type === "photo")) {
              repo.addVerification({ userId: session.userId, type: "photo" });
            }
            logger.info("profile_photo_obtained_telegram", { telegramId, userId: session.userId });
            await ctx.editMessageText("Got it! 👍");
            await afterProfileComplete(ctx, telegramId);
            return;
          }
        } catch {
          // fall through to manual photo upload
        }

        sessions.setScene({ telegramId, scene: "registration_photo", data: session.data });
        await ctx.editMessageText(
          "Got it.\n\nNow, send me a photo of yourself. " +
            "This helps the other party recognize you.",
        );
        return;
      }

      await ctx.editMessageText("Got it! 👍");
      await afterProfileComplete(ctx, telegramId);
    });
  }

  // --- Car confirmation callbacks ---
  bot.action("car_confirm_yes", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    const { carDetails, carPhotoFileId } = session.data;

    if (!session.userId || !carDetails) return;

    const car = repo.addCar({
      userId: session.userId,
      plateNumber: carDetails.plateNumber,
      make: carDetails.make,
      model: carDetails.model,
      color: carDetails.color,
      year: carDetails.year,
      seatCount: carDetails.seatCount,
      photoFileId: carPhotoFileId,
    });

    repo.addVerification({ userId: session.userId, type: "car" });
    logger.info("car_registered", {
      telegramId,
      userId: session.userId,
      carId: car.id,
      seatCount: car.seatCount,
      year: car.year,
    });

    await ctx.editMessageText(`Car registered! ✅\n\n` + formatCarInfo(car));

    if (session.data.pendingWazeDriveUrl) {
      await createWazeDriveFromUrl({ ctx, telegramId, url: session.data.pendingWazeDriveUrl });
      return;
    }

    // Auto-continue into the drive posting flow
    await startDrivePostingFlow({ ctx, telegramId });
  });

  bot.action("car_confirm_retry", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    sessions.setScene({ telegramId, scene: "car_registration_photo", data: {} });
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
      sessions.setScene({ telegramId, scene: "car_edit" });
      await ctx.editMessageText(carEditPrompts[field], { parse_mode: "Markdown" });
    });
  }

  async function handleMessage(ctx: Context): Promise<boolean> {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    const msg = (ctx as any).message;

    // --- Profile: photo (manual upload when no Telegram profile photo) ---
    if (session.scene === "registration_photo" && "photo" in msg) {
      const photos = msg.photo;
      const largest = photos[photos.length - 1];
      if (!session.userId) return true;

      repo.updateUserProfile(session.userId, { photoFileId: largest.file_id });
      const verifications = repo.getVerifications(session.userId);
      if (!verifications.find((v) => v.type === "photo")) {
        repo.addVerification({ userId: session.userId, type: "photo" });
      }
      sessions.setScene({ telegramId, scene: "idle" });
      logger.info("profile_photo_uploaded", { telegramId, userId: session.userId });

      await afterProfileComplete(ctx, telegramId);
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
      logger.info("car_photo_received", {
        telegramId,
        userId: session.userId,
      });

      const carDetails = await carRecognition.extractFromTelegramPhoto(largest.file_id);

      if (!carDetails) {
        logger.warn("car_photo_analysis_failed", {
          telegramId,
          userId: session.userId,
        });
        await ctx.reply(
          "I couldn't read the car details from that photo. " +
            "Please try again with a clearer shot of the rear of the car, " +
            "with the license plate visible.",
        );
        return true;
      }

      sessions.updateData(telegramId, { carDetails, carPhotoFileId: largest.file_id });
      sessions.setScene({ telegramId, scene: "car_registration_confirm" });
      logger.info("car_photo_analysis_completed", {
        telegramId,
        userId: session.userId,
        seatCount: carDetails.seatCount,
        year: carDetails.year,
        hasPlate: carDetails.plateNumber !== "unknown",
      });

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
      sessions.setScene({ telegramId, scene: "car_registration_confirm" });
      logger.info("car_details_edited", {
        telegramId,
        userId: session.userId,
        field,
      });

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

  return { handleMessage };
}
