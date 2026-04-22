import { Markup } from "telegraf";
import type { Telegraf, Context } from "telegraf";
import type { BotDeps } from "../deps";
import type { MatchCandidate } from "../../services/matching";
import { WazeService, extractWazeDriveUrl } from "../../services/waze";
import { DEFAULTS } from "../../types";
import type { Car, Ride } from "../../types";
import { formatTrustProfile, formatDuration, parseTimeToday } from "../../utils";
import { ensureProfileComplete } from "./profile";
import {
  showMainMenu,
  rideReviewContent,
  replyWithRideReview,
  resolveLocation,
  statusKeyboard,
} from "../ui";

const MATCHED_RIDE_EDIT_BLOCK_MESSAGE =
  "You're already matched for a ride. If you want to change anything, cancel the ride first.";

export function registerDrivePostingHandlers(bot: Telegraf, deps: BotDeps): void {
  const { repo, sessions, logger } = deps;

  bot.command("drive", async (ctx) => {
    logger.info("drive_command_received", { telegramId: ctx.from!.id });
    await startDrivePostingFlow({ ctx, telegramId: ctx.from!.id, deps });
  });

  bot.action("menu_drive", async (ctx) => {
    await ctx.answerCbQuery();
    logger.info("drive_menu_selected", { telegramId: ctx.from!.id });
    await startDrivePostingFlow({ ctx, telegramId: ctx.from!.id, deps });
  });

  bot.action("switch_request_to_drive", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const cancelledRequest = repo.cancelOpenRideRequestForRider(session.userId);
    logger.info("request_replaced_by_drive_flow", {
      telegramId,
      userId: session.userId,
      requestId: cancelledRequest?.id,
    });

    const pendingWazeDriveUrl = session.data.pendingWazeDriveUrl;
    sessions.reset(telegramId);
    await ctx.editMessageText("Your ride request is cancelled. Let's set up your ride offer.");

    if (typeof pendingWazeDriveUrl === "string") {
      await createWazeDriveFromUrl({ ctx, telegramId, wazeUrl: pendingWazeDriveUrl, deps });
      return;
    }
    await startDrivePostingFlow({ ctx, telegramId, deps });
  });

  bot.action("replace_offer_with_drive", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const cancelledRide = repo.cancelOpenRideForDriver(session.userId);
    logger.info("open_ride_replaced_by_drive_flow", {
      telegramId,
      userId: session.userId,
      rideId: cancelledRide?.id,
    });

    const pendingWazeDriveUrl = session.data.pendingWazeDriveUrl;
    sessions.reset(telegramId);
    await ctx.editMessageText("Your previous ride offer is cancelled. Let's set up the new one.");

    if (typeof pendingWazeDriveUrl === "string") {
      await createWazeDriveFromUrl({ ctx, telegramId, wazeUrl: pendingWazeDriveUrl, deps });
      return;
    }
    await startDrivePostingFlow({ ctx, telegramId, deps });
  });

  bot.action("edit_open_ride", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    await startOpenRideEditFlow({ ctx, telegramId, deps });
  });

  // Driver taps "Review riders" from a notification
  bot.action("review_riders", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const activeMatch = repo.getActiveMatchForUser(session.userId);
    if (activeMatch) {
      await ctx.reply(
        "You're already matched for a ride. Finish or cancel it before reviewing more riders.",
        statusKeyboard(),
      );
      return;
    }

    const activeRide = repo.getOpenRideForDriver(session.userId);
    if (!activeRide) {
      logger.info("review_riders_without_active_ride", {
        telegramId,
        userId: session.userId,
      });
      await startDrivePostingFlow({ ctx, telegramId, deps });
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
    await showDriverCandidates({ ctx, telegramId, rideId: activeRide.id, candidates, deps });
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
      if (!(await ensurePostedRideStillEditable({ ctx, telegramId, deps }))) return;

      const departure = new Date(Date.now() + minutes * 60 * 1000);
      sessions.updateData(telegramId, { departureTime: departure.toISOString() });
      sessions.setScene({ telegramId, scene: "ride_review" });

      const review = rideReviewContent(telegramId, sessions);
      await ctx.editMessageText(review.text, review.extra);
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
    if (!(await ensurePostedRideStillEditable({ ctx, telegramId, deps }))) return;
    sessions.setScene({ telegramId, scene: "ride_departure_custom" });
    logger.info("ride_departure_custom_requested", { telegramId });
    await ctx.editMessageText("When are you leaving?\n\nEnter a time like *18:00* or *6:30 PM*.", {
      parse_mode: "Markdown",
    });
  });

  // --- Post ride ---
  bot.action("post_ride", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (session.scene !== "ride_review") {
      await ctx.reply("That ride draft is no longer active. Use /drive to offer a ride.");
      return;
    }
    logger.info("ride_post_requested", { telegramId });
    await postRideFromSession({ ctx, telegramId, deps });
  });

  // --- Edit ride fields ---
  bot.action("edit_ride_seats", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    if (!(await ensurePostedRideStillEditable({ ctx, telegramId, deps }))) return;
    const session = sessions.get(telegramId);
    const maxSeats = session.data.carSeatCount ?? session.data.seats;

    sessions.updateData(telegramId, { editField: "seats" });
    sessions.setScene({ telegramId, scene: "ride_edit" });
    await ctx.editMessageText(
      `How many seats are available? Enter a number from 1 to ${maxSeats}.`,
    );
  });

  bot.action("edit_ride_departure", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    if (!(await ensurePostedRideStillEditable({ ctx, telegramId, deps }))) return;

    await ctx.editMessageText("When are you leaving?", rideDepartureKeyboard());
  });

  bot.action("edit_ride_origin", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    if (!(await ensurePostedRideStillEditable({ ctx, telegramId, deps }))) return;
    sessions.updateData(telegramId, { routeEditMode: "origin-only" });
    sessions.setScene({ telegramId, scene: "ride_origin" });
    logger.info("ride_origin_edit_requested", {
      telegramId,
      userId: sessions.get(telegramId).userId,
    });
    await ctx.editMessageText(
      "Send me your new starting point.\n\n📍 Drop a pin or type an address.",
    );
  });

  bot.action("edit_ride_dest", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    if (!(await ensurePostedRideStillEditable({ ctx, telegramId, deps }))) return;
    sessions.updateData(telegramId, { routeEditMode: "dest-only" });
    sessions.setScene({ telegramId, scene: "ride_destination" });
    logger.info("ride_dest_edit_requested", {
      telegramId,
      userId: sessions.get(telegramId).userId,
    });
    await ctx.editMessageText("Send me your new destination.\n\n📍 Drop a pin or type an address.");
  });

  bot.action("edit_ride_car", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    if (!(await ensurePostedRideStillEditable({ ctx, telegramId, deps }))) return;
    const session = sessions.get(telegramId);
    logger.info("ride_car_change_requested", {
      telegramId,
      userId: session.userId,
    });
    sessions.setScene({
      telegramId,
      scene: "car_registration_photo",
      data: { changingCarForRide: true, savedRideData: { ...session.data } },
    });
    await ctx.editMessageText(
      "Send me a photo of your new car — make sure the rear license plate is visible.",
    );
  });

  // --- Cancel ride posting flow ---
  bot.action("cancel_ride_flow", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const sessionBeforeReset = sessions.get(telegramId);
    const wasEditingPostedRide = typeof sessionBeforeReset.data.editingRideId === "number";
    sessions.reset(telegramId);
    logger.info("ride_posting_cancelled", { telegramId });
    await ctx.editMessageText(
      wasEditingPostedRide
        ? "No changes saved. Your current ride offer is still active."
        : "Ride posting cancelled.",
    );
    const session = sessions.get(telegramId);
    if (session.userId) {
      const user = repo.getUserById(session.userId);
      if (user) await showMainMenu(ctx, user.firstName);
    }
  });
}

function rideDepartureKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Now", "depart_now")],
    [Markup.button.callback("In 30 min", "depart_30")],
    [Markup.button.callback("In 1 hour", "depart_60")],
    [Markup.button.callback("Pick a time", "depart_custom")],
  ]);
}

interface DriveHandlerArgs {
  ctx: Context;
  telegramId: number;
  deps: BotDeps;
}

interface SetRideReviewFromRideArgs {
  telegramId: number;
  ride: Ride;
  deps: BotDeps;
}

interface PromptDriverVerificationArgs extends DriveHandlerArgs {
  data: Record<string, unknown>;
}

interface EnsureDriverReadyArgs extends DriveHandlerArgs {
  pendingData?: Record<string, unknown>;
}

interface ShowDriverCandidatesArgs extends DriveHandlerArgs {
  rideId: number;
  candidates: MatchCandidate[];
}

interface CreateWazeDriveFromUrlArgs extends DriveHandlerArgs {
  wazeUrl: string;
}

async function startOpenRideEditFlow({ ctx, telegramId, deps }: DriveHandlerArgs): Promise<void> {
  const { repo, sessions, logger } = deps;
  const session = sessions.get(telegramId);
  if (!session.userId) return;

  const activeMatch = repo.getActiveMatchForUser(session.userId);
  if (activeMatch) {
    sessions.setScene({ telegramId, scene: "idle" });
    logger.info("open_ride_edit_blocked_active_match", {
      telegramId,
      userId: session.userId,
      matchId: activeMatch.id,
    });
    await ctx.reply(MATCHED_RIDE_EDIT_BLOCK_MESSAGE, statusKeyboard());
    return;
  }

  const openRide = repo.getOpenRideForDriver(session.userId);
  if (!openRide) {
    sessions.setScene({ telegramId, scene: "idle" });
    logger.info("open_ride_edit_without_open_ride", {
      telegramId,
      userId: session.userId,
    });
    await ctx.reply("No open ride offer to modify.", statusKeyboard());
    return;
  }

  setRideReviewFromRide({ telegramId, ride: openRide, deps });
  logger.info("open_ride_edit_started", {
    telegramId,
    userId: session.userId,
    rideId: openRide.id,
  });
  const review = rideReviewContent(telegramId, deps.sessions);
  await ctx.editMessageText(review.text, review.extra);
}

