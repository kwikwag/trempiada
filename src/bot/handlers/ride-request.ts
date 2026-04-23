import { Markup } from "telegraf";
import type { Telegraf, Context } from "telegraf";
import type { BotDeps } from "../deps";
import type { RideRequest } from "../../types";
import {
  backToMenuKeyboard,
  mainMenuKeyboard,
  resolveLocation,
  statusKeyboard,
  withBackToMenuButton,
} from "../ui";
import { ensureProfileComplete } from "./profile";

const MATCHED_REQUEST_EDIT_BLOCK_MESSAGE =
  "You're already matched for a ride. If you want to change anything, cancel the ride first.";

type RequestLocationField = "pickup" | "dropoff";

const REQUEST_LOCATION_EDIT = {
  pickup: {
    scene: "request_pickup",
    prompt: "Send the new pickup point.\n\n📍 Drop a pin or type an address.",
    logMessage: "request_pickup_updated",
  },
  dropoff: {
    scene: "request_dropoff",
    prompt: "Send the new dropoff point.\n\n📍 Drop a pin or type an address.",
    logMessage: "request_dropoff_updated",
  },
} as const;

export function registerRideRequestHandlers(bot: Telegraf, deps: BotDeps): void {
  const { repo, sessions, logger } = deps;

  bot.command("ride", async (ctx) => {
    const telegramId = ctx.from!.id;
    await startRideRequestFlow({ ctx, telegramId, deps, source: "command" });
  });

  bot.action("menu_ride", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    await startRideRequestFlow({ ctx, telegramId, deps, source: "menu" });
  });

  bot.action("switch_offer_to_request", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const cancelledRide = repo.cancelOpenRideForDriver(session.userId);
    logger.info("open_ride_replaced_by_request_flow", {
      telegramId,
      userId: session.userId,
      rideId: cancelledRide?.id,
    });

    sessions.reset(telegramId);
    await ctx.editMessageText("Your ride offer is cancelled. Let's set up your ride request.");
    await startRideRequestFlow({ ctx, telegramId, deps, source: "switch" });
  });

  bot.action("edit_open_request", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const activeMatch = repo.getActiveMatchForUser(session.userId);
    if (activeMatch) {
      sessions.setScene({ telegramId, scene: "idle" });
      logger.info("open_request_edit_blocked_active_match", {
        telegramId,
        userId: session.userId,
        matchId: activeMatch.id,
      });
      await ctx.reply(MATCHED_REQUEST_EDIT_BLOCK_MESSAGE, statusKeyboard());
      return;
    }

    const openRequest = repo.getOpenRideRequestForRider(session.userId);
    if (!openRequest) {
      sessions.setScene({ telegramId, scene: "idle" });
      logger.info("open_request_edit_without_open_request", {
        telegramId,
        userId: session.userId,
      });
      await ctx.reply("No open ride request to modify.", statusKeyboard());
      return;
    }

    logger.info("open_request_edit_started", {
      telegramId,
      userId: session.userId,
      requestId: openRequest.id,
    });

    setRequestReviewFromRequest({ telegramId, request: openRequest, deps });
    await renderRequestReview(ctx, { telegramId, deps, mode: "edit" });
  });

  bot.action("edit_request_pickup", async (ctx) => {
    await ctx.answerCbQuery();
    await startRequestLocationEdit({ ctx, telegramId: ctx.from!.id, deps, field: "pickup" });
  });

  bot.action("edit_request_dropoff", async (ctx) => {
    await ctx.answerCbQuery();
    await startRequestLocationEdit({ ctx, telegramId: ctx.from!.id, deps, field: "dropoff" });
  });

  bot.action("edit_request_time", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    if (!(await ensurePostedRequestStillEditable({ ctx, telegramId, deps }))) return;

    sessions.updateData(telegramId, { requestEditField: "time" });
    sessions.setScene({ telegramId, scene: "request_time" });
    await ctx.editMessageText("When do you need a ride?", requestTimeWindowKeyboard());
  });

  bot.action("edit_request_back", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    if (!(await ensurePostedRequestStillEditable({ ctx, telegramId, deps }))) return;
    deps.sessions.setScene({ telegramId, scene: "request_review" });
    await renderRequestReview(ctx, { telegramId, deps, mode: "edit" });
  });

  bot.action("save_request_changes", async (ctx) => {
    await ctx.answerCbQuery();
    await saveRequestFromSession(ctx, { telegramId: ctx.from!.id, deps, isUpdate: true });
  });

  bot.action("cancel_request_edit", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    sessions.reset(telegramId);
    await ctx.editMessageText("No changes saved. Your current ride request is still active.");
    const session = sessions.get(telegramId);
    if (session.userId) {
      await ctx.reply("What would you like to do next?", mainMenuKeyboard());
    }
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
      if (session.scene !== "request_time") {
        await ctx.reply(
          "That ride request draft is no longer active. Use /ride to request a ride.",
        );
        return;
      }

      const activeMatch = repo.getActiveMatchForUser(session.userId);
      const openRide = repo.getOpenRideForDriver(session.userId);
      const openRequest = repo.getOpenRideRequestForRider(session.userId);
      const editingRequestId =
        typeof session.data.editingRequestId === "number" ? session.data.editingRequestId : null;

      if (editingRequestId !== null) {
        if (!(await ensurePostedRequestStillEditable({ ctx, telegramId, deps }))) return;

        const now = new Date();
        const latest = new Date(now.getTime() + windowMinutes * 60 * 1000);
        sessions.updateData(telegramId, {
          earliestDeparture: now.toISOString(),
          latestDeparture: latest.toISOString(),
          requestEditField: undefined,
        });
        sessions.setScene({ telegramId, scene: "request_review" });
        logger.info("request_time_updated", {
          telegramId,
          userId: session.userId,
          editingRequestId,
          windowMinutes,
        });
        await renderRequestReview(ctx, { telegramId, deps, mode: "edit" });
        return;
      }

      if (activeMatch || openRide || openRequest) {
        logger.info("ride_request_post_blocked_conflicting_activity", {
          telegramId,
          userId: session.userId,
          matchId: activeMatch?.id,
          rideId: openRide?.id,
          requestId: openRequest?.id,
        });
        sessions.reset(telegramId);
        await ctx.reply(
          "You already have an active ride, offer, or request. Use /status to manage it before requesting another ride.",
          statusKeyboard(),
        );
        return;
      }

      const now = new Date();
      const latest = new Date(now.getTime() + windowMinutes * 60 * 1000);
      sessions.updateData(telegramId, {
        earliestDeparture: now.toISOString(),
        latestDeparture: latest.toISOString(),
      });
      await saveRequestFromSession(ctx, { telegramId, deps, isUpdate: false });
    });
  }
}

