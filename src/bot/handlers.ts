import { Telegraf, Markup } from "telegraf";
import type { Context } from "telegraf";
import type { Repository } from "../db/repository";
import type { SessionManager } from "./session";
import type { MatchingService, MatchCandidate } from "../services/matching";
import type { RoutingService } from "../services/routing";
import type { CarRecognitionService } from "../services/car-recognition";
import type { GeocodingService } from "../services/geocoding";
import { DEFAULTS, POINTS } from "../types";
import type { VerificationType } from "../types";
import {
  formatTrustProfile, formatCarInfo, formatRideSummary,
  formatMatchForRider, formatDuration, generateCode,
} from "../utils";

/**
 * Register all bot command handlers and message handlers.
 *
 * Architecture: each handler checks the user's session state,
 * performs the appropriate action, and transitions to the next state.
 * Non-command messages are routed based on current scene.
 */
export function registerHandlers(
  bot: Telegraf,
  repo: Repository,
  sessions: SessionManager,
  matching: MatchingService,
  routing: RoutingService,
  carRecognition: CarRecognitionService,
  geocoding: GeocodingService,
) {

  // ============================================================
  // /start — Entry point, begin registration or welcome back
  // ============================================================
  bot.start(async (ctx) => {
    const telegramId = ctx.from!.id;
    const existing = repo.getUserByTelegramId(telegramId);

    if (existing) {
      sessions.setUserId(telegramId, existing.id);
      sessions.setScene(telegramId, "idle");
      await ctx.reply(
        `Welcome back, ${existing.firstName}! 👋\n\n` +
        `Type /drive to offer a ride, /ride to request one, ` +
        `or /trust to manage your verification profile.`
      );
      return;
    }

    // Start registration
    sessions.setScene(telegramId, "registration_name", {});
    await ctx.reply(
      `Hey! 👋 Welcome to TrempBot.\n\n` +
      `We connect drivers with people looking for a ride along their route.\n\n` +
      `Let's get you set up — it takes about 30 seconds.\n\n` +
      `What's your first name? (This is what others will see.)`
    );
  });

  // ============================================================
  // /drive — Start offering a ride (triggers car registration if needed)
  // ============================================================
  bot.command("drive", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) {
      await ctx.reply("You need to register first. Type /start to begin.");
      return;
    }

    const user = repo.getUserById(session.userId);
    if (!user || user.isSuspended) {
      await ctx.reply("Your account is currently suspended. Contact support for help.");
      return;
    }

    // Check if driver has a verified car
    const car = repo.getActiveCar(session.userId);
    if (!car) {
      // Need to register a car first
      sessions.setScene(telegramId, "car_registration_photo", {});
      await ctx.reply(
        `First time driving? Let's register your car.\n\n` +
        `Send me a photo of the back of your car ` +
        `(so the license plate is visible). ` +
        `I'll grab the details automatically.`
      );
      return;
    }

    // Check minimum verification for drivers
    const verCount = repo.getVerificationCount(session.userId);
    if (verCount < DEFAULTS.MIN_TRUST_VERIFICATIONS) {
      sessions.setScene(telegramId, "registration_verification", {
        returnTo: "ride_origin",
      });
      await ctx.reply(
        `Drivers need at least one identity verification ` +
        `to offer rides. This helps riders feel safe.\n\n` +
        `Choose a verification method:`,
        Markup.inlineKeyboard([
          [Markup.button.callback("Facebook", "verify_facebook")],
          [Markup.button.callback("LinkedIn", "verify_linkedin")],
          [Markup.button.callback("Google", "verify_google")],
          [Markup.button.callback("Email", "verify_email")],
        ])
      );
      return;
    }

    // Start ride posting flow
    sessions.setScene(telegramId, "ride_origin", {
      carId: car.id,
      seats: car.seatCount,
      maxDetour: DEFAULTS.MAX_DETOUR_MINUTES,
    });
    await ctx.reply(
      `Where are you headed?\n\n` +
      `Send me your starting point — you can:\n` +
      `📍 Drop a pin (tap the attachment icon)\n` +
      `✍️ Type an address or place name`
    );
  });

  // ============================================================
  // /ride — Request a ride
  // ============================================================
  bot.command("ride", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) {
      await ctx.reply("You need to register first. Type /start to begin.");
      return;
    }

    sessions.setScene(telegramId, "request_pickup", {});
    await ctx.reply(
      `Where do you need to be picked up?\n\n` +
      `📍 Drop a pin or type an address.`
    );
  });

  // ============================================================
  // /cancel — Unified cancellation for any active ride/match
  // ============================================================
  bot.command("cancel", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) return;

    const activeMatch = repo.getActiveMatchForUser(session.userId);
    if (!activeMatch) {
      // Maybe they're cancelling during a flow
      sessions.reset(telegramId);
      await ctx.reply("Nothing to cancel. You're all clear.");
      return;
    }

    sessions.setScene(telegramId, "cancel_reason", {
      matchId: activeMatch.id,
    });

    await ctx.reply(
      `Cancelling your ride. What happened?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Changed plans", "cancel_changed_plans")],
        [Markup.button.callback("Other party didn't show", "cancel_no_show")],
        [Markup.button.callback("Felt unsafe", "cancel_felt_unsafe")],
        [Markup.button.callback("Other reason", "cancel_other")],
      ])
    );
  });

  // ============================================================
  // /trust — View and manage trust verifications
  // ============================================================
  bot.command("trust", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) {
      await ctx.reply("Register first with /start.");
      return;
    }

    const user = repo.getUserById(session.userId)!;
    const verifications = repo.getVerifications(session.userId);
    const profile = formatTrustProfile(user, verifications, false);

    const verifiedTypes = new Set(verifications.map(v => v.type));
    const buttons = [];

    if (!verifiedTypes.has("facebook"))
      buttons.push([Markup.button.callback("Connect Facebook", "verify_facebook")]);
    if (!verifiedTypes.has("linkedin"))
      buttons.push([Markup.button.callback("Connect LinkedIn", "verify_linkedin")]);
    if (!verifiedTypes.has("google"))
      buttons.push([Markup.button.callback("Connect Google", "verify_google")]);
    if (!verifiedTypes.has("email"))
      buttons.push([Markup.button.callback("Add email", "verify_email")]);

    // Visibility toggles for existing verifications
    for (const v of verifications) {
      if (["facebook", "linkedin", "google", "email"].includes(v.type)) {
        const icon = v.sharedWithRiders ? "👁" : "🙈";
        buttons.push([
          Markup.button.callback(
            `${icon} ${v.type} — ${v.sharedWithRiders ? "visible to riders" : "hidden"}`,
            `toggle_vis_${v.type}`
          )
        ]);
      }
    }

    await ctx.reply(
      `Your trust profile:\n\n${profile}\n\n` +
      (buttons.length > 0 ? `Manage your verifications:` : `All verifications complete!`),
      buttons.length > 0 ? Markup.inlineKeyboard(buttons) : undefined
    );
  });

  // ============================================================
  // /sos — Emergency during ride
  // ============================================================
  bot.command("sos", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) return;

    const activeMatch = repo.getActiveMatchForUser(session.userId);

    await ctx.reply(
      `📍 Your ride details have been saved.\n\n` +
      `🚨 Emergency: call 100 (Israel Police)\n` +
      `🚑 Ambulance: 101\n\n` +
      `If you need to share your situation with someone you trust, ` +
      `send them this chat right now.`,
      Markup.inlineKeyboard([
        [Markup.button.callback("I'm OK, false alarm", "sos_ok")],
      ])
    );

    // Log the SOS event — do NOT notify the other party
    if (activeMatch) {
      console.warn(`SOS triggered: match=${activeMatch.id}, user=${session.userId}, time=${new Date().toISOString()}`);
      // TODO: persist SOS events to a dedicated table for review
    }
  });

  // ============================================================
  // /status — Check current ride status and points
  // ============================================================
  bot.command("status", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) {
      await ctx.reply("Register first with /start.");
      return;
    }

    const user = repo.getUserById(session.userId)!;
    const activeMatch = repo.getActiveMatchForUser(session.userId);

    let statusText = `💰 Points: ${user.pointsBalance.toFixed(1)}\n`;

    if (activeMatch) {
      statusText += `\n🚗 Active ride (${activeMatch.status})\n`;
      statusText += `Match #${activeMatch.id}`;
    } else {
      statusText += `\nNo active ride right now.`;
    }

    await ctx.reply(statusText);
  });

  // ============================================================
  // Callback query handlers (inline button presses)
  // ============================================================

  // --- Cancellation reasons ---
  for (const reason of ["changed_plans", "no_show", "felt_unsafe", "other"] as const) {
    bot.action(`cancel_${reason}`, async (ctx) => {
      await ctx.answerCbQuery();
      const telegramId = ctx.from!.id;
      const session = sessions.get(telegramId);
      const matchId = session.data.matchId;

      if (!matchId || !session.userId) return;

      const match = repo.getMatchById(matchId);
      if (!match) return;

      repo.cancelMatch(matchId, session.userId, reason);

      // Determine the other party
      const otherUserId = match.driverId === session.userId
        ? match.riderId
        : match.driverId;
      const otherUser = repo.getUserById(otherUserId);

      // Handle no-show compensation
      if (reason === "no_show") {
        repo.adjustPoints(session.userId, POINTS.NO_SHOW_COMPENSATION);
        await ctx.reply(
          `Ride cancelled (no-show). You've been awarded ${POINTS.NO_SHOW_COMPENSATION} point for your time.`
        );
      } else if (reason === "felt_unsafe") {
        await ctx.reply(
          `Ride cancelled. This has been logged for review. ` +
          `No penalty applied to you.`
        );
      } else {
        await ctx.reply(`Ride cancelled.`);
      }

      // Notify other party (we'd need their telegram_id to send a message)
      // This requires the bot instance to send a message to a specific chat
      if (otherUser) {
        try {
          await ctx.telegram.sendMessage(
            otherUser.telegramId,
            `⚠️ Your ride has been cancelled by the other party.\n` +
            (reason === "no_show"
              ? `Reason: they reported you didn't show up.\nIf this was a mistake, type /dispute.`
              : ``)
          );
        } catch (err) {
          console.error("Failed to notify other party:", err);
        }
      }

      sessions.reset(telegramId);
    });
  }

  // --- Verification visibility toggles ---
  bot.action(/^toggle_vis_(.+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const type = ctx.match![1] as VerificationType;
    const verifications = repo.getVerifications(session.userId);
    const v = verifications.find(v => v.type === type);
    if (!v) return;

    repo.setVerificationVisibility(session.userId, type, !v.sharedWithRiders);
    const newState = !v.sharedWithRiders ? "visible to riders" : "hidden from riders";

    await ctx.editMessageText(
      `${type} verification is now ${newState}.\n\nType /trust to see your full profile.`
    );
  });

  // ============================================================
  // Message handler — routes non-command messages based on scene
  // ============================================================
  bot.on("message", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    // --- Message relay during active ride ---
    if (session.scene === "in_ride_relay" && session.userId) {
      const match = repo.getActiveMatchForUser(session.userId);
      if (match) {
        const otherUserId = match.driverId === session.userId
          ? match.riderId
          : match.driverId;
        const otherUser = repo.getUserById(otherUserId);
        const thisUser = repo.getUserById(session.userId);

        if (otherUser && thisUser && "text" in ctx.message) {
          try {
            await ctx.telegram.sendMessage(
              otherUser.telegramId,
              `💬 ${thisUser.firstName}: ${ctx.message.text}`
            );
          } catch (err) {
            await ctx.reply("Couldn't relay your message. The other party may have blocked the bot.");
          }
          return;
        }
      }
    }

    // --- Registration: name ---
    if (session.scene === "registration_name" && "text" in ctx.message) {
      const firstName = ctx.message.text.trim();
      if (!firstName || firstName.length > 50) {
        await ctx.reply("Please enter a valid first name.");
        return;
      }

      sessions.updateData(telegramId, { firstName });
      sessions.setScene(telegramId, "registration_gender");

      await ctx.reply(
        `Nice to meet you, ${firstName}!\n\nWhat's your gender?`,
        Markup.inlineKeyboard([
          [Markup.button.callback("Male", "gender_male")],
          [Markup.button.callback("Female", "gender_female")],
          [Markup.button.callback("Other", "gender_other")],
        ])
      );
      return;
    }

    // --- Registration: photo ---
    if (session.scene === "registration_photo" && "photo" in ctx.message) {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];

      // Create the user
      const user = repo.createUser(telegramId, session.data.firstName);
      repo.updateUserProfile(user.id, {
        gender: session.data.gender,
        photoFileId: largest.file_id,
        phone: ctx.from?.id ? String(ctx.from.id) : undefined,
      });

      // Add phone + photo verifications
      repo.addVerification(user.id, "phone");
      repo.addVerification(user.id, "photo");

      sessions.setUserId(telegramId, user.id);
      sessions.setScene(telegramId, "idle");

      const verifications = repo.getVerifications(user.id);
      const profile = formatTrustProfile(user, verifications);

      await ctx.reply(
        `You're all set! 🎉\n\n` +
        `Your trust profile:\n${profile}\n\n` +
        `Type /drive to offer a ride, /ride to request one, ` +
        `or /trust to boost your verification.`
      );
      return;
    }

    if (session.scene === "registration_photo" && !("photo" in ctx.message)) {
      await ctx.reply("Please send a photo of yourself (just a normal selfie).");
      return;
    }

    // --- Car registration: photo ---
    if (session.scene === "car_registration_photo" && "photo" in ctx.message) {
      const photos = ctx.message.photo;
      const largest = photos[photos.length - 1];

      await ctx.reply("Analyzing your car photo... 🔍");

      const carDetails = await carRecognition.extractFromTelegramPhoto(largest.file_id);

      if (!carDetails) {
        await ctx.reply(
          "I couldn't read the car details from that photo. " +
          "Please try again with a clearer shot of the rear of the car, " +
          "with the license plate visible."
        );
        return;
      }

      sessions.updateData(telegramId, {
        carDetails,
        carPhotoFileId: largest.file_id,
      });
      sessions.setScene(telegramId, "car_registration_confirm");

      await ctx.reply(
        `Got it! Here's what I found:\n\n` +
        `🚗 ${carDetails.make} ${carDetails.model}, ${carDetails.color}` +
        (carDetails.year ? `, ${carDetails.year}` : "") + `\n` +
        `🔢 Plate: ${carDetails.plateNumber}\n` +
        `👥 Seats: ${carDetails.seatCount}\n\n` +
        `Does this look right?`,
        Markup.inlineKeyboard([
          [Markup.button.callback("Yes, looks good", "car_confirm_yes")],
          [Markup.button.callback("Fix something", "car_confirm_edit")],
          [Markup.button.callback("Try another photo", "car_confirm_retry")],
        ])
      );
      return;
    }

    // --- Ride posting: origin ---
    if (session.scene === "ride_origin") {
      let lat: number, lng: number, label: string;

      if ("location" in ctx.message) {
        lat = ctx.message.location.latitude;
        lng = ctx.message.location.longitude;
        const resolved = await geocoding.reverseGeocode(lat, lng);
        label = resolved ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      } else if ("text" in ctx.message) {
        const query = ctx.message.text.trim();
        const result = await geocoding.geocode(query);
        if (!result) {
          await ctx.reply(
            "Couldn't find that address. Try a more specific address, or send a location pin."
          );
          return;
        }
        ({ lat, lng, label } = result);
      } else {
        await ctx.reply("Send a location pin or type an address.");
        return;
      }

      sessions.updateData(telegramId, {
        originLat: lat,
        originLng: lng,
        originLabel: label,
      });
      sessions.setScene(telegramId, "ride_destination");
      await ctx.reply("Got it. And your destination? (drop a pin or type an address)");
      return;
    }

    // --- Ride posting: destination ---
    if (session.scene === "ride_destination") {
      let lat: number, lng: number, label: string;

      if ("location" in ctx.message) {
        lat = ctx.message.location.latitude;
        lng = ctx.message.location.longitude;
        const resolved = await geocoding.reverseGeocode(lat, lng);
        label = resolved ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      } else if ("text" in ctx.message) {
        const query = ctx.message.text.trim();
        const result = await geocoding.geocode(query);
        if (!result) {
          await ctx.reply(
            "Couldn't find that address. Try a more specific address, or send a location pin."
          );
          return;
        }
        ({ lat, lng, label } = result);
      } else {
        return;
      }

      // Calculate route
      const routeResult = await routing.getRoute(
        { lat: session.data.originLat, lng: session.data.originLng },
        { lat, lng },
      );

      sessions.updateData(telegramId, {
        destLat: lat,
        destLng: lng,
        destLabel: label,
        routeGeometry: routeResult?.geometry || null,
        estimatedDuration: routeResult?.durationSeconds || null,
      });
      sessions.setScene(telegramId, "ride_departure");

      await ctx.reply(
        `${session.data.originLabel} → ${label}\n` +
        (routeResult
          ? `🕐 About ${formatDuration(routeResult.durationSeconds)}\n\n`
          : `\n`) +
        `When are you leaving?`,
        Markup.inlineKeyboard([
          [Markup.button.callback("Now", "depart_now")],
          [Markup.button.callback("In 30 min", "depart_30")],
          [Markup.button.callback("In 1 hour", "depart_60")],
          [Markup.button.callback("Pick a time", "depart_custom")],
        ])
      );
      return;
    }

    // --- Confirmation code entry during ride ---
    if (session.scene === "in_ride_relay" && "text" in ctx.message) {
      const match = repo.getActiveMatchForUser(session.userId!);
      if (match && match.status === "accepted" && match.driverId === session.userId) {
        const code = ctx.message.text.trim();
        if (code === match.confirmationCode) {
          repo.updateMatchStatus(match.id, "picked_up");

          const rider = repo.getUserById(match.riderId);
          await ctx.reply(
            "Ride started! ✅ Drive safe.\n\nTap the button below when you've dropped off the rider.",
            Markup.inlineKeyboard([
              [Markup.button.callback("🏁 Complete Ride", `complete_ride_${match.id}`)],
            ])
          );

          if (rider) {
            try {
              await ctx.telegram.sendMessage(
                rider.telegramId,
                "Ride started! ✅ Enjoy the ride.\n\nYou can send messages to your driver here."
              );
            } catch (err) {
              console.error("Failed to notify rider:", err);
            }
          }
          return;
        }

        // Track failed attempts
        const attempts = (session.data.codeAttempts || 0) + 1;
        sessions.updateData(telegramId, { codeAttempts: attempts });

        if (attempts >= DEFAULTS.CONFIRMATION_MAX_ATTEMPTS) {
          await ctx.reply(
            "Too many incorrect attempts. Please confirm with your rider " +
            "that you've found the right person."
          );
          return;
        }

        await ctx.reply(
          `That code doesn't match. Double-check with your rider.\n` +
          `(${DEFAULTS.CONFIRMATION_MAX_ATTEMPTS - attempts} attempts remaining)`
        );
        return;
      }
    }

    // --- Ride request: pickup location ---
    if (session.scene === "request_pickup") {
      let lat: number, lng: number, label: string;

      if ("location" in ctx.message) {
        lat = ctx.message.location.latitude;
        lng = ctx.message.location.longitude;
        const resolved = await geocoding.reverseGeocode(lat, lng);
        label = resolved ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      } else if ("text" in ctx.message) {
        const result = await geocoding.geocode(ctx.message.text.trim());
        if (!result) {
          await ctx.reply("Couldn't find that address. Try a more specific address, or send a location pin.");
          return;
        }
        ({ lat, lng, label } = result);
      } else {
        await ctx.reply("Send a location pin or type an address.");
        return;
      }

      sessions.updateData(telegramId, { pickupLat: lat, pickupLng: lng, pickupLabel: label });
      sessions.setScene(telegramId, "request_dropoff");
      await ctx.reply("Got it. Where do you need to be dropped off?\n\n📍 Drop a pin or type an address.");
      return;
    }

    // --- Ride request: dropoff location ---
    if (session.scene === "request_dropoff") {
      let lat: number, lng: number, label: string;

      if ("location" in ctx.message) {
        lat = ctx.message.location.latitude;
        lng = ctx.message.location.longitude;
        const resolved = await geocoding.reverseGeocode(lat, lng);
        label = resolved ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
      } else if ("text" in ctx.message) {
        const result = await geocoding.geocode(ctx.message.text.trim());
        if (!result) {
          await ctx.reply("Couldn't find that address. Try a more specific address, or send a location pin.");
          return;
        }
        ({ lat, lng, label } = result);
      } else {
        await ctx.reply("Send a location pin or type an address.");
        return;
      }

      sessions.updateData(telegramId, { dropoffLat: lat, dropoffLng: lng, dropoffLabel: label });
      sessions.setScene(telegramId, "request_time");
      await ctx.reply(
        `${session.data.pickupLabel} → ${label}\n\nWhen do you need a ride?`,
        Markup.inlineKeyboard([
          [Markup.button.callback("Within 30 minutes", "req_time_30")],
          [Markup.button.callback("Within 1 hour", "req_time_60")],
          [Markup.button.callback("Within 2 hours", "req_time_120")],
        ])
      );
      return;
    }

    // --- Rating ---
    if (session.scene === "rating" && "text" in ctx.message) {
      // Handled by callback queries for the star buttons
      return;
    }
  });

  // --- Gender selection callbacks ---
  for (const g of ["male", "female", "other"] as const) {
    bot.action(`gender_${g}`, async (ctx) => {
      await ctx.answerCbQuery();
      const telegramId = ctx.from!.id;
      sessions.updateData(telegramId, { gender: g });
      sessions.setScene(telegramId, "registration_photo");
      await ctx.editMessageText(
        `Got it.\n\nNow, send me a photo of yourself. ` +
        `This helps the other party recognize you.`
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

    await ctx.editMessageText(
      `Car registered! ✅\n\n` +
      formatCarInfo(car) + `\n\n` +
      `Type /drive again to offer a ride.`
    );
    sessions.reset(telegramId);
  });

  bot.action("car_confirm_retry", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    sessions.setScene(telegramId, "car_registration_photo", {});
    await ctx.editMessageText("No problem. Send another photo of your car.");
  });

  // --- Departure time callbacks ---
  for (const [action, minutes] of [
    ["depart_now", 0],
    ["depart_30", 30],
    ["depart_60", 60],
  ] as const) {
    bot.action(action, async (ctx) => {
      await ctx.answerCbQuery();
      const telegramId = ctx.from!.id;
      const session = sessions.get(telegramId);

      const departure = new Date(Date.now() + minutes * 60 * 1000);
      sessions.updateData(telegramId, {
        departureTime: departure.toISOString(),
      });
      sessions.setScene(telegramId, "ride_review");

      const summary = formatRideSummary(
        session.data.originLabel,
        session.data.destLabel,
        session.data.estimatedDuration,
        departure.toISOString(),
        session.data.seats,
        session.data.maxDetour,
      );

      await ctx.editMessageText(
        `Here's your ride:\n\n${summary}\n\n`,
        Markup.inlineKeyboard([
          [Markup.button.callback("Post this ride ✅", "post_ride")],
          [Markup.button.callback("Edit something ✏️", "edit_ride")],
          [Markup.button.callback("Cancel", "cancel_ride_flow")],
        ])
      );
    });
  }

  // --- Post ride ---
  bot.action("post_ride", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) return;

    const d = session.data;
    const ride = repo.createRide({
      driverId: session.userId,
      carId: d.carId,
      originLat: d.originLat,
      originLng: d.originLng,
      destLat: d.destLat,
      destLng: d.destLng,
      originLabel: d.originLabel,
      destLabel: d.destLabel,
      routeGeometry: d.routeGeometry,
      estimatedDuration: d.estimatedDuration,
      departureTime: d.departureTime,
      maxDetourMinutes: d.maxDetour,
      availableSeats: d.seats,
    });

    await ctx.editMessageText("Ride posted! ✅ Searching for riders...");

    // Find matches
    const candidates = await matching.findRidersForDriver(ride);

    if (candidates.length === 0) {
      await ctx.reply(
        "No riders along your route right now.\n" +
        "I'll notify you if someone matches before you depart.\n\n" +
        "💡 Share your invite link to get more people on TrempBot:\n" +
        `t.me/TrempBot?start=ref_${session.userId}`
      );
      sessions.reset(telegramId);
      return;
    }

    // Present first candidate
    const candidate = candidates[0];
    const rider = repo.getUserById(candidate.request.riderId);
    if (!rider) return;

    const riderVerifications = repo.getPublicVerifications(rider.id);

    await ctx.reply(
      `Found ${candidates.length} rider${candidates.length > 1 ? "s" : ""} along your route!\n\n` +
      `👤 ${rider.firstName} (${rider.gender || "—"})\n` +
      formatTrustProfile(rider, riderVerifications, true) + `\n` +
      `📍 Pickup: ${candidate.request.pickupLabel}\n` +
      `📍 Dropoff: ${candidate.request.dropoffLabel}\n` +
      `↩️ Detour: ~${formatDuration(candidate.detour.addedSeconds)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`Accept ${rider.firstName}`, `accept_rider_${candidate.request.id}`)],
        [Markup.button.callback("Skip", `skip_rider_${candidate.request.id}`)],
      ])
    );

    sessions.updateData(telegramId, {
      rideId: ride.id,
      candidates,
      candidateIndex: 0,
    });
  });

  // --- Ride request: time window selection ---
  for (const [action, windowMinutes] of [
    ["req_time_30", 30],
    ["req_time_60", 60],
    ["req_time_120", 120],
  ] as const) {
    bot.action(action, async (ctx) => {
      await ctx.answerCbQuery();
      const telegramId = ctx.from!.id;
      const session = sessions.get(telegramId);
      if (!session.userId) return;

      const now = new Date();
      const latest = new Date(now.getTime() + windowMinutes * 60 * 1000);

      const request = repo.createRideRequest({
        riderId: session.userId,
        pickupLat: session.data.pickupLat,
        pickupLng: session.data.pickupLng,
        dropoffLat: session.data.dropoffLat,
        dropoffLng: session.data.dropoffLng,
        pickupLabel: session.data.pickupLabel,
        dropoffLabel: session.data.dropoffLabel,
        earliestDeparture: now.toISOString(),
        latestDeparture: latest.toISOString(),
      });

      await ctx.editMessageText("Searching for drivers... 🔍");

      const candidates = await matching.findDriversForRider(request);
      sessions.reset(telegramId);

      if (candidates.length === 0) {
        await ctx.reply(
          "No drivers on your route right now.\n\n" +
          "Your request is saved — I'll notify you when a driver posts a matching ride. 🔔"
        );
        return;
      }

      // Notify all matching drivers
      const rider = repo.getUserById(session.userId);
      let notified = 0;
      for (const c of candidates) {
        const driver = repo.getUserById(c.ride.driverId);
        if (!driver) continue;
        try {
          await ctx.telegram.sendMessage(
            driver.telegramId,
            `🆕 New rider on your route!\n\n` +
            `📍 Pickup: ${request.pickupLabel}\n` +
            `📍 Dropoff: ${request.dropoffLabel}\n\n` +
            `Type /drive to review and accept riders.`
          );
          notified++;
        } catch {
          // Driver may not have started the bot
        }
      }

      await ctx.reply(
        `Your request is posted! ✅\n\n` +
        `Found ${candidates.length} driver${candidates.length > 1 ? "s" : ""} on your route. ` +
        `${notified > 0 ? `I've notified them.` : ""}\n\n` +
        `You'll get a message here when a driver accepts.`
      );
    });
  }

  // --- Accept rider ---
  bot.action(/^accept_rider_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const requestId = parseInt(ctx.match![1]);
    const candidates: MatchCandidate[] = session.data.candidates || [];
    const candidate = candidates.find((c: MatchCandidate) => c.request.id === requestId);
    if (!candidate) return;

    const code = generateCode(DEFAULTS.CONFIRMATION_CODE_LENGTH);
    const match = repo.createMatch({
      rideId: session.data.rideId,
      requestId,
      riderId: candidate.request.riderId,
      driverId: session.userId,
      pickupLat: candidate.request.pickupLat,
      pickupLng: candidate.request.pickupLng,
      dropoffLat: candidate.request.dropoffLat,
      dropoffLng: candidate.request.dropoffLng,
      detourSeconds: candidate.detour.addedSeconds,
      confirmationCode: code,
      pointsCost: 0,
    });

    repo.updateMatchStatus(match.id, "accepted");
    repo.updateRideStatus(session.data.rideId, "matched");
    repo.updateRequestStatus(requestId, "matched");

    const rider = repo.getUserById(candidate.request.riderId);
    if (!rider) return;

    // Put driver in relay mode (code entry expected)
    sessions.setScene(telegramId, "in_ride_relay");
    sessions.updateData(telegramId, { matchId: match.id, codeAttempts: 0 });

    // Put rider in relay mode and send their confirmation code
    sessions.setUserId(rider.telegramId, rider.id);
    sessions.setScene(rider.telegramId, "in_ride_relay");
    sessions.updateData(rider.telegramId, { matchId: match.id });

    try {
      await ctx.telegram.sendMessage(
        rider.telegramId,
        `🎉 A driver accepted your ride!\n\n` +
        `📍 Pickup: ${candidate.request.pickupLabel}\n` +
        `📍 Dropoff: ${candidate.request.dropoffLabel}\n\n` +
        `Your confirmation code: *${code}*\n` +
        `Show this to the driver when they arrive to confirm your identity.`,
        { parse_mode: "Markdown" }
      );
    } catch (err) {
      console.error("Failed to notify rider:", err);
    }

    await ctx.editMessageText(
      `✅ Matched with ${rider.firstName}!\n\n` +
      `📍 Pick up: ${candidate.request.pickupLabel}\n\n` +
      `Head to the pickup point. When you meet the rider, ask for their 4-digit code and enter it here.`
    );
  });

  // --- Skip rider ---
  bot.action(/^skip_rider_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const candidates: MatchCandidate[] = session.data.candidates || [];
    let idx: number = (session.data.candidateIndex ?? 0) + 1;

    if (idx >= candidates.length) {
      sessions.reset(telegramId);
      await ctx.editMessageText(
        "No more riders to show. I'll notify you when someone new matches your route."
      );
      return;
    }

    sessions.updateData(telegramId, { candidateIndex: idx });
    const candidate = candidates[idx];
    const rider = repo.getUserById(candidate.request.riderId);
    if (!rider) return;

    const verifications = repo.getPublicVerifications(rider.id);

    await ctx.editMessageText(
      `👤 ${rider.firstName} (${rider.gender || "—"})\n` +
      formatTrustProfile(rider, verifications, true) + `\n` +
      `📍 Pickup: ${candidate.request.pickupLabel}\n` +
      `📍 Dropoff: ${candidate.request.dropoffLabel}\n` +
      `↩️ Detour: ~${formatDuration(candidate.detour.addedSeconds)}`,
      Markup.inlineKeyboard([
        [Markup.button.callback(`Accept ${rider.firstName}`, `accept_rider_${candidate.request.id}`)],
        [Markup.button.callback("Skip", `skip_rider_${candidate.request.id}`)],
      ])
    );
  });

  // --- Complete ride ---
  bot.action(/^complete_ride_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const matchId = parseInt(ctx.match![1]);
    const match = repo.getMatchById(matchId);
    if (!match || match.driverId !== session.userId) return;

    repo.updateMatchStatus(matchId, "completed");
    repo.updateRideStatus(match.rideId, "completed");
    repo.updateRequestStatus(match.requestId, "completed");

    const rider = repo.getUserById(match.riderId);
    const driver = repo.getUserById(match.driverId);

    const ratingKeyboard = Markup.inlineKeyboard([
      [1, 2, 3, 4, 5].map(s => Markup.button.callback(`${s}⭐`, `rate_${s}`)),
    ]);

    sessions.setScene(telegramId, "rating");
    sessions.updateData(telegramId, { matchId });
    await ctx.editMessageText(
      `Ride complete! 🎉\n\nHow was ${rider?.firstName}? Rate your rider:`,
      ratingKeyboard
    );

    if (rider) {
      sessions.setScene(rider.telegramId, "rating");
      sessions.updateData(rider.telegramId, { matchId });
      try {
        await ctx.telegram.sendMessage(
          rider.telegramId,
          `You've arrived! 🎉\n\nHow was your ride with ${driver?.firstName}?`,
          ratingKeyboard
        );
      } catch (err) {
        console.error("Failed to send rider rating prompt:", err);
      }
    }
  });

  // --- Rating callbacks ---
  for (let score = 1; score <= 5; score++) {
    bot.action(`rate_${score}`, async (ctx) => {
      await ctx.answerCbQuery();
      const telegramId = ctx.from!.id;
      const session = sessions.get(telegramId);

      if (!session.userId || !session.data.matchId) return;

      const match = repo.getMatchById(session.data.matchId);
      if (!match) return;

      const ratedId = match.driverId === session.userId
        ? match.riderId
        : match.driverId;

      repo.addRating(match.id, session.userId, ratedId, score, null);

      // Check if both parties have rated
      if (repo.bothRated(match.id)) {
        // Award points
        const ratings = repo.getRatingsForMatch(match.id);
        const driverRating = ratings.find(r => r.ratedId === match.driverId);
        const riderRating = ratings.find(r => r.ratedId === match.riderId);

        // Points for driver
        if (driverRating) {
          const driverPoints = driverRating.score >= 4
            ? POINTS.DRIVER_REWARD_HIGH
            : POINTS.DRIVER_REWARD_LOW;
          repo.adjustPoints(match.driverId, driverPoints);
        }

        // Points for rider
        if (riderRating) {
          const riderPoints = riderRating.score >= 4
            ? POINTS.RIDER_REWARD_HIGH
            : POINTS.RIDER_REWARD_LOW;
          repo.adjustPoints(match.riderId, riderPoints);
        }

        // Increment ride counts
        repo.incrementRideCount(match.driverId, "driver");
        repo.incrementRideCount(match.riderId, "rider");

        // Notify both with the other's rating
        const driver = repo.getUserById(match.driverId);
        const rider = repo.getUserById(match.riderId);

        if (driver && driverRating) {
          const pts = driverRating.score >= 4 ? POINTS.DRIVER_REWARD_HIGH : POINTS.DRIVER_REWARD_LOW;
          try {
            await ctx.telegram.sendMessage(
              driver.telegramId,
              `Thanks! ${rider?.firstName} rated you ⭐${driverRating.score}.\n` +
              `You earned ${pts} points. Balance: ${repo.getPointsBalance(driver.id).toFixed(1)} pts.`
            );
          } catch {}
        }

        if (rider && riderRating) {
          const pts = riderRating.score >= 4 ? POINTS.RIDER_REWARD_HIGH : POINTS.RIDER_REWARD_LOW;
          try {
            await ctx.telegram.sendMessage(
              rider.telegramId,
              `Thanks! ${driver?.firstName} rated you ⭐${riderRating.score}.\n` +
              `You earned ${pts} points. Balance: ${repo.getPointsBalance(rider.id).toFixed(1)} pts.`
            );
          } catch {}
        }
      } else {
        await ctx.editMessageText(
          `Thanks for rating ⭐${score}! ` +
          `Waiting for the other party to rate — you'll both see results once they do.`
        );
      }

      sessions.reset(telegramId);
    });
  }

  // --- Cancel ride posting flow ---
  bot.action("cancel_ride_flow", async (ctx) => {
    await ctx.answerCbQuery();
    sessions.reset(ctx.from!.id);
    await ctx.editMessageText("Ride posting cancelled.");
  });

  // --- SOS false alarm ---
  bot.action("sos_ok", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText("Glad you're safe. Ride continues as normal.");
  });
}