async function ensurePostedRideStillEditable({
  ctx,
  telegramId,
  deps,
}: DriveHandlerArgs): Promise<boolean> {
  const { repo, sessions, logger } = deps;
  const session = sessions.get(telegramId);
  if (!session.userId || typeof session.data.editingRideId !== "number") return true;
  const editingRideId = session.data.editingRideId;

  const activeMatch = repo.getActiveMatchForUser(session.userId);
  if (activeMatch) {
    logger.info("open_ride_edit_blocked_active_match", {
      telegramId,
      userId: session.userId,
      matchId: activeMatch.id,
      editingRideId,
    });
    sessions.reset(telegramId);
    await ctx.reply(MATCHED_RIDE_EDIT_BLOCK_MESSAGE, statusKeyboard());
    return false;
  }

  const openRide = repo.getOpenRideForDriver(session.userId);
  if (!openRide || openRide.id !== editingRideId) {
    logger.info("open_ride_edit_blocked_missing_open_ride", {
      telegramId,
      userId: session.userId,
      editingRideId,
      openRideId: openRide?.id,
    });
    sessions.reset(telegramId);
    await ctx.reply(
      "That ride offer is no longer open. Use /status to manage your current ride.",
      statusKeyboard(),
    );
    return false;
  }

  return true;
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
      await createWazeDriveFromUrl({ ctx, telegramId, wazeUrl, deps });
      return true;
    }
  }

  // --- Ride posting: origin ---
  if (session.scene === "ride_origin") {
    if (!(await ensurePostedRideStillEditable({ ctx, telegramId, deps }))) return true;

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
    logger.info("ride_origin_set", {
      telegramId,
      userId: session.userId,
      source: "location" in msg ? "pin" : "text",
      labelLength: loc.label.length,
    });

    if (session.data.routeEditMode === "origin-only") {
      const routeResult = await routing.getRoute(
        { lat: loc.lat, lng: loc.lng },
        { lat: session.data.destLat, lng: session.data.destLng },
      );
      sessions.updateData(telegramId, {
        routeGeometry: routeResult?.geometry || null,
        estimatedDuration: routeResult?.durationSeconds || null,
        routeEditMode: undefined,
      });
      sessions.setScene({ telegramId, scene: "ride_review" });
      await replyWithRideReview(ctx, { telegramId, sessions });
      return true;
    }

    sessions.setScene({ telegramId, scene: "ride_destination" });
    await ctx.reply("Got it. And your destination? (drop a pin or type an address)");
    return true;
  }

  // --- Ride posting: destination ---
  if (session.scene === "ride_destination") {
    if (!(await ensurePostedRideStillEditable({ ctx, telegramId, deps }))) return true;

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
    logger.info("ride_destination_set", {
      telegramId,
      userId: session.userId,
      source: "location" in msg ? "pin" : "text",
      labelLength: loc.label.length,
      routeFound: Boolean(routeResult),
      estimatedDurationSeconds: routeResult?.durationSeconds,
    });

    if (session.data.routeEditMode === "dest-only") {
      sessions.updateData(telegramId, { routeEditMode: undefined });
      sessions.setScene({ telegramId, scene: "ride_review" });
      await replyWithRideReview(ctx, { telegramId, sessions });
      return true;
    }

    sessions.setScene({ telegramId, scene: "ride_departure" });
    await ctx.reply(
      `${session.data.originLabel} → ${loc.label}\n` +
        (routeResult ? `🕐 About ${formatDuration(routeResult.durationSeconds)}\n\n` : `\n`) +
        `When are you leaving?`,
      rideDepartureKeyboard(),
    );
    return true;
  }

  // --- Custom departure time entry ---
  if (session.scene === "ride_departure_custom" && "text" in msg) {
    if (!(await ensurePostedRideStillEditable({ ctx, telegramId, deps }))) return true;

    const departure = parseTimeToday(msg.text.trim());
    if (!departure) {
      await ctx.reply("I couldn't read that time. Try something like *18:00* or *6:30 PM*.", {
        parse_mode: "Markdown",
      });
      return true;
    }
    sessions.updateData(telegramId, { departureTime: departure.toISOString() });
    sessions.setScene({ telegramId, scene: "ride_review" });
    logger.info("ride_departure_custom_set", {
      telegramId,
      userId: session.userId,
      departureTime: departure.toISOString(),
    });
    await replyWithRideReview(ctx, { telegramId, sessions });
    return true;
  }

  // --- Ride review: seat count editing ---
  if (session.scene === "ride_edit" && "text" in msg) {
    if (!(await ensurePostedRideStillEditable({ ctx, telegramId, deps }))) return true;

    if (session.data.editField !== "seats") return false;

    const seats = Number.parseInt(msg.text.trim(), 10);
    const maxSeats = session.data.carSeatCount ?? session.data.seats;
    if (!Number.isInteger(seats) || seats < 1 || seats > maxSeats) {
      await ctx.reply(`Enter a number from 1 to ${maxSeats}.`);
      return true;
    }

    sessions.updateData(telegramId, { seats, editField: undefined });
    sessions.setScene({ telegramId, scene: "ride_review" });
    logger.info("ride_seats_updated", {
      telegramId,
      userId: session.userId,
      seats,
    });
    await replyWithRideReview(ctx, { telegramId, sessions });
    return true;
  }

  return false;
}