interface RequestHandlerArgs {
  ctx: Context;
  telegramId: number;
  deps: BotDeps;
}

interface StartRequestLocationEditArgs extends RequestHandlerArgs {
  field: RequestLocationField;
}

interface SetRequestReviewFromRequestArgs {
  telegramId: number;
  request: RideRequest;
  deps: BotDeps;
}

interface StartRideRequestFlowArgs extends RequestHandlerArgs {
  source?: "command" | "menu" | "switch";
}

interface FinishRequestLocationEditArgs extends StartRequestLocationEditArgs {
  msg: any;
  labelLength: number;
}

async function startRequestLocationEdit({
  ctx,
  telegramId,
  deps,
  field,
}: StartRequestLocationEditArgs): Promise<void> {
  if (!(await ensurePostedRequestStillEditable({ ctx, telegramId, deps }))) return;
  const config = REQUEST_LOCATION_EDIT[field];
  deps.sessions.updateData(telegramId, { requestEditField: field });
  deps.sessions.setScene({ telegramId, scene: config.scene });
  await ctx.editMessageText(config.prompt, backToMenuKeyboard());
}

export function requestTimeWindowKeyboard() {
  return withBackToMenuButton([
    [Markup.button.callback("Within 30 minutes", "req_time_30")],
    [Markup.button.callback("Within 1 hour", "req_time_60")],
    [Markup.button.callback("Within 2 hours", "req_time_120")],
  ]);
}

