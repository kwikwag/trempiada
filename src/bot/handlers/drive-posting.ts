import { Markup } from "telegraf";
import type { Telegraf, Context } from "telegraf";
import type { BotDeps } from "../deps";
import type { MatchCandidate } from "../../services/matching";
import { WazeService, extractWazeDriveUrl } from "../../services/waze";
import { DEFAULTS } from "../../types";
import type { Car } from "../../types";
import { formatTrustProfile, formatDuration, parseTimeToday } from "../../utils";
import { showMainMenu, rideReviewContent, replyWithRideReview, resolveLocation } from "../ui";

export function registerDrivePostingHandlers(bot: Telegraf, deps: BotDeps): void {
  const { repo, sessions, logger } = deps;

  bot.command("drive", async (ctx) => {
    logger.info("drive_command_received", { telegramId: ctx.from!.id });
    await startDrivePostingFlow(ctx, ctx.from!.id, deps);
  });

  bot.action("menu_drive", async (ctx) => {
    await ctx.answerCbQuery();
    logger.info("drive_menu_selected", { telegramId: ctx.from!.id });
    await startDrivePostingFlow(ctx, ctx.from!.id, deps);
  });

  // Driver taps "Review riders" from a notification
  bot.action("review_riders", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const activeRide = repo.getActiveRideForDriver(session.userId);
    if (!activeRide) {
      logger.info("review_riders_without_active_ride", {
        telegramId,
        userId: session.userId,
      });
      await startDrivePostingFlow(ctx, telegramId, deps);
      return;
    }

    const { matching } = deps;
    const candidates = await matching.findRidersForDriver(activeRide);
    logger.info("review_riders_requested", {
      telegramId,
      userId: session.userId,
      rideId: activeRide.id,
      candidateCount: candidates.length,
    });
    await showDriverCandidates(ctx, telegramId, activeRide.id, candidates, deps);
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

      const departure = new Date(Date.now() + minutes * 60 * 1000);
      sessions.updateData(telegramId, { departureTime: departure.toISOString() });
      sessions.setScene(telegramId, "ride_review");

      const review = rideReviewContent(telegramId, sessions);
      await ctx.editMessageText(review.text, review.keyboard);
      logger.info("ride_departure_selected", {
        telegramId,
        minutesFromNow: minutes,
        departureTime: departure.toISOString(),
      });
    });
  }

  bot.action("depart_custom", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    sessions.setScene(telegramId, "ride_departure_custom");
    logger.info("ride_departure_custom_requested", { telegramId });
    await ctx.editMessageText("When are you leaving?\n\nEnter a time like *18:00* or *6:30 PM*.", {
      parse_mode: "Markdown",
    });
  });

  // --- Post ride ---
  bot.action("post_ride", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const review = rideReviewContent(telegramId, sessions);
    await ctx.editMessageText(`${review.text}Ride posted! ✅ Searching for riders...`);
    logger.info("ride_post_requested", { telegramId });
    await postRideFromSession(ctx, telegramId, deps);
  });

  // --- Edit ride review ---
  bot.action("edit_ride", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      "What do you want to edit?",
      Markup.inlineKeyboard([
        [Markup.button.callback("Seats available", "edit_ride_seats")],
        [Markup.button.callback("Departure time", "edit_ride_departure")],
        [Markup.button.callback("Route", "edit_ride_route")],
        [Markup.button.callback("Back to review", "edit_ride_back")],
      ]),
    );
  });

  bot.action("edit_ride_seats", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    const maxSeats = session.data.carSeatCount ?? session.data.seats;

    sessions.updateData(telegramId, { editField: "seats" });
    sessions.setScene(telegramId, "ride_edit");
    await ctx.editMessageText(
      `How many seats are available? Enter a number from 1 to ${maxSeats}.`,
    );
  });

  bot.action("edit_ride_departure", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
      "When are you leaving?",
      Markup.inlineKeyboard([
        [Markup.button.callback("Now", "depart_now")],
        [Markup.button.callback("In 30 min", "depart_30")],
        [Markup.button.callback("In 1 hour", "depart_60")],
        [Markup.button.callback("Pick a time", "depart_custom")],
      ]),
    );
  });

  bot.action("edit_ride_route", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    sessions.setScene(telegramId, "ride_origin", {
      carId: session.data.carId,
      seats: session.data.seats,
      carSeatCount: session.data.carSeatCount,
      maxDetour: session.data.maxDetour,
    });
    logger.info("ride_route_edit_requested", {
      telegramId,
      userId: session.userId,
    });
    await ctx.editMessageText(
      "Send me your starting point again.\n\n📍 Drop a pin or type an address.",
    );
  });

  bot.action("edit_ride_back", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    sessions.setScene(telegramId, "ride_review");
    const review = rideReviewContent(telegramId, sessions);
    await ctx.editMessageText(review.text, review.keyboard);
  });

  // --- Cancel ride posting flow ---
  bot.action("cancel_ride_flow", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    sessions.reset(telegramId);
    logger.info("ride_posting_cancelled", { telegramId });
    await ctx.editMessageText("Ride posting cancelled.");
    const session = sessions.get(telegramId);
    if (session.userId) {
      const user = repo.getUserById(session.userId);
      if (user) await showMainMenu(ctx, user.firstName);
    }
  });
}