function setRideReviewFromCar({
  telegramId,
  car,
  data,
  deps,
}: {
  telegramId: number;
  car: Car;
  data: Record<string, unknown>;
  deps: BotDeps;
}): void {
  const { sessions } = deps;
  sessions.setScene({
    telegramId,
    scene: "ride_review",
    data: {
      carId: car.id,
      seats: car.seatCount,
      carSeatCount: car.seatCount,
      maxDetour: DEFAULTS.MAX_DETOUR_MINUTES,
      ...data,
    },
  });
}

function setRideReviewFromRide({ telegramId, ride, deps }: SetRideReviewFromRideArgs): void {
  const { repo, sessions } = deps;
  const activeCar = repo.getActiveCar(ride.driverId);
  const carSeatCount = activeCar?.id === ride.carId ? activeCar.seatCount : ride.availableSeats;

  sessions.setScene({
    telegramId,
    scene: "ride_review",
    data: {
      editingRideId: ride.id,
      carId: ride.carId,
      seats: ride.availableSeats,
      carSeatCount,
      maxDetour: ride.maxDetourMinutes,
      originLat: ride.originLat,
      originLng: ride.originLng,
      originLabel: ride.originLabel,
      destLat: ride.destLat,
      destLng: ride.destLng,
      destLabel: ride.destLabel,
      routeGeometry: ride.routeGeometry,
      estimatedDuration: ride.estimatedDuration,
      departureTime: ride.departureTime,
      originalSeats: ride.availableSeats,
      originalDepartureTime: ride.departureTime,
      originalOriginLabel: ride.originLabel,
      originalDestLabel: ride.destLabel,
    },
  });
}