function setRequestReviewFromRequest({
  telegramId,
  request,
  deps,
}: SetRequestReviewFromRequestArgs): void {
  deps.sessions.setScene({
    telegramId,
    scene: "request_review",
    data: {
      editingRequestId: request.id,
      pickupLat: request.pickupLat,
      pickupLng: request.pickupLng,
      pickupLabel: request.pickupLabel,
      dropoffLat: request.dropoffLat,
      dropoffLng: request.dropoffLng,
      dropoffLabel: request.dropoffLabel,
      earliestDeparture: request.earliestDeparture,
      latestDeparture: request.latestDeparture,
      originalPickupLabel: request.pickupLabel,
      originalDropoffLabel: request.dropoffLabel,
      originalEarliestDeparture: request.earliestDeparture,
      originalLatestDeparture: request.latestDeparture,
    },
  });
}

export function requestReviewContent(telegramId: number, deps: BotDeps) {
  const session = deps.sessions.get(telegramId);
  const isEditing = typeof session.data.editingRequestId === "number";

  const pickupChanged = isEditing && session.data.pickupLabel !== session.data.originalPickupLabel;
  const dropoffChanged =
    isEditing && session.data.dropoffLabel !== session.data.originalDropoffLabel;
  const timeChanged =
    isEditing &&
    (session.data.earliestDeparture !== session.data.originalEarliestDeparture ||
      session.data.latestDeparture !== session.data.originalLatestDeparture);
  const hasChanges = pickupChanged || dropoffChanged || timeChanged;

  const b = (text: string, changed: boolean) => (changed ? `*${text}*` : text);
  const timeWindow = `${formatRequestTime(session.data.earliestDeparture)}-${formatRequestTime(session.data.latestDeparture)}`;

  return {
    text:
      "Here's your ride request:\n\n" +
      b(
        `📍 ${session.data.pickupLabel} → ${session.data.dropoffLabel}`,
        pickupChanged || dropoffChanged,
      ) +
      "\n" +
      b(`🕐 Window: ${timeWindow}`, timeChanged) +
      "\n\n",
    extra: {
      parse_mode: "Markdown" as const,
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✏️ Pickup", "edit_request_pickup")],
        [Markup.button.callback("✏️ Dropoff", "edit_request_dropoff")],
        [Markup.button.callback("✏️ Time window", "edit_request_time")],
        [
          Markup.button.callback(
            isEditing ? "Save changes ✅" : "Post this request ✅",
            "save_request_changes",
          ),
          Markup.button.callback(
            isEditing ? (hasChanges ? "Discard changes" : "Keep current request") : "Cancel",
            "cancel_request_edit",
          ),
        ],
      ]),
    },
  };
}

async function renderRequestReview(
  ctx: Context,
  { telegramId, deps, mode }: { telegramId: number; deps: BotDeps; mode: "edit" | "reply" },
): Promise<void> {
  if (!(await ensurePostedRequestStillEditable({ ctx, telegramId, deps }))) return;
  const review = requestReviewContent(telegramId, deps);
  if (mode === "edit") {
    await ctx.editMessageText(review.text, review.extra);
    return;
  }
  await ctx.reply(review.text, review.extra);
}

async function ensurePostedRequestStillEditable({
  ctx,
  telegramId,
  deps,
}: RequestHandlerArgs): Promise<boolean> {
  const { repo, sessions, logger } = deps;
  const session = sessions.get(telegramId);
  if (!session.userId || typeof session.data.editingRequestId !== "number") return true;
  const editingRequestId = session.data.editingRequestId;

  const activeMatch = repo.getActiveMatchForUser(session.userId);
  if (activeMatch) {
    logger.info("open_request_edit_blocked_active_match", {
      telegramId,
      userId: session.userId,
      matchId: activeMatch.id,
      editingRequestId,
    });
    sessions.reset(telegramId);
    await ctx.reply(MATCHED_REQUEST_EDIT_BLOCK_MESSAGE, statusKeyboard());
    return false;
  }

  const openRequest = repo.getOpenRideRequestForRider(session.userId);
  if (!openRequest || openRequest.id !== editingRequestId) {
    logger.info("open_request_edit_blocked_missing_open_request", {
      telegramId,
      userId: session.userId,
      editingRequestId,
      openRequestId: openRequest?.id,
    });
    sessions.reset(telegramId);
    await ctx.reply(
      "That ride request is no longer open. Use /status to manage your current ride.",
      statusKeyboard(),
    );
    return false;
  }

  return true;
}