export async function handleDrivePostingMessage(ctx: Context, deps: BotDeps): Promise<boolean> {
  const telegramId = ctx.from!.id;
  const { sessions, routing, geocoding, logger } = deps;
  const session = sessions.get(telegramId);
  const msg = (ctx as any).message;

  // Waze URL — no scene guard, checked before other scenes
  if ("text" in msg) {
    const wazeUrl = extractWazeDriveUrl(msg.text);
    if (wazeUrl) {
      logger.info("waze_drive_detected", { telegramId });
      await createWazeDriveFromUrl(ctx, telegramId, wazeUrl, deps);
      return true;
    }
  }

  // --- Ride posting: origin ---
  if (session.scene === "ride_origin") {
    const loc = await resolveLocation(msg, geocoding);
    if (!loc) {
      if (!("location" in msg) && !("text" in msg)) {
        await ctx.reply("Send a location pin or type an address.");
      } else {
        await ctx.reply(
          "Couldn't find that address. Try a more specific address, or send a location pin.",
        );
      }
      return true;
    }

    sessions.updateData(telegramId, {
      originLat: loc.lat,
      originLng: loc.lng,
      originLabel: loc.label,
    });
    sessions.setScene(telegramId, "ride_destination");
    logger.info("ride_origin_set", {
      telegramId,
      userId: session.userId,
      source: "location" in msg ? "pin" : "text",
      labelLength: loc.label.length,
    });
    await ctx.reply("Got it. And your destination? (drop a pin or type an address)");
    return true;
  }

  // --- Ride posting: destination ---
  if (session.scene === "ride_destination") {
    if (!("location" in msg) && !("text" in msg)) return true;

    const loc = await resolveLocation(msg, geocoding);
    if (!loc) {
      await ctx.reply(
        "Couldn't find that address. Try a more specific address, or send a location pin.",
      );
      return true;
    }

    const routeResult = await routing.getRoute(
      { lat: session.data.originLat, lng: session.data.originLng },
      { lat: loc.lat, lng: loc.lng },
    );

    sessions.updateData(telegramId, {
      destLat: loc.lat,
      destLng: loc.lng,
      destLabel: loc.label,
      routeGeometry: routeResult?.geometry || null,
      estimatedDuration: routeResult?.durationSeconds || null,
    });
    sessions.setScene(telegramId, "ride_departure");
    logger.info("ride_destination_set", {
      telegramId,
      userId: session.userId,
      source: "location" in msg ? "pin" : "text",
      labelLength: loc.label.length,
      routeFound: Boolean(routeResult),
      estimatedDurationSeconds: routeResult?.durationSeconds,
    });

    await ctx.reply(
      `${session.data.originLabel} → ${loc.label}\n` +
        (routeResult ? `🕐 About ${formatDuration(routeResult.durationSeconds)}\n\n` : `\n`) +
        `When are you leaving?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Now", "depart_now")],
        [Markup.button.callback("In 30 min", "depart_30")],
        [Markup.button.callback("In 1 hour", "depart_60")],
        [Markup.button.callback("Pick a time", "depart_custom")],
      ]),
    );
    return true;
  }

  // --- Custom departure time entry ---
  if (session.scene === "ride_departure_custom" && "text" in msg) {
    const departure = parseTimeToday(msg.text.trim());
    if (!departure) {
      await ctx.reply("I couldn't read that time. Try something like *18:00* or *6:30 PM*.", {
        parse_mode: "Markdown",
      });
      return true;
    }
    sessions.updateData(telegramId, { departureTime: departure.toISOString() });
    sessions.setScene(telegramId, "ride_review");
    logger.info("ride_departure_custom_set", {
      telegramId,
      userId: session.userId,
      departureTime: departure.toISOString(),
    });
    await replyWithRideReview(ctx, telegramId, sessions);
    return true;
  }

  // --- Ride review: seat count editing ---
  if (session.scene === "ride_edit" && "text" in msg) {
    if (session.data.editField !== "seats") return false;

    const seats = Number.parseInt(msg.text.trim(), 10);
    const maxSeats = session.data.carSeatCount ?? session.data.seats;
    if (!Number.isInteger(seats) || seats < 1 || seats > maxSeats) {
      await ctx.reply(`Enter a number from 1 to ${maxSeats}.`);
      return true;
    }

    sessions.updateData(telegramId, { seats, editField: undefined });
    sessions.setScene(telegramId, "ride_review");
    logger.info("ride_seats_updated", {
      telegramId,
      userId: session.userId,
      seats,
    });
    await replyWithRideReview(ctx, telegramId, sessions);
    return true;
  }

  return false;
}

function setRideReviewFromCar(
  telegramId: number,
  car: Car,
  data: Record<string, unknown>,
  deps: BotDeps,
): void {
  const { sessions } = deps;
  sessions.setScene(telegramId, "ride_review", {
    carId: car.id,
    seats: car.seatCount,
    carSeatCount: car.seatCount,
    maxDetour: DEFAULTS.MAX_DETOUR_MINUTES,
    ...data,
  });
}

async function promptDriverVerification(
  ctx: Context,
  telegramId: number,
  data: Record<string, unknown>,
  deps: BotDeps,
): Promise<void> {
  deps.sessions.setScene(telegramId, "registration_verification", data);
  await ctx.reply(
    "Drivers need at least one identity verification to offer rides. This helps riders feel safe.\n\n" +
      "Choose a verification method:",
    Markup.inlineKeyboard([
      [Markup.button.callback("Facebook", "verify_facebook")],
      [Markup.button.callback("LinkedIn", "verify_linkedin")],
      [Markup.button.callback("Google", "verify_google")],
      [Markup.button.callback("Email", "verify_email")],
    ]),
  );
}

export async function ensureDriverReady(
  ctx: Context,
  telegramId: number,
  deps: BotDeps,
  pendingData: Record<string, unknown> = {},
): Promise<Car | null> {
  const { repo, sessions } = deps;
  const session = sessions.get(telegramId);

  if (!session.userId) {
    const existing = repo.getUserByTelegramId(telegramId);
    if (existing) {
      sessions.setUserId(telegramId, existing.id);
    } else if (pendingData.pendingWazeDriveUrl) {
      deps.logger.info("driver_flow_needs_registration", { telegramId });
      sessions.setScene(telegramId, "registration_name", pendingData);
      await ctx.reply(
        "I can set up that Waze drive for you. First, let's create your account.\n\n" +
          "What's your first name? (This is what others will see.)",
      );
      return null;
    } else {
      deps.logger.info("driver_flow_blocked_unregistered", { telegramId });
      await ctx.reply(
        "You need to register first.",
        Markup.inlineKeyboard([[Markup.button.callback("Get started 👋", "menu_start")]]),
      );
      return null;
    }
  }

  const readySession = sessions.get(telegramId);
  if (!readySession.userId) return null;

  const user = repo.getUserById(readySession.userId);
  if (!user || user.isSuspended) {
    deps.logger.warn("driver_flow_blocked_suspended", {
      telegramId,
      userId: readySession.userId,
    });
    await ctx.reply("Your account is currently suspended. Contact support for help.");
    return null;
  }

  const car = repo.getActiveCar(readySession.userId);
  if (!car) {
    deps.logger.info("driver_flow_needs_car_registration", {
      telegramId,
      userId: readySession.userId,
    });
    sessions.setScene(telegramId, "car_registration_photo", pendingData);
    await ctx.reply(
      (pendingData.pendingWazeDriveUrl ? "I saved the Waze drive. " : "") +
        "First time driving? Let's register your car.\n\n" +
        "Send me a photo of the back of your car so the license plate is visible.",
    );
    return null;
  }

  const verCount = repo.getVerificationCount(readySession.userId);
  if (verCount < DEFAULTS.MIN_TRUST_VERIFICATIONS) {
    deps.logger.info("driver_flow_needs_verification", {
      telegramId,
      userId: readySession.userId,
      verificationCount: verCount,
    });
    await promptDriverVerification(
      ctx,
      telegramId,
      {
        returnTo: pendingData.pendingWazeDriveUrl ? "waze_drive" : "ride_origin",
        ...pendingData,
      },
      deps,
    );
    return null;
  }

  return car;
}

export async function startDrivePostingFlow(
  ctx: Context,
  telegramId: number,
  deps: BotDeps,
): Promise<void> {
  const { sessions } = deps;
  const car = await ensureDriverReady(ctx, telegramId, deps);
  if (!car) return;

  sessions.setScene(telegramId, "ride_origin", {
    carId: car.id,
    seats: car.seatCount,
    carSeatCount: car.seatCount,
    maxDetour: DEFAULTS.MAX_DETOUR_MINUTES,
  });
  deps.logger.info("drive_flow_started", {
    telegramId,
    userId: sessions.get(telegramId).userId,
    carId: car.id,
    seats: car.seatCount,
  });
  await ctx.reply(
    `Where are you headed?\n\n` +
      `Send me your starting point — you can:\n` +
      `📍 Drop a pin (tap the attachment icon)\n` +
      `✍️ Type an address or place name`,
  );
}

async function showDriverCandidates(
  ctx: Context,
  telegramId: number,
  rideId: number,
  candidates: MatchCandidate[],
  deps: BotDeps,
): Promise<void> {
  const { repo, sessions, notify } = deps;
  const session = sessions.get(telegramId);
  if (!session.userId) return;

  for (const candidate of candidates) {
    const rider = repo.getUserById(candidate.request.riderId);
    if (!rider) continue;
    try {
      await notify(
        rider.telegramId,
        "🔔 A driver heading your way is reviewing your ride request! You'll get a confirmation if they accept.",
      );
    } catch {
      // Rider may not have started the bot
    }
  }

  if (candidates.length === 0) {
    deps.logger.info("driver_candidates_empty", {
      telegramId,
      userId: session.userId,
      rideId,
    });
    await ctx.reply(
      "No riders along your route right now.\n" +
        "I'll notify you when someone matches before you depart.\n\n" +
        "💡 Share your invite link to get more people on TrempiadaBot:\n" +
        `t.me/TrempiadaBot?start=ref_${session.userId}`,
    );
    sessions.reset(telegramId);
    return;
  }

  const candidate = candidates[0];
  const rider = repo.getUserById(candidate.request.riderId);
  if (!rider) {
    deps.logger.warn("driver_candidate_missing_rider", {
      telegramId,
      userId: session.userId,
      rideId,
      requestId: candidate.request.id,
      riderId: candidate.request.riderId,
    });
    sessions.reset(telegramId);
    return;
  }

  const riderVerifications = repo.getPublicVerifications(rider.id);

  await ctx.reply(
    `Found ${candidates.length} rider${candidates.length > 1 ? "s" : ""} along your route!\n\n` +
      `👤 ${rider.firstName} (${rider.gender || "—"})\n` +
      formatTrustProfile(rider, riderVerifications, true) +
      `\n` +
      `📍 Pickup: ${candidate.request.pickupLabel}\n` +
      `📍 Dropoff: ${candidate.request.dropoffLabel}\n` +
      `↩️ Detour: ~${formatDuration(candidate.detour.addedSeconds)}`,
    Markup.inlineKeyboard([
      [Markup.button.callback(`Accept ${rider.firstName}`, `accept_rider_${candidate.request.id}`)],
      [Markup.button.callback("Skip", `skip_rider_${candidate.request.id}`)],
    ]),
  );

  sessions.updateData(telegramId, { rideId, candidates, candidateIndex: 0 });
  deps.logger.info("driver_candidates_shown", {
    telegramId,
    userId: session.userId,
    rideId,
    candidateCount: candidates.length,
    firstRequestId: candidate.request.id,
    firstDetourSeconds: candidate.detour.addedSeconds,
  });
}

async function postRideFromSession(ctx: Context, telegramId: number, deps: BotDeps): Promise<void> {
  const { repo, sessions, matching, logger } = deps;
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
  logger.info("ride_posted", {
    telegramId,
    userId: session.userId,
    rideId: ride.id,
    carId: ride.carId,
    seats: ride.availableSeats,
    maxDetourMinutes: ride.maxDetourMinutes,
    departureTime: ride.departureTime,
    routeFound: Boolean(ride.routeGeometry),
    estimatedDurationSeconds: ride.estimatedDuration,
  });

  const candidates = await matching.findRidersForDriver(ride);
  await showDriverCandidates(ctx, telegramId, ride.id, candidates, deps);
}

export async function createWazeDriveFromUrl(
  ctx: Context,
  telegramId: number,
  wazeUrl: string,
  deps: BotDeps,
): Promise<boolean> {
  const { routing, sessions } = deps;
  const waze = new WazeService(undefined, deps.logger);

  const car = await ensureDriverReady(ctx, telegramId, deps, { pendingWazeDriveUrl: wazeUrl });
  if (!car) return true;

  deps.logger.info("waze_drive_import_started", { telegramId });
  await ctx.reply("Importing your Waze drive...");

  const drive = await waze.getDriveInfo(wazeUrl);
  if (!drive) {
    deps.logger.warn("waze_drive_import_failed", { telegramId });
    await ctx.reply(
      "I couldn't read that Waze drive. Make sure the link is a live Waze drive URL and try again.",
    );
    return true;
  }

  const routeResult = await routing.getRoute(
    { lat: drive.originLat, lng: drive.originLng },
    { lat: drive.destLat, lng: drive.destLng },
  );

  setRideReviewFromCar(
    telegramId,
    car,
    {
      originLat: drive.originLat,
      originLng: drive.originLng,
      originLabel: drive.originLabel,
      destLat: drive.destLat,
      destLng: drive.destLng,
      destLabel: drive.destLabel,
      routeGeometry: routeResult?.geometry || null,
      estimatedDuration: drive.etaSeconds,
      departureTime: new Date().toISOString(),
    },
    deps,
  );

  deps.logger.info("waze_drive_imported", {
    telegramId,
    userId: sessions.get(telegramId).userId,
    etaSeconds: drive.etaSeconds,
    routeFound: Boolean(routeResult),
    estimatedDurationSeconds: routeResult?.durationSeconds,
  });
  await replyWithRideReview(ctx, telegramId, sessions);
  return true;
}
