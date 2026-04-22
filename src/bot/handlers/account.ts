import { Markup } from "telegraf";
import type { Telegraf } from "telegraf";
import type { BotDeps } from "../deps";
import type { VerificationType } from "../../types";
import { POINTS } from "../../types";
import {
  mainMenuKeyboard,
  showMainMenu,
  replyNotRegistered,
  renderTrustProfile,
  handleSos,
  showStatus,
  cancellationKeyboard,
  REMOVE_KEYBOARD,
} from "../ui";
export function registerAccountHandlers(bot: Telegraf, deps: BotDeps): void {
  const { repo, sessions, notify, logger } = deps;

  // /start — entry point
  bot.start(async (ctx) => {
    const telegramId = ctx.from!.id;
    const existing = repo.getUserByTelegramId(telegramId);

    if (existing) {
      sessions.setUserId(telegramId, existing.id);
      sessions.setScene({ telegramId, scene: "idle" });
      logger.info("user_started", {
        telegramId,
        userId: existing.id,
        existingUser: true,
      });
      await ctx.reply(`Welcome back, ${existing.firstName}! 👋`);
      await showMainMenu(ctx, existing.firstName);
      return;
    }

    sessions.setScene({ telegramId, scene: "registration_name", data: {} });
    logger.info("user_started", {
      telegramId,
      existingUser: false,
    });
    await ctx.reply(
      `Hey! 👋 Welcome to TrempiadaBot.\n\n` +
        `We connect drivers with people looking for a ride along their route.\n\n` +
        `Let's get you set up — it takes about 30 seconds.\n\n` +
        `What's your first name? (This is what others will see.)`,
    );
  });

  bot.command("trust", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) {
      await replyNotRegistered(ctx);
      return;
    }

    await renderTrustProfile(ctx, { userId: session.userId, repo });
  });

  bot.command("sos", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;
    await handleSos(ctx, { userId: session.userId, repo, logger });
  });

  bot.command("status", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) {
      await replyNotRegistered(ctx);
      return;
    }

    await showStatus(ctx, { userId: session.userId, repo });
  });

  bot.command("cancel", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const activeMatch = repo.getActiveMatchForUser(session.userId);
    if (!activeMatch) {
      const cancelledRide = repo.cancelOpenRideForDriver(session.userId);
      if (cancelledRide) {
        sessions.reset(telegramId);
        logger.info("open_ride_cancelled", {
          telegramId,
          userId: session.userId,
          rideId: cancelledRide.id,
          source: "command",
        });
        await ctx.reply("Your ride offer is cancelled.", mainMenuKeyboard());
        return;
      }

      const cancelledRequest = repo.cancelOpenRideRequestForRider(session.userId);
      if (cancelledRequest) {
        sessions.reset(telegramId);
        logger.info("open_ride_request_cancelled", {
          telegramId,
          userId: session.userId,
          requestId: cancelledRequest.id,
          source: "command",
        });
        await ctx.reply("Your ride request is cancelled.", mainMenuKeyboard());
        return;
      }

      sessions.reset(telegramId);
      logger.info("cancel_requested_without_active_match", {
        telegramId,
        userId: session.userId,
      });
      await ctx.reply("Nothing to cancel. You're all clear.", mainMenuKeyboard());
      return;
    }

    sessions.setScene({ telegramId, scene: "cancel_reason", data: { matchId: activeMatch.id } });
    logger.info("cancel_requested", {
      telegramId,
      userId: session.userId,
      matchId: activeMatch.id,
    });
    await ctx.reply(`Cancelling your ride. What happened?`, cancellationKeyboard());
  });

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

  // Main menu callbacks
  bot.action("menu_trust", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;
    await renderTrustProfile(ctx, { userId: session.userId, repo });
  });

  bot.action("menu_status", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;
    await showStatus(ctx, { userId: session.userId, repo });
  });

  bot.action("menu_start", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    sessions.setScene({ telegramId, scene: "registration_name", data: {} });
    await ctx.reply("What's your first name? (This is what others will see.)");
  });

  bot.action("sos_button", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;
    await handleSos(ctx, { userId: session.userId, repo, logger });
  });

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

    sessions.setScene({ telegramId, scene: "cancel_reason", data: { matchId: activeMatch.id } });
    await ctx.reply(`Cancelling your ride. What happened?`, cancellationKeyboard());
  });

  bot.action("cancel_open_ride", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const cancelledRide = repo.cancelOpenRideForDriver(session.userId);
    if (!cancelledRide) {
      await ctx.editMessageText("No open ride offer to cancel.");
      return;
    }

    sessions.reset(telegramId);
    logger.info("open_ride_cancelled", {
      telegramId,
      userId: session.userId,
      rideId: cancelledRide.id,
      source: "status",
    });
    await ctx.editMessageText("Your ride offer is cancelled.");
    const user = repo.getUserById(session.userId);
    if (user) await showMainMenu(ctx, user.firstName);
  });

  bot.action("cancel_open_request", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const cancelledRequest = repo.cancelOpenRideRequestForRider(session.userId);
    if (!cancelledRequest) {
      await ctx.editMessageText("No open ride request to cancel.");
      return;
    }

    sessions.reset(telegramId);
    logger.info("open_ride_request_cancelled", {
      telegramId,
      userId: session.userId,
      requestId: cancelledRequest.id,
      source: "status",
    });
    await ctx.editMessageText("Your ride request is cancelled.");
    const user = repo.getUserById(session.userId);
    if (user) await showMainMenu(ctx, user.firstName);
  });

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
    logger.warn("account_deleted", {
      telegramId,
      userId: session.userId,
    });
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

      repo.cancelMatch({ matchId, cancelledBy: session.userId, reason });
      repo.updateRideStatus(match.rideId, "cancelled");
      repo.updateRequestStatus(match.requestId, "cancelled");
      logger.info("ride_cancelled", {
        telegramId,
        userId: session.userId,
        matchId,
        reason,
        cancelledBy: session.userId,
      });

      const otherUserId = match.driverId === session.userId ? match.riderId : match.driverId;
      const otherUser = repo.getUserById(otherUserId);

      let cancelMsg = `Ride cancelled.`;
      if (reason === "no_show") {
        repo.adjustPoints(session.userId, POINTS.NO_SHOW_COMPENSATION);
        cancelMsg = `Ride cancelled (no-show). You've been awarded ${POINTS.NO_SHOW_COMPENSATION} point for your time.`;
      } else if (reason === "felt_unsafe") {
        cancelMsg = `Ride cancelled. This has been logged for review. No penalty applied to you.`;
      }

      await ctx.reply(cancelMsg, REMOVE_KEYBOARD);
      sessions.reset(telegramId);

      const user = repo.getUserById(session.userId);
      if (user) await showMainMenu(ctx, user.firstName);

      if (otherUser) {
        try {
          await notify({
            targetId: otherUser.telegramId,
            text:
              `⚠️ Your ride has been cancelled by the other party.\n` +
              (reason === "no_show"
                ? `Reason: they reported you didn't show up.\nIf this was a mistake, contact support.`
                : ``),
            extra: { reply_markup: { remove_keyboard: true } },
          });
          await notify({
            targetId: otherUser.telegramId,
            text: `What would you like to do next?`,
            extra: mainMenuKeyboard() as any,
          });
        } catch (err) {
          logger.warn("cancel_other_party_notification_failed", {
            telegramId,
            matchId,
            otherUserId,
            err,
          });
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

    repo.setVerificationVisibility({
      userId: session.userId,
      type,
      shared: !v.sharedWithRiders,
    });
    const newState = !v.sharedWithRiders ? "visible to riders" : "hidden from riders";
    logger.info("verification_visibility_changed", {
      telegramId,
      userId: session.userId,
      verificationType: type,
      sharedWithRiders: !v.sharedWithRiders,
    });

    await ctx.answerCbQuery(`${type} is now ${newState}`);
    await renderTrustProfile(ctx, { userId: session.userId, repo });
  });
}