async function saveRequestFromSession(
  ctx: Context,
  { telegramId, deps, isUpdate }: { telegramId: number; deps: BotDeps; isUpdate: boolean },
): Promise<void> {
  const { repo, sessions, logger } = deps;
  const session = sessions.get(telegramId);
  if (!session.userId) return;

  const editingRequestId =
    typeof session.data.editingRequestId === "number" ? session.data.editingRequestId : null;
  const activeMatch = repo.getActiveMatchForUser(session.userId);
  const openRide = repo.getOpenRideForDriver(session.userId);
  const openRequest = repo.getOpenRideRequestForRider(session.userId);

  if (activeMatch) {
    logger.info("request_save_blocked_active_match", {
      telegramId,
      userId: session.userId,
      matchId: activeMatch.id,
      editingRequestId,
    });
    sessions.reset(telegramId);
    await ctx.reply(MATCHED_REQUEST_EDIT_BLOCK_MESSAGE, statusKeyboard());
    return;
  }

  if (
    isUpdate &&
    (editingRequestId === null || !openRequest || openRequest.id !== editingRequestId)
  ) {
    logger.info("request_edit_save_blocked_missing_open_request", {
      telegramId,
      userId: session.userId,
      editingRequestId,
      openRequestId: openRequest?.id,
    });
    sessions.reset(telegramId);
    await ctx.reply(
      "That ride request is no longer open. Use /status to manage your current ride.",
      statusKeyboard(),
    );
    return;
  }

  if (openRide || (!isUpdate && openRequest)) {
    logger.info("ride_request_post_blocked_conflicting_activity", {
      telegramId,
      userId: session.userId,
      rideId: openRide?.id,
      requestId: openRequest?.id,
      editingRequestId,
    });
    sessions.reset(telegramId);
    await ctx.reply(
      "You already have an active ride, offer, or request. Use /status to manage it before requesting another ride.",
      statusKeyboard(),
    );
    return;
  }

  await ctx.editMessageText(
    isUpdate ? "Request updated! ✅ Searching for drivers..." : "Searching for drivers... 🔍",
  );

  if (isUpdate) {
    const cancelledRequest = repo.cancelOpenRideRequestForRider(session.userId);
    logger.info("open_request_replaced_by_edit", {
      telegramId,
      userId: session.userId,
      requestId: cancelledRequest?.id,
      editingRequestId,
    });
  }

  const request = repo.createRideRequest({
    riderId: session.userId,
    pickupLat: session.data.pickupLat,
    pickupLng: session.data.pickupLng,
    dropoffLat: session.data.dropoffLat,
    dropoffLng: session.data.dropoffLng,
    pickupLabel: session.data.pickupLabel,
    dropoffLabel: session.data.dropoffLabel,
    earliestDeparture: session.data.earliestDeparture,
    latestDeparture: session.data.latestDeparture,
  });
  logger.info(isUpdate ? "ride_request_updated" : "ride_request_posted", {
    telegramId,
    userId: session.userId,
    requestId: request.id,
    replacedRequestId: editingRequestId,
    earliestDeparture: request.earliestDeparture,
    latestDeparture: request.latestDeparture,
  });

  const candidates = await deps.matching.findDriversForRider(request);
  sessions.reset(telegramId);
  logger.info("driver_candidates_found", {
    telegramId,
    userId: session.userId,
    requestId: request.id,
    candidateCount: candidates.length,
  });

  if (candidates.length === 0) {
    await ctx.reply(
      "No drivers on your route right now.\n\n" +
        "Your request is saved — I'll notify you when a driver posts a matching ride. 🔔",
    );
    return;
  }

  let notified = 0;
  for (const c of candidates) {
    const driver = repo.getUserById(c.ride.driverId);
    if (!driver) continue;
    try {
      await deps.notify({
        targetId: driver.telegramId,
        text:
          `🆕 New rider on your route!\n\n` +
          `📍 Pickup: ${request.pickupLabel}\n` +
          `📍 Dropoff: ${request.dropoffLabel}`,
        extra: Markup.inlineKeyboard([
          [Markup.button.callback("Review riders →", "review_riders")],
        ]) as any,
      });
      notified++;
    } catch {
      // Driver may not have started the bot
    }
  }

  await ctx.reply(
    `Your request is ${isUpdate ? "updated" : "posted"}! ✅\n\n` +
      `Found ${candidates.length} driver${candidates.length > 1 ? "s" : ""} on your route. ` +
      `${notified > 0 ? `I've notified them.` : ""}\n\n` +
      `You'll get a message here when a driver accepts.`,
  );
  logger.info("drivers_notified_for_request", {
    telegramId,
    userId: session.userId,
    requestId: request.id,
    candidateCount: candidates.length,
    notifiedCount: notified,
  });
}

function formatRequestTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IL", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export async function startRideRequestFlow({
  ctx,
  telegramId,
  deps,
  source = "command",
}: StartRideRequestFlowArgs): Promise<void> {
  const { repo, sessions, logger } = deps;
  const session = sessions.get(telegramId);

  if (!session.userId) {
    const existing = repo.getUserByTelegramId(telegramId);
    if (existing) {
      sessions.setUserId(telegramId, existing.id);
    } else {
      // Auto-create from Telegram data so the ride flow can proceed
      const telegramName = ctx.from!.first_name;
      const newUser = repo.createUser(telegramId, telegramName);
      repo.addVerification({ userId: newUser.id, type: "phone" });
      sessions.setUserId(telegramId, newUser.id);
      logger.info("user_auto_created_for_ride", { telegramId, userId: newUser.id });
    }
  }

  // Ensure gender + photo are set before proceeding (deferred profile completion)
  const profileReady = await ensureProfileComplete({
    ctx,
    telegramId,
    deps,
    pendingAction: "ride",
  });
  if (!profileReady) return;

  const { userId } = sessions.get(telegramId);
  if (!userId) return;

  const activeMatch = repo.getActiveMatchForUser(userId);
  if (activeMatch) {
    sessions.setScene({ telegramId, scene: "idle" });
    logger.info("request_flow_blocked_active_match", {
      telegramId,
      userId,
      matchId: activeMatch.id,
    });
    await ctx.reply(
      "You're already matched for a ride. Finish or cancel that ride before requesting another one.",
      statusKeyboard(),
    );
    return;
  }

  const openRide = repo.getOpenRideForDriver(userId);
  if (openRide) {
    sessions.setScene({ telegramId, scene: "idle" });
    logger.info("request_flow_blocked_open_ride", { telegramId, userId, rideId: openRide.id });
    await ctx.reply(
      "You're currently offering a ride. To request a ride as a rider, cancel that offer first.",
      Markup.inlineKeyboard([
        [Markup.button.callback("Cancel offer and request", "switch_offer_to_request")],
        [Markup.button.callback("Review riders", "review_riders")],
        [Markup.button.callback("Keep my offer", "menu_status")],
      ]),
    );
    return;
  }

  const openRequest = repo.getOpenRideRequestForRider(userId);
  if (openRequest) {
    sessions.setScene({ telegramId, scene: "idle" });
    logger.info("request_flow_blocked_open_request", {
      telegramId,
      userId,
      requestId: openRequest.id,
    });
    await ctx.reply(
      "You already have an open ride request. You can modify it, wait for a driver, or cancel it.",
      Markup.inlineKeyboard([
        [Markup.button.callback("Modify request", "edit_open_request")],
        [Markup.button.callback("Cancel request", "cancel_open_request")],
        [Markup.button.callback("Show my status", "menu_status")],
      ]),
    );
    return;
  }

  sessions.setScene({ telegramId, scene: "request_pickup", data: {} });
  logger.info("request_flow_started", { telegramId, userId, source });
  await ctx.reply(
    `Where do you need to be picked up?\n\n📍 Drop a pin or type an address.`,
    backToMenuKeyboard(),
  );
}

