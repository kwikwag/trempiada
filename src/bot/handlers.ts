import { Telegraf, Markup } from "telegraf";
import type { Context } from "telegraf";
import type { Repository } from "../db/repository";
import type { SessionManager } from "./session";
import type { MatchingService, MatchCandidate } from "../services/matching";
import type { RoutingService } from "../services/routing";
import type { CarRecognitionService } from "../services/car-recognition";
import type { GeocodingService } from "../services/geocoding";
import { WazeService, extractWazeDriveUrl } from "../services/waze";
import { DEFAULTS, POINTS } from "../types";
import type { Car, VerificationType } from "../types";
import {
  formatTrustProfile,
  formatCarInfo,
  formatRideSummary,
  formatDuration,
  generateCode,
  parseTimeToday,
} from "../utils";
import { DevService, registerDevHandlers } from "./dev";

export interface HandlerOptions {
  whitelist?: Set<number>;
  dev?: DevService;
  devIds?: Set<number>;
  altCount?: number;
}

export function registerHandlers(
  bot: Telegraf,
  repo: Repository,
  sessions: SessionManager,
  matching: MatchingService,
  routing: RoutingService,
  carRecognition: CarRecognitionService,
  geocoding: GeocodingService,
  options: HandlerOptions = {},
) {
  const { whitelist, dev, devIds, altCount = 2 } = options;

  // ---- Whitelist middleware ----
  // Silently drop updates from non-whitelisted users (no reply, to avoid revealing the bot).
  if (whitelist && whitelist.size > 0) {
    bot.use((ctx, next) => {
      if (!whitelist.has(ctx.from?.id ?? 0)) return;
      return next();
    });
  }

  // ---- Dev: impersonation middleware ----
  // Stashes the real Telegram ID, then replaces ctx.from.id with the active alt ID so that
  // all downstream handlers (sessions, DB lookups) transparently see the alt identity.
  if (dev) {
    bot.use((ctx, next) => {
      if (ctx.from) {
        const realId = ctx.from.id;
        (ctx as any).__realTelegramId = realId;
        const effectiveId = dev.getEffectiveId(realId);
        if (effectiveId !== realId) {
          dev.registerChat(effectiveId, realId);
          (ctx.from as any).id = effectiveId;
        }
      }
      return next();
    });

    registerDevHandlers(bot, dev, devIds ?? new Set(), sessions, altCount);
  }
  const waze = new WazeService();

  // Persistent reply keyboard shown during active matches. Removed when ride ends.
  const SOS_KEYBOARD = Markup.keyboard([["🚨 SOS"]]).resize();
  const REMOVE_KEYBOARD = Markup.removeKeyboard();

  // ---- Notification helper ----
  // Use this instead of bot.telegram.sendMessage whenever the target may be an alt user.
  // In dev mode, routes the message to the real chat with a persona prefix.
  async function notify(targetId: number, text: string, extra?: object): Promise<void> {
    const chatId = dev ? dev.resolveChat(targetId) : targetId;
    const prefix = dev ? dev.labelFor(targetId) : "";
    await bot.telegram.sendMessage(chatId, prefix + text, extra as any);
  }

  // ---- Shared UI helpers ----

  function mainMenuKeyboard() {
    return Markup.inlineKeyboard([
      [
        Markup.button.callback("🚗 Offer a ride", "menu_drive"),
        Markup.button.callback("🛑 Request a ride", "menu_ride"),
      ],
      [
        Markup.button.callback("👤 Trust profile", "menu_trust"),
        Markup.button.callback("📊 My status", "menu_status"),
      ],
    ]);
  }

  async function showMainMenu(ctx: Context, name: string): Promise<void> {
    await ctx.reply(`What would you like to do, ${name}?`, mainMenuKeyboard());
  }

  async function renderTrustProfile(ctx: Context, userId: number): Promise<void> {
    const user = repo.getUserById(userId)!;
    const verifications = repo.getVerifications(userId);
    const profile = formatTrustProfile(user, verifications, false);
    const verifiedTypes = new Set(verifications.map((v) => v.type));
    const buttons = [];

    if (!verifiedTypes.has("facebook"))
      buttons.push([Markup.button.callback("Connect Facebook", "verify_facebook")]);
    if (!verifiedTypes.has("linkedin"))
      buttons.push([Markup.button.callback("Connect LinkedIn", "verify_linkedin")]);
    if (!verifiedTypes.has("google"))
      buttons.push([Markup.button.callback("Connect Google", "verify_google")]);
    if (!verifiedTypes.has("email"))
      buttons.push([Markup.button.callback("Add email", "verify_email")]);

    for (const v of verifications) {
      if (["facebook", "linkedin", "google", "email"].includes(v.type)) {
        const icon = v.sharedWithRiders ? "👁" : "🙈";
        buttons.push([
          Markup.button.callback(
            `${icon} ${v.type} — ${v.sharedWithRiders ? "visible to riders" : "hidden"}`,
            `toggle_vis_${v.type}`,
          ),
        ]);
      }
    }

    await ctx.reply(
      `Your trust profile:\n\n${profile}\n\n` +
        (buttons.length > 0 ? `Manage your verifications:` : `All verifications complete! ✅`),
      buttons.length > 0 ? Markup.inlineKeyboard(buttons) : undefined,
    );
  }

  async function handleSos(ctx: Context, userId: number): Promise<void> {
    const activeMatch = repo.getActiveMatchForUser(userId);
    await ctx.reply(
      `📍 Your ride details have been saved.\n\n` +
        `🚨 Emergency: call 100 (Israel Police)\n` +
        `🚑 Ambulance: 101\n\n` +
        `If you need to share your situation with someone you trust, ` +
        `send them this chat right now.`,
      Markup.inlineKeyboard([[Markup.button.callback("I'm OK, false alarm", "sos_ok")]]),
    );
    if (activeMatch) {
      console.warn(
        `SOS triggered: match=${activeMatch.id}, user=${userId}, time=${new Date().toISOString()}`,
      );
      // TODO(privacy/legal): persist SOS events to a dedicated `sos_events` table
    }
  }

  function rideReviewContent(telegramId: number) {
    const session = sessions.get(telegramId);
    const summary = formatRideSummary(
      session.data.originLabel,
      session.data.destLabel,
      session.data.estimatedDuration,
      session.data.departureTime,
      session.data.seats,
      session.data.maxDetour,
    );

    return {
      text: `Here's your ride:\n\n${summary}\n\n`,
      keyboard: Markup.inlineKeyboard([
        [Markup.button.callback("Post this ride ✅", "post_ride")],
        [Markup.button.callback("Edit something ✏️", "edit_ride")],
        [Markup.button.callback("Cancel", "cancel_ride_flow")],
      ]),
    };
  }

  async function replyWithRideReview(ctx: Context, telegramId: number): Promise<void> {
    const review = rideReviewContent(telegramId);
    await ctx.reply(review.text, review.keyboard);
  }

  function setRideReviewFromCar(telegramId: number, car: Car, data: Record<string, unknown>): void {
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
  ): Promise<void> {
    sessions.setScene(telegramId, "registration_verification", data);
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

  async function ensureDriverReady(
    ctx: Context,
    telegramId: number,
    pendingData: Record<string, unknown> = {},
  ): Promise<Car | null> {
    const session = sessions.get(telegramId);

    if (!session.userId) {
      const existing = repo.getUserByTelegramId(telegramId);
      if (existing) {
        sessions.setUserId(telegramId, existing.id);
      } else if (pendingData.pendingWazeDriveUrl) {
        sessions.setScene(telegramId, "registration_name", pendingData);
        await ctx.reply(
          "I can set up that Waze drive for you. First, let's create your account.\n\n" +
            "What's your first name? (This is what others will see.)",
        );
        return null;
      } else {
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
      await ctx.reply("Your account is currently suspended. Contact support for help.");
      return null;
    }

    const car = repo.getActiveCar(readySession.userId);
    if (!car) {
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
      await promptDriverVerification(ctx, telegramId, {
        returnTo: pendingData.pendingWazeDriveUrl ? "waze_drive" : "ride_origin",
        ...pendingData,
      });
      return null;
    }

    return car;
  }

  async function startDrivePostingFlow(ctx: Context, telegramId: number): Promise<void> {
    const car = await ensureDriverReady(ctx, telegramId);
    if (!car) return;

    sessions.setScene(telegramId, "ride_origin", {
      carId: car.id,
      seats: car.seatCount,
      carSeatCount: car.seatCount,
      maxDetour: DEFAULTS.MAX_DETOUR_MINUTES,
    });
    await ctx.reply(
      `Where are you headed?\n\n` +
        `Send me your starting point — you can:\n` +
        `📍 Drop a pin (tap the attachment icon)\n` +
        `✍️ Type an address or place name`,
    );
  }

  async function prepareWazeDriveReview(
    ctx: Context,
    telegramId: number,
    wazeUrl: string,
  ): Promise<boolean> {
    const car = await ensureDriverReady(ctx, telegramId, { pendingWazeDriveUrl: wazeUrl });
    if (!car) return true;

    await ctx.reply("Importing your Waze drive...");

    const drive = await waze.getDriveInfo(wazeUrl);
    if (!drive) {
      await ctx.reply(
        "I couldn't read that Waze drive. Make sure the link is a live Waze drive URL and try again.",
      );
      return true;
    }

    const routeResult = await routing.getRoute(
      { lat: drive.originLat, lng: drive.originLng },
      { lat: drive.destLat, lng: drive.destLng },
    );

    setRideReviewFromCar(telegramId, car, {
      originLat: drive.originLat,
      originLng: drive.originLng,
      originLabel: drive.originLabel,
      destLat: drive.destLat,
      destLng: drive.destLng,
      destLabel: drive.destLabel,
      routeGeometry: routeResult?.geometry || null,
      estimatedDuration: drive.etaSeconds,
      departureTime: new Date().toISOString(),
    });

    await replyWithRideReview(ctx, telegramId);
    return true;
  }

  async function showDriverCandidates(
    ctx: Context,
    telegramId: number,
    rideId: number,
    candidates: MatchCandidate[],
  ): Promise<void> {
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
        [
          Markup.button.callback(
            `Accept ${rider.firstName}`,
            `accept_rider_${candidate.request.id}`,
          ),
        ],
        [Markup.button.callback("Skip", `skip_rider_${candidate.request.id}`)],
      ]),
    );

    sessions.updateData(telegramId, { rideId, candidates, candidateIndex: 0 });
  }

  async function postRideFromSession(ctx: Context, telegramId: number): Promise<void> {
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

    const candidates = await matching.findRidersForDriver(ride);
    await showDriverCandidates(ctx, telegramId, ride.id, candidates);
  }

  async function createWazeDriveFromUrl(
    ctx: Context,
    telegramId: number,
    wazeUrl: string,
  ): Promise<boolean> {
    return prepareWazeDriveReview(ctx, telegramId, wazeUrl);
  }

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

  // ============================================================
  // /start — Entry point, begin registration or show main menu
  // ============================================================
  bot.start(async (ctx) => {
    const telegramId = ctx.from!.id;
    const existing = repo.getUserByTelegramId(telegramId);

    if (existing) {
      sessions.setUserId(telegramId, existing.id);
      sessions.setScene(telegramId, "idle");
      await ctx.reply(`Welcome back, ${existing.firstName}! 👋`);
      await showMainMenu(ctx, existing.firstName);
      return;
    }

    sessions.setScene(telegramId, "registration_name", {});
    await ctx.reply(
      `Hey! 👋 Welcome to TrempiadaBot.\n\n` +
        `We connect drivers with people looking for a ride along their route.\n\n` +
        `Let's get you set up — it takes about 30 seconds.\n\n` +
        `What's your first name? (This is what others will see.)`,
    );
  });

  // ============================================================
  // /drive — Offer a ride (slash command alias)
  // ============================================================
  bot.command("drive", async (ctx) => {
    await startDrivePostingFlow(ctx, ctx.from!.id);
  });

  // ============================================================
  // /ride — Request a ride (slash command alias)
  // ============================================================
  bot.command("ride", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) {
      await ctx.reply("You need to register first.", mainMenuKeyboard());
      return;
    }

    sessions.setScene(telegramId, "request_pickup", {});
    await ctx.reply(`Where do you need to be picked up?\n\n📍 Drop a pin or type an address.`);
  });

  // ============================================================
  // /cancel — Cancel any active ride or match
  // ============================================================
  bot.command("cancel", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const activeMatch = repo.getActiveMatchForUser(session.userId);
    if (!activeMatch) {
      sessions.reset(telegramId);
      await ctx.reply("Nothing to cancel. You're all clear.", mainMenuKeyboard());
      return;
    }

    sessions.setScene(telegramId, "cancel_reason", { matchId: activeMatch.id });
    await ctx.reply(
      `Cancelling your ride. What happened?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Changed plans", "cancel_changed_plans")],
        [Markup.button.callback("Other party didn't show", "cancel_no_show")],
        [Markup.button.callback("Felt unsafe", "cancel_felt_unsafe")],
        [Markup.button.callback("Other reason", "cancel_other")],
      ]),
    );
  });

  // ============================================================
  // /trust — View and manage trust verifications
  // ============================================================
  bot.command("trust", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) {
      await ctx.reply("Register first.", mainMenuKeyboard());
      return;
    }

    await renderTrustProfile(ctx, session.userId);
  });

  // ============================================================
  // /sos — Emergency during ride
  // ============================================================
  bot.command("sos", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;
    await handleSos(ctx, session.userId);
  });

  // ============================================================
  // /status — Points balance and active ride
  // ============================================================
  bot.command("status", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) {
      await ctx.reply("Register first.", mainMenuKeyboard());
      return;
    }

    await showStatus(ctx, telegramId, session.userId);
  });

  async function showStatus(ctx: Context, _telegramId: number, userId: number): Promise<void> {
    const user = repo.getUserById(userId)!;
    const activeMatch = repo.getActiveMatchForUser(userId);

    let statusText = `💰 Points: ${user.pointsBalance.toFixed(1)}\n`;

    if (activeMatch) {
      statusText += `\n🚗 Active ride (${activeMatch.status})\nMatch #${activeMatch.id}`;
      await ctx.reply(
        statusText,
        Markup.inlineKeyboard([
          [Markup.button.callback("🚨 SOS", "sos_button")],
          [Markup.button.callback("Cancel ride", "cancel_from_status")],
        ]),
      );
    } else {
      statusText += `\nNo active ride right now.`;
      await ctx.reply(statusText, mainMenuKeyboard());
    }
  }

  // ============================================================
  // /delete — Account deletion
  // ============================================================
  bot.command("delete", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) {
      await ctx.reply("You don't have a registered account.");
      return;
    }

    const activeMatch = repo.getActiveMatchForUser(session.userId);
    if (activeMatch) {
      await ctx.reply(
        "You have an active ride. Please cancel it before deleting your account.",
        Markup.inlineKeyboard([[Markup.button.callback("Cancel ride", "cancel_from_status")]]),
      );
      return;
    }

    await ctx.reply(
      "⚠️ Delete your account?\n\n" +
        "This will permanently remove your name, photo, phone number, verifications, " +
        "and car details.\n\n" +
        "Anonymised ride history is kept for legal and dispute-resolution purposes, " +
        "as permitted under Israeli Privacy Protection Law.\n\n" +
        "This cannot be undone.",
      Markup.inlineKeyboard([
        [Markup.button.callback("Yes, delete my account", "delete_confirm")],
        [Markup.button.callback("Cancel", "delete_cancel")],
      ]),
    );
  });

  // ============================================================
  // Main menu callback handlers
  // ============================================================

  bot.action("menu_drive", async (ctx) => {
    await ctx.answerCbQuery();
    await startDrivePostingFlow(ctx, ctx.from!.id);
  });

  bot.action("menu_ride", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) {
      await ctx.reply("You need to register first.");
      return;
    }

    sessions.setScene(telegramId, "request_pickup", {});
    await ctx.reply(`Where do you need to be picked up?\n\n📍 Drop a pin or type an address.`);
  });

  bot.action("menu_trust", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;
    await renderTrustProfile(ctx, session.userId);
  });

  bot.action("menu_status", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;
    await showStatus(ctx, telegramId, session.userId);
  });

  bot.action("menu_start", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    sessions.setScene(telegramId, "registration_name", {});
    await ctx.reply("What's your first name? (This is what others will see.)");
  });

  // Driver sees "Review riders" button in a notification and taps it
  bot.action("review_riders", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const activeRide = repo.getActiveRideForDriver(session.userId);
    if (!activeRide) {
      await startDrivePostingFlow(ctx, telegramId);
      return;
    }

    const candidates = await matching.findRidersForDriver(activeRide);
    await showDriverCandidates(ctx, telegramId, activeRide.id, candidates);
  });

  // SOS via inline button (from /status or similar)
  bot.action("sos_button", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;
    await handleSos(ctx, session.userId);
  });

  // Cancel shortcut from status screen
  bot.action("cancel_from_status", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const activeMatch = repo.getActiveMatchForUser(session.userId);
    if (!activeMatch) {
      await ctx.editMessageText("Nothing to cancel. You're all clear.");
      return;
    }

    sessions.setScene(telegramId, "cancel_reason", { matchId: activeMatch.id });
    await ctx.reply(
      `Cancelling your ride. What happened?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Changed plans", "cancel_changed_plans")],
        [Markup.button.callback("Other party didn't show", "cancel_no_show")],
        [Markup.button.callback("Felt unsafe", "cancel_felt_unsafe")],
        [Markup.button.callback("Other reason", "cancel_other")],
      ]),
    );
  });

  // ============================================================
  // Callback query handlers
  // ============================================================

  bot.action("delete_confirm", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const activeMatch = repo.getActiveMatchForUser(session.userId);
    if (activeMatch) {
      await ctx.editMessageText("You have an active ride. Please cancel it first.");
      return;
    }

    repo.anonymizeUser(session.userId);
    sessions.reset(telegramId);

    await ctx.editMessageText(
      "Your account has been deleted. Your personal data has been removed.\n\n" +
        "Thank you for using TrempiadaBot.",
    );
  });

  bot.action("delete_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText("Account deletion cancelled. You're still with us! 👋");
  });

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

      const otherUserId = match.driverId === session.userId ? match.riderId : match.driverId;
      const otherUser = repo.getUserById(otherUserId);

      let cancelMsg = `Ride cancelled.`;
      if (reason === "no_show") {
        repo.adjustPoints(session.userId, POINTS.NO_SHOW_COMPENSATION);
        cancelMsg = `Ride cancelled (no-show). You've been awarded ${POINTS.NO_SHOW_COMPENSATION} point for your time.`;
      } else if (reason === "felt_unsafe") {
        cancelMsg = `Ride cancelled. This has been logged for review. No penalty applied to you.`;
      }

      // Remove SOS keyboard and show cancellation message
      await ctx.reply(cancelMsg, REMOVE_KEYBOARD);
      sessions.reset(telegramId);

      const user = repo.getUserById(session.userId);
      if (user) await showMainMenu(ctx, user.firstName);

      if (otherUser) {
        try {
          await notify(
            otherUser.telegramId,
            `⚠️ Your ride has been cancelled by the other party.\n` +
              (reason === "no_show"
                ? `Reason: they reported you didn't show up.\nIf this was a mistake, contact support.`
                : ``),
            { reply_markup: { remove_keyboard: true } },
          );
          await notify(
            otherUser.telegramId,
            `What would you like to do next?`,
            mainMenuKeyboard() as any,
          );
        } catch (err) {
          console.error("Failed to notify other party:", err);
        }
      }
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
    const v = verifications.find((v) => v.type === type);
    if (!v) return;

    repo.setVerificationVisibility(session.userId, type, !v.sharedWithRiders);
    const newState = !v.sharedWithRiders ? "visible to riders" : "hidden from riders";

    await ctx.answerCbQuery(`${type} is now ${newState}`);
    // Re-render the full trust profile as a new message
    await renderTrustProfile(ctx, session.userId);
  });

  // ============================================================
  // Message handler — routes non-command messages based on scene
  // ============================================================
  bot.on("message", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    // --- SOS reply keyboard tap ---
    if ("text" in ctx.message && ctx.message.text === "🚨 SOS") {
      if (session.userId) await handleSos(ctx, session.userId);
      return;
    }

    // --- Message relay during active ride ---
    if (session.scene === "in_ride_relay" && session.userId) {
      const match = repo.getActiveMatchForUser(session.userId);
      if (match) {
        const otherUserId = match.driverId === session.userId ? match.riderId : match.driverId;
        const otherUser = repo.getUserById(otherUserId);
        const thisUser = repo.getUserById(session.userId);

        if (otherUser && thisUser && "text" in ctx.message) {
          try {
            await notify(otherUser.telegramId, `💬 ${thisUser.firstName}: ${ctx.message.text}`);
          } catch {
            await ctx.reply(
              "Couldn't relay your message. The other party may have blocked the bot.",
            );
          }
          return;
        }
      }
    }

    if ("text" in ctx.message) {
      const wazeUrl = extractWazeDriveUrl(ctx.message.text);
      if (wazeUrl) {
        await createWazeDriveFromUrl(ctx, telegramId, wazeUrl);
        return;
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
        ]),
      );
      return;
    }

    // --- Registration: photo (fallback if no Telegram profile photo) ---
    if (session.scene === "registration_photo" && "photo" in ctx.message) {
      const photos = ctx.message.photo;
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

      await finishRegistration(ctx, telegramId);
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
            "with the license plate visible.",
        );
        return;
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
            "Couldn't find that address. Try a more specific address, or send a location pin.",
          );
          return;
        }
        ({ lat, lng, label } = result);
      } else {
        await ctx.reply("Send a location pin or type an address.");
        return;
      }

      sessions.updateData(telegramId, { originLat: lat, originLng: lng, originLabel: label });
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
            "Couldn't find that address. Try a more specific address, or send a location pin.",
          );
          return;
        }
        ({ lat, lng, label } = result);
      } else {
        return;
      }

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
          (routeResult ? `🕐 About ${formatDuration(routeResult.durationSeconds)}\n\n` : `\n`) +
          `When are you leaving?`,
        Markup.inlineKeyboard([
          [Markup.button.callback("Now", "depart_now")],
          [Markup.button.callback("In 30 min", "depart_30")],
          [Markup.button.callback("In 1 hour", "depart_60")],
          [Markup.button.callback("Pick a time", "depart_custom")],
        ]),
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
            ]),
          );

          if (rider) {
            try {
              await notify(
                rider.telegramId,
                "Ride started! ✅ Enjoy the ride.\n\nYou can send messages to your driver here.",
              );
            } catch (err) {
              console.error("Failed to notify rider:", err);
            }
          }
          return;
        }

        const attempts = (session.data.codeAttempts || 0) + 1;
        sessions.updateData(telegramId, { codeAttempts: attempts });

        if (attempts >= DEFAULTS.CONFIRMATION_MAX_ATTEMPTS) {
          await ctx.reply(
            "Too many incorrect attempts. Please confirm with your rider that you've found the right person.",
          );
          return;
        }

        await ctx.reply(
          `That code doesn't match. Double-check with your rider.\n` +
            `(${DEFAULTS.CONFIRMATION_MAX_ATTEMPTS - attempts} attempts remaining)`,
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
          await ctx.reply(
            "Couldn't find that address. Try a more specific address, or send a location pin.",
          );
          return;
        }
        ({ lat, lng, label } = result);
      } else {
        await ctx.reply("Send a location pin or type an address.");
        return;
      }

      sessions.updateData(telegramId, { pickupLat: lat, pickupLng: lng, pickupLabel: label });
      sessions.setScene(telegramId, "request_dropoff");
      await ctx.reply(
        "Got it. Where do you need to be dropped off?\n\n📍 Drop a pin or type an address.",
      );
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
          await ctx.reply(
            "Couldn't find that address. Try a more specific address, or send a location pin.",
          );
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
        ]),
      );
      return;
    }

    // --- Custom departure time entry ---
    if (session.scene === "ride_departure_custom" && "text" in ctx.message) {
      const departure = parseTimeToday(ctx.message.text.trim());
      if (!departure) {
        await ctx.reply("I couldn't read that time. Try something like *18:00* or *6:30 PM*.", {
          parse_mode: "Markdown",
        });
        return;
      }
      sessions.updateData(telegramId, { departureTime: departure.toISOString() });
      sessions.setScene(telegramId, "ride_review");
      await replyWithRideReview(ctx, telegramId);
      return;
    }

    // --- Car field editing ---
    if (session.scene === "car_edit" && "text" in ctx.message) {
      const field = session.data.carEditField as string;
      const carDetails = { ...session.data.carDetails };
      const text = ctx.message.text.trim();

      if (field === "plate") {
        carDetails.plateNumber = text;
      } else if (field === "seats") {
        const seats = parseInt(text, 10);
        if (isNaN(seats) || seats < 1 || seats > 8) {
          await ctx.reply("Please enter a number between 1 and 8.");
          return;
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
          return;
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
      return;
    }

    // --- Ride review: seat count editing ---
    if (session.scene === "ride_edit" && "text" in ctx.message) {
      if (session.data.editField !== "seats") return;

      const seats = Number.parseInt(ctx.message.text.trim(), 10);
      const maxSeats = session.data.carSeatCount ?? session.data.seats;
      if (!Number.isInteger(seats) || seats < 1 || seats > maxSeats) {
        await ctx.reply(`Enter a number from 1 to ${maxSeats}.`);
        return;
      }

      sessions.updateData(telegramId, { seats, editField: undefined });
      sessions.setScene(telegramId, "ride_review");
      await replyWithRideReview(ctx, telegramId);
      return;
    }
  });

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

      const review = rideReviewContent(telegramId);
      await ctx.editMessageText(review.text, review.keyboard);
    });
  }

  bot.action("depart_custom", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    sessions.setScene(telegramId, "ride_departure_custom");
    await ctx.editMessageText("When are you leaving?\n\nEnter a time like *18:00* or *6:30 PM*.", {
      parse_mode: "Markdown",
    });
  });

  // --- Post ride ---
  bot.action("post_ride", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const review = rideReviewContent(telegramId);
    await ctx.editMessageText(`${review.text}Ride posted! ✅ Searching for riders...`);
    await postRideFromSession(ctx, telegramId);
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
    await ctx.editMessageText(
      "Send me your starting point again.\n\n📍 Drop a pin or type an address.",
    );
  });

  bot.action("edit_ride_back", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    sessions.setScene(telegramId, "ride_review");
    const review = rideReviewContent(telegramId);
    await ctx.editMessageText(review.text, review.keyboard);
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
            "Your request is saved — I'll notify you when a driver posts a matching ride. 🔔",
        );
        return;
      }

      let notified = 0;
      for (const c of candidates) {
        const driver = repo.getUserById(c.ride.driverId);
        if (!driver) continue;
        try {
          await notify(
            driver.telegramId,
            `🆕 New rider on your route!\n\n` +
              `📍 Pickup: ${request.pickupLabel}\n` +
              `📍 Dropoff: ${request.dropoffLabel}`,
            Markup.inlineKeyboard([
              [Markup.button.callback("Review riders →", "review_riders")],
            ]) as any,
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
          `You'll get a message here when a driver accepts.`,
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

    sessions.setScene(telegramId, "in_ride_relay");
    sessions.updateData(telegramId, { matchId: match.id, codeAttempts: 0 });

    sessions.setUserId(rider.telegramId, rider.id);
    sessions.setScene(rider.telegramId, "in_ride_relay");
    sessions.updateData(rider.telegramId, { matchId: match.id });

    // Notify rider with their code and the SOS keyboard
    try {
      await notify(
        rider.telegramId,
        `🎉 A driver accepted your ride!\n\n` +
          `📍 Pickup: ${candidate.request.pickupLabel}\n` +
          `📍 Dropoff: ${candidate.request.dropoffLabel}\n\n` +
          `Your confirmation code: *${code}*\n` +
          `Show this to the driver when they arrive to confirm your identity.\n\n` +
          `You can send messages to your driver through this chat.`,
        { parse_mode: "Markdown", ...SOS_KEYBOARD },
      );
    } catch (err) {
      console.error("Failed to notify rider:", err);
    }

    await ctx.editMessageText(
      `✅ Matched with ${rider.firstName}!\n\n` +
        `📍 Pick up: ${candidate.request.pickupLabel}\n\n` +
        `Head to the pickup point. When you meet the rider, ask for their ${DEFAULTS.CONFIRMATION_CODE_LENGTH}-digit code and enter it here.\n\n` +
        `You can also send messages to ${rider.firstName} through this chat.`,
    );
    // Show SOS keyboard to driver
    await ctx.reply(`🚨 Tap SOS below if you ever feel unsafe during the ride.`, SOS_KEYBOARD);
  });

  // --- Skip rider ---
  bot.action(/^skip_rider_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const candidates: MatchCandidate[] = session.data.candidates || [];
    const idx: number = (session.data.candidateIndex ?? 0) + 1;

    if (idx >= candidates.length) {
      sessions.reset(telegramId);
      await ctx.editMessageText(
        "No more riders to show. I'll notify you when someone new matches your route.",
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
        formatTrustProfile(rider, verifications, true) +
        `\n` +
        `📍 Pickup: ${candidate.request.pickupLabel}\n` +
        `📍 Dropoff: ${candidate.request.dropoffLabel}\n` +
        `↩️ Detour: ~${formatDuration(candidate.detour.addedSeconds)}`,
      Markup.inlineKeyboard([
        [
          Markup.button.callback(
            `Accept ${rider.firstName}`,
            `accept_rider_${candidate.request.id}`,
          ),
        ],
        [Markup.button.callback("Skip", `skip_rider_${candidate.request.id}`)],
      ]),
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
      [1, 2, 3, 4, 5].map((s) => Markup.button.callback(`${s}⭐`, `rate_${s}`)),
    ]);

    sessions.setScene(telegramId, "rating");
    sessions.updateData(telegramId, { matchId });

    await ctx.editMessageText(`Ride complete! 🎉`);
    // Remove SOS keyboard, then show rating prompt
    await ctx.reply(`How was ${rider?.firstName}? Rate your rider:`, {
      ...ratingKeyboard,
      reply_markup: { remove_keyboard: true },
    });
    await ctx.reply(`How was ${rider?.firstName}? Rate your rider:`, ratingKeyboard);

    if (rider) {
      sessions.setScene(rider.telegramId, "rating");
      sessions.updateData(rider.telegramId, { matchId });
      try {
        await notify(rider.telegramId, `You've arrived! 🎉`, {
          reply_markup: { remove_keyboard: true },
        });
        await notify(
          rider.telegramId,
          `How was your ride with ${driver?.firstName}?`,
          ratingKeyboard as any,
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

      const ratedId = match.driverId === session.userId ? match.riderId : match.driverId;
      repo.addRating(match.id, session.userId, ratedId, score, null);

      if (repo.bothRated(match.id)) {
        const ratings = repo.getRatingsForMatch(match.id);
        const driverRating = ratings.find((r) => r.ratedId === match.driverId);
        const riderRating = ratings.find((r) => r.ratedId === match.riderId);

        if (driverRating) {
          const pts =
            driverRating.score >= 4 ? POINTS.DRIVER_REWARD_HIGH : POINTS.DRIVER_REWARD_LOW;
          repo.adjustPoints(match.driverId, pts);
        }
        if (riderRating) {
          const pts = riderRating.score >= 4 ? POINTS.RIDER_REWARD_HIGH : POINTS.RIDER_REWARD_LOW;
          repo.adjustPoints(match.riderId, pts);
        }

        repo.incrementRideCount(match.driverId, "driver");
        repo.incrementRideCount(match.riderId, "rider");

        const driver = repo.getUserById(match.driverId);
        const rider = repo.getUserById(match.riderId);

        if (driver && driverRating) {
          const pts =
            driverRating.score >= 4 ? POINTS.DRIVER_REWARD_HIGH : POINTS.DRIVER_REWARD_LOW;
          try {
            await notify(
              driver.telegramId,
              `Thanks! ${rider?.firstName} rated you ⭐${driverRating.score}.\n` +
                `You earned ${pts} points. Balance: ${repo.getPointsBalance(driver.id).toFixed(1)} pts.`,
            );
            await notify(
              driver.telegramId,
              `What would you like to do next?`,
              mainMenuKeyboard() as any,
            );
          } catch {
            // Notification failures should not block rating completion.
          }
        }

        if (rider && riderRating) {
          const pts = riderRating.score >= 4 ? POINTS.RIDER_REWARD_HIGH : POINTS.RIDER_REWARD_LOW;
          try {
            await notify(
              rider.telegramId,
              `Thanks! ${driver?.firstName} rated you ⭐${riderRating.score}.\n` +
                `You earned ${pts} points. Balance: ${repo.getPointsBalance(rider.id).toFixed(1)} pts.`,
            );
            await notify(
              rider.telegramId,
              `What would you like to do next?`,
              mainMenuKeyboard() as any,
            );
          } catch {
            // Notification failures should not block rating completion.
          }
        }
      } else {
        await ctx.editMessageText(
          `Thanks for rating ⭐${score}! ` +
            `Waiting for the other party to rate — you'll both see results once they do.`,
        );
      }

      sessions.reset(telegramId);
    });
  }

  // --- Cancel ride posting flow ---
  bot.action("cancel_ride_flow", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    sessions.reset(telegramId);
    await ctx.editMessageText("Ride posting cancelled.");
    const session = sessions.get(telegramId);
    if (session.userId) {
      const user = repo.getUserById(session.userId);
      if (user) await showMainMenu(ctx, user.firstName);
    }
  });

  // --- SOS false alarm ---
  bot.action("sos_ok", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText("Glad you're safe. Ride continues as normal.");
  });

  // ============================================================
  // Register bot command list in Telegram UI
  // ============================================================
  bot.telegram
    .setMyCommands([
      { command: "drive", description: "Offer a ride" },
      { command: "ride", description: "Request a ride" },
      { command: "status", description: "My status and points" },
      { command: "trust", description: "Manage identity verifications" },
      { command: "cancel", description: "Cancel your current ride" },
      { command: "sos", description: "🚨 Emergency — call for help" },
      { command: "delete", description: "Delete my account" },
    ])
    .catch((err) => console.error("Failed to set bot commands:", err));
}