async function promptDriverVerification({
  ctx,
  telegramId,
  data,
  deps,
}: PromptDriverVerificationArgs): Promise<void> {
  deps.sessions.setScene({ telegramId, scene: "registration_verification", data });
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

export async function ensureDriverReady({
  ctx,
  telegramId,
  deps,
  pendingData = {},
}: EnsureDriverReadyArgs): Promise<Car | null> {
  const { repo, sessions } = deps;
  const session = sessions.get(telegramId);

  if (!session.userId) {
    const existing = repo.getUserByTelegramId(telegramId);
    if (existing) {
      sessions.setUserId(telegramId, existing.id);
    } else {
      // Auto-create from Telegram data so the drive flow can proceed
      const telegramName = ctx.from!.first_name;
      const newUser = repo.createUser(telegramId, telegramName);
      repo.addVerification({ userId: newUser.id, type: "phone" });
      sessions.setUserId(telegramId, newUser.id);
      deps.logger.info("user_auto_created_for_drive", { telegramId, userId: newUser.id });
    }
  }

  const readySession = sessions.get(telegramId);
  if (!readySession.userId) return null;

  // Ensure gender + photo are set before proceeding (deferred profile completion)
  const profileReady = await ensureProfileComplete({
    ctx,
    telegramId,
    deps,
    pendingAction: "drive",
  });
  if (!profileReady) return null;

  const user = repo.getUserById(readySession.userId);
  if (!user || user.isSuspended) {
    deps.logger.warn("driver_flow_blocked_suspended", {
      telegramId,
      userId: readySession.userId,
    });
    await ctx.reply("Your account is currently suspended. Contact support for help.");
    return null;
  }

  const activeMatch = repo.getActiveMatchForUser(readySession.userId);
  if (activeMatch) {
    deps.sessions.setScene({ telegramId, scene: "idle" });
    deps.logger.info("driver_flow_blocked_active_match", {
      telegramId,
      userId: readySession.userId,
      matchId: activeMatch.id,
    });
    await ctx.reply(
      "You're already matched for a ride. Finish or cancel that ride before offering another one.",
      statusKeyboard(),
    );
    return null;
  }

  const openRequest = repo.getOpenRideRequestForRider(readySession.userId);
  if (openRequest) {
    deps.sessions.setScene({ telegramId, scene: "idle", data: pendingData });
    deps.logger.info("driver_flow_blocked_open_request", {
      telegramId,
      userId: readySession.userId,
      requestId: openRequest.id,
    });
    await ctx.reply(
      "You're currently requesting a ride. To offer a ride as a driver, cancel that request first.",
      Markup.inlineKeyboard([
        [Markup.button.callback("Cancel request and offer", "switch_request_to_drive")],
        [Markup.button.callback("Keep my request", "menu_status")],
      ]),
    );
    return null;
  }

  const openRide = repo.getOpenRideForDriver(readySession.userId);
  if (openRide) {
    deps.sessions.setScene({ telegramId, scene: "idle", data: pendingData });
    deps.logger.info("driver_flow_blocked_open_ride", {
      telegramId,
      userId: readySession.userId,
      rideId: openRide.id,
    });
    await ctx.reply(
      "You already have an open ride offer. You can review riders, modify it, or replace it with a new offer.",
      Markup.inlineKeyboard([
        [Markup.button.callback("Review riders", "review_riders")],
        [Markup.button.callback("Modify offer", "edit_open_ride")],
        [Markup.button.callback("Replace offer", "replace_offer_with_drive")],
        [Markup.button.callback("Keep current offer", "menu_status")],
      ]),
    );
    return null;
  }

  const car = repo.getActiveCar(readySession.userId);
  if (!car) {
    deps.logger.info("driver_flow_needs_car_registration", {
      telegramId,
      userId: readySession.userId,
    });
    sessions.setScene({ telegramId, scene: "car_registration_photo", data: pendingData });
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
    await promptDriverVerification({
      ctx,
      telegramId,
      data: {
        returnTo: pendingData.pendingWazeDriveUrl ? "waze_drive" : "ride_origin",
        ...pendingData,
      },
      deps,
    });
    return null;
  }

  return car;
}

export async function startDrivePostingFlow({
  ctx,
  telegramId,
  deps,
}: DriveHandlerArgs): Promise<void> {
  const { sessions } = deps;
  const car = await ensureDriverReady({ ctx, telegramId, deps });
  if (!car) return;

  sessions.setScene({
    telegramId,
    scene: "ride_origin",
    data: {
      carId: car.id,
      seats: car.seatCount,
      carSeatCount: car.seatCount,
      maxDetour: DEFAULTS.MAX_DETOUR_MINUTES,
    },
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

async function showDriverCandidates({
  ctx,
  telegramId,
  rideId,
  candidates,
  deps,
}: ShowDriverCandidatesArgs): Promise<void> {
  const { repo, sessions, notify } = deps;
  const session = sessions.get(telegramId);
  if (!session.userId) return;

  for (const candidate of candidates) {
    const rider = repo.getUserById(candidate.request.riderId);
    if (!rider) continue;
    try {
      await notify({
        targetId: rider.telegramId,
        text: "🔔 A driver heading your way is reviewing your ride request! You'll get a confirmation if they accept.",
      });
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
      formatTrustProfile({ user: rider, verifications: riderVerifications, forPublic: true }) +
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

async function postRideFromSession({ ctx, telegramId, deps }: DriveHandlerArgs): Promise<void> {
  const { repo, sessions, matching, logger } = deps;
  const session = sessions.get(telegramId);
  if (!session.userId) return;
  const editingRideId =
    typeof session.data.editingRideId === "number" ? session.data.editingRideId : null;

  const activeMatch = repo.getActiveMatchForUser(session.userId);
  const openRequest = repo.getOpenRideRequestForRider(session.userId);
  const openRide = repo.getOpenRideForDriver(session.userId);
  if (activeMatch) {
    logger.info("ride_edit_save_blocked_active_match", {
      telegramId,
      userId: session.userId,
      matchId: activeMatch.id,
      editingRideId,
    });
    await ctx.reply(MATCHED_RIDE_EDIT_BLOCK_MESSAGE, statusKeyboard());
    sessions.reset(telegramId);
    return;
  }

  if (editingRideId !== null && (!openRide || openRide.id !== editingRideId)) {
    logger.info("ride_edit_save_blocked_missing_open_ride", {
      telegramId,
      userId: session.userId,
      editingRideId,
      openRideId: openRide?.id,
    });
    await ctx.reply(
      "That ride offer is no longer open. Use /status to manage your current ride.",
      statusKeyboard(),
    );
    sessions.reset(telegramId);
    return;
  }

  if (openRequest || (openRide && editingRideId === null)) {
    logger.info("ride_post_blocked_conflicting_activity", {
      telegramId,
      userId: session.userId,
      requestId: openRequest?.id,
      rideId: openRide?.id,
      editingRideId,
    });
    await ctx.reply(
      "You already have an active ride, offer, or request. Use /status to manage it before posting another ride.",
      statusKeyboard(),
    );
    sessions.reset(telegramId);
    return;
  }

  const review = rideReviewContent(telegramId, sessions);
  await ctx.editMessageText(
    `${review.text}${editingRideId === null ? "Ride posted" : "Ride updated"}! ✅ Searching for riders...`,
  );

  const d = session.data;
  if (editingRideId !== null) {
    const cancelledRide = repo.cancelOpenRideForDriver(session.userId);
    logger.info("open_ride_replaced_by_edit", {
      telegramId,
      userId: session.userId,
      rideId: cancelledRide?.id,
      editingRideId,
    });
  }

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
    replacedRideId: editingRideId,
    carId: ride.carId,
    seats: ride.availableSeats,
    maxDetourMinutes: ride.maxDetourMinutes,
    departureTime: ride.departureTime,
    routeFound: Boolean(ride.routeGeometry),
    estimatedDurationSeconds: ride.estimatedDuration,
  });

  const candidates = await matching.findRidersForDriver(ride);
  await showDriverCandidates({ ctx, telegramId, rideId: ride.id, candidates, deps });
}

export async function createWazeDriveFromUrl({
  ctx,
  telegramId,
  wazeUrl,
  deps,
}: CreateWazeDriveFromUrlArgs): Promise<boolean> {
  const { routing, sessions } = deps;
  const waze = new WazeService({ logger: deps.logger });

  const car = await ensureDriverReady({
    ctx,
    telegramId,
    deps,
    pendingData: { pendingWazeDriveUrl: wazeUrl },
  });
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

  setRideReviewFromCar({
    telegramId,
    car,
    data: {
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
  });

  deps.logger.info("waze_drive_imported", {
    telegramId,
    userId: sessions.get(telegramId).userId,
    etaSeconds: drive.etaSeconds,
    routeFound: Boolean(routeResult),
    estimatedDurationSeconds: routeResult?.durationSeconds,
  });
  await replyWithRideReview(ctx, { telegramId, sessions });
  return true;
}