export async function handleRideRequestMessage(ctx: Context, deps: BotDeps): Promise<boolean> {
  const telegramId = ctx.from!.id;
  const { sessions, geocoding, logger } = deps;
  const session = sessions.get(telegramId);
  const msg = (ctx as any).message;

  // --- Ride request: pickup location ---
  if (session.scene === "request_pickup") {
    if (!(await ensurePostedRequestStillEditable({ ctx, telegramId, deps }))) return true;

    const loc = await resolveLocation(msg, geocoding);
    if (!loc) {
      if ("location" in msg || "text" in msg) {
        await ctx.reply(
          "Couldn't find that address. Try a more specific address, or send a location pin.",
          backToMenuKeyboard(),
        );
      } else {
        await ctx.reply("Send a location pin or type an address.", backToMenuKeyboard());
      }
      return true;
    }

    sessions.updateData(telegramId, {
      pickupLat: loc.lat,
      pickupLng: loc.lng,
      pickupLabel: loc.label,
    });

    if (
      await finishRequestLocationEditIfNeeded({
        ctx,
        telegramId,
        deps,
        field: "pickup",
        msg,
        labelLength: loc.label.length,
      })
    )
      return true;

    sessions.setScene({ telegramId, scene: "request_dropoff" });
    logger.info("request_pickup_set", {
      telegramId,
      userId: session.userId,
      source: "location" in msg ? "pin" : "text",
      labelLength: loc.label.length,
    });
    await ctx.reply(
      "Got it. Where do you need to be dropped off?\n\n📍 Drop a pin or type an address.",
      backToMenuKeyboard(),
    );
    return true;
  }

  // --- Ride request: dropoff location ---
  if (session.scene === "request_dropoff") {
    if (!(await ensurePostedRequestStillEditable({ ctx, telegramId, deps }))) return true;

    const loc = await resolveLocation(msg, geocoding);
    if (!loc) {
      if ("location" in msg || "text" in msg) {
        await ctx.reply(
          "Couldn't find that address. Try a more specific address, or send a location pin.",
          backToMenuKeyboard(),
        );
      } else {
        await ctx.reply("Send a location pin or type an address.", backToMenuKeyboard());
      }
      return true;
    }

    sessions.updateData(telegramId, {
      dropoffLat: loc.lat,
      dropoffLng: loc.lng,
      dropoffLabel: loc.label,
    });

    if (
      await finishRequestLocationEditIfNeeded({
        ctx,
        telegramId,
        deps,
        field: "dropoff",
        msg,
        labelLength: loc.label.length,
      })
    )
      return true;

    sessions.setScene({ telegramId, scene: "request_time" });
    logger.info("request_dropoff_set", {
      telegramId,
      userId: session.userId,
      source: "location" in msg ? "pin" : "text",
      labelLength: loc.label.length,
    });
    await ctx.reply(
      `${session.data.pickupLabel} → ${loc.label}\n\nWhen do you need a ride?`,
      requestTimeWindowKeyboard(),
    );
    return true;
  }

  return false;
}

async function finishRequestLocationEditIfNeeded({
  ctx,
  telegramId,
  deps,
  field,
  msg,
  labelLength,
}: FinishRequestLocationEditArgs): Promise<boolean> {
  const { sessions, logger } = deps;
  const session = sessions.get(telegramId);
  if (!session.data.editingRequestId || session.data.requestEditField !== field) return false;

  sessions.updateData(telegramId, { requestEditField: undefined });
  sessions.setScene({ telegramId, scene: "request_review" });
  logger.info(REQUEST_LOCATION_EDIT[field].logMessage, {
    telegramId,
    userId: session.userId,
    editingRequestId: session.data.editingRequestId,
    source: "location" in msg ? "pin" : "text",
    labelLength,
  });
  await renderRequestReview(ctx, { telegramId, deps, mode: "reply" });
  return true;
}
