import { Markup } from "telegraf";
import type { Context, Telegraf } from "telegraf";
import type { BotDeps } from "../deps";
import type { Gender, VerificationType } from "../../types";
import { POINTS } from "../../types";
import { SOCIAL_VERIFICATION_TYPES } from "./restart-profile";
import { beginProfilePhotoFlow } from "./profile-photo";
import {
  backToMenuKeyboard,
  mainMenuKeyboard,
  showMainMenu,
  replyNotRegistered,
  renderProfile,
  handleSos,
  showStatus,
  cancellationKeyboard,
  REMOVE_KEYBOARD,
} from "../ui";
export function registerAccountHandlers(bot: Telegraf, deps: BotDeps): void {
  const { repo, sessions, notify, logger } = deps;

  async function returnToHome(telegramId: number, ctx: Context): Promise<void> {
    const session = sessions.get(telegramId);
    if (!session.userId) {
      await replyNotRegistered(ctx);
      return;
    }

    sessions.reset(telegramId);
    const activeMatch = repo.getActiveMatchForUser(session.userId);
    const openRide = repo.getOpenRideForDriver(session.userId);
    const openRequest = repo.getOpenRideRequestForRider(session.userId);

    if (activeMatch || openRide || openRequest) {
      await showStatus(ctx, { userId: session.userId, repo });
      return;
    }

    const user = repo.getUserById(session.userId);
    if (user) {
      await showMainMenu(ctx, user.firstName);
    }
  }

  async function startLivenessCheck(ctx: Context, telegramId: number): Promise<void> {
    const session = sessions.get(telegramId);
    if (!session.userId) {
      await replyNotRegistered(ctx);
      return;
    }

    const user = repo.getUserById(session.userId);
    if (!user?.photoFileId) {
      await ctx.reply(
        "Add a profile photo first, then I can run a liveness check against it.",
        Markup.inlineKeyboard([[Markup.button.callback("Add picture", "profile_photo")]]),
      );
      return;
    }

    await ctx.reply("Creating your face liveness check...");

    let attempt;
    try {
      attempt = await deps.faceLiveness.createAttempt({
        userId: session.userId,
        profilePhotoFileId: user.photoFileId,
      });
    } catch (err) {
      logger.error("liveness_attempt_create_failed", { telegramId, userId: session.userId, err });
      await ctx.reply("I couldn't start a liveness check right now. Please try again later.");
      return;
    }

    await ctx.reply(
      "Open the secure liveness page and follow the on-screen instructions. If anything goes wrong, you can just start a new check here.",
      Markup.inlineKeyboard([[Markup.button.url("Open liveness check", attempt.url)]]),
    );

    void (async () => {
      const currentUser = repo.getUserById(session.userId!);
      if (!currentUser?.photoFileId) return;
      const downloaded = await deps.telegramPhotos.downloadByFileId(currentUser.photoFileId);
      if (!downloaded) {
        await notify({
          targetId: telegramId,
          text: "I couldn't verify your current profile photo when the liveness check finished. Please try again.",
        }).catch(() => undefined);
        return;
      }

      try {
        const result = await deps.faceLiveness.pollForResult({
          sessionId: attempt.sessionId,
          expectedProfilePhotoFileId: attempt.profilePhotoFileId,
          currentProfilePhotoFileId: repo.getUserById(session.userId!)?.photoFileId ?? null,
          profilePhotoBuffer: downloaded.buffer,
        });
        if (result.status === "succeeded") {
          repo.setFaceLivenessVerification({
            userId: session.userId!,
            profilePhotoFileId: attempt.profilePhotoFileId,
          });
        }
        await notify({
          targetId: telegramId,
          text: result.userMessage,
          extra:
            result.status === "succeeded"
              ? undefined
              : Markup.inlineKeyboard([
                  [Markup.button.callback("Start a new liveness check", "profile_liveness")],
                ]),
        });
      } catch (err) {
        logger.error("liveness_poll_failed", { telegramId, userId: session.userId, err });
        await notify({
          targetId: telegramId,
          text: "I couldn't finish checking that liveness session. Please try again.",
          extra: Markup.inlineKeyboard([
            [Markup.button.callback("Start a new liveness check", "profile_liveness")],
          ]) as any,
        }).catch(() => undefined);
      }
    })();
  }

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

    // Auto-create account from Telegram data — no registration steps needed up front
    const telegramName = ctx.from!.first_name;
    const newUser = repo.createUser(telegramId, telegramName);
    repo.addVerification({ userId: newUser.id, type: "phone" });

    sessions.setUserId(telegramId, newUser.id);
    sessions.setScene({ telegramId, scene: "idle" });
    logger.info("user_registered", {
      telegramId,
      userId: newUser.id,
    });
    await ctx.reply(
      `Hey ${telegramName}! 👋 Welcome to TrempiadaBot.\n\n` +
        `We connect drivers with people looking for a ride along their route.`,
    );
    await showMainMenu(ctx, telegramName);
  });

  bot.command("profile", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) {
      await replyNotRegistered(ctx);
      return;
    }

    await renderProfile(ctx, { userId: session.userId, repo });
  });

  bot.command("restart", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) {
      await replyNotRegistered(ctx);
      return;
    }

    const activeMatch = repo.getActiveMatchForUser(session.userId);
    if (activeMatch) {
      await ctx.reply(
        "You have an active ride. Please cancel it before restarting your profile.",
        Markup.inlineKeyboard([[Markup.button.callback("Cancel ride", "cancel_from_status")]]),
      );
      return;
    }

    const openRide = repo.getOpenRideForDriver(session.userId);
    if (openRide) {
      await ctx.reply(
        "You have an open ride offer. Please cancel it before restarting your profile.",
        Markup.inlineKeyboard([[Markup.button.callback("Cancel offer", "cancel_open_ride")]]),
      );
      return;
    }

    const openRequest = repo.getOpenRideRequestForRider(session.userId);
    if (openRequest) {
      await ctx.reply(
        "You have an open ride request. Please cancel it before restarting your profile.",
        Markup.inlineKeyboard([[Markup.button.callback("Cancel request", "cancel_open_request")]]),
      );
      return;
    }

    const user = repo.getUserById(session.userId)!;
    sessions.setScene({ telegramId, scene: "profile_restart_name" });
    await ctx.reply(
      `Let's update your profile.\n\nWhat's your name?\n\nCurrent: *${user.firstName}*`,
      { parse_mode: "Markdown", ...backToMenuKeyboard() },
    );
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

  bot.command("liveness", async (ctx) => {
    await startLivenessCheck(ctx, ctx.from!.id);
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
  bot.action("menu_profile", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;
    await renderProfile(ctx, { userId: session.userId, repo });
  });

  bot.action("restart_profile", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const activeMatch = repo.getActiveMatchForUser(session.userId);
    if (activeMatch) {
      await ctx.reply(
        "You have an active ride. Please cancel it before restarting your profile.",
        Markup.inlineKeyboard([[Markup.button.callback("Cancel ride", "cancel_from_status")]]),
      );
      return;
    }

    const openRide = repo.getOpenRideForDriver(session.userId);
    if (openRide) {
      await ctx.reply(
        "You have an open ride offer. Please cancel it before restarting your profile.",
        Markup.inlineKeyboard([[Markup.button.callback("Cancel offer", "cancel_open_ride")]]),
      );
      return;
    }

    const openRequest = repo.getOpenRideRequestForRider(session.userId);
    if (openRequest) {
      await ctx.reply(
        "You have an open ride request. Please cancel it before restarting your profile.",
        Markup.inlineKeyboard([[Markup.button.callback("Cancel request", "cancel_open_request")]]),
      );
      return;
    }

    const user = repo.getUserById(session.userId)!;
    sessions.setScene({ telegramId, scene: "profile_restart_name" });
    await ctx.reply(
      `Let's update your profile.\n\nWhat's your name?\n\nCurrent: *${user.firstName}*`,
      { parse_mode: "Markdown" },
    );
  });

  bot.action("profile_photo", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;
    await beginProfilePhotoFlow({
      ctx,
      telegramId,
      deps,
      prompt:
        "Send a clear face photo. If you already have a Telegram profile picture, I'll try that first.",
      extraData: { returnToProfile: true },
    });
  });

  bot.action("profile_liveness", async (ctx) => {
    await ctx.answerCbQuery();
    await startLivenessCheck(ctx, ctx.from!.id);
  });

  bot.action("restart_apply", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    if (!session.userId) return;

    const { newName, newGender, newPhotoFileId, restartRemoveCar, restartRemoveSocials } =
      session.data;

    if (typeof newName !== "string" || newName.trim().length === 0) {
      sessions.reset(telegramId);
      await ctx.editMessageText("This profile update expired. Start again when you're ready.");
      return;
    }

    // Clear gender/photo first (clearUserProfileData sets them null), then re-apply new values
    repo.clearUserProfileData(session.userId);
    repo.updateUserProfile(session.userId, { firstName: newName });
    if (isGender(newGender)) repo.updateUserProfile(session.userId, { gender: newGender });
    const hasNewPhoto = typeof newPhotoFileId === "string" && newPhotoFileId.length > 0;
    if (hasNewPhoto) repo.updateUserProfile(session.userId, { photoFileId: newPhotoFileId });

    const verificationTypesToRemove: VerificationType[] = ["photo"];
    if (restartRemoveCar === true) {
      repo.deactivateAllCarsForUser(session.userId);
      verificationTypesToRemove.push("car");
    }
    if (restartRemoveSocials === true) {
      verificationTypesToRemove.push(...SOCIAL_VERIFICATION_TYPES);
    }
    repo.removeVerificationsByTypes(session.userId, verificationTypesToRemove);
    if (hasNewPhoto) repo.addVerification({ userId: session.userId, type: "photo" });

    logger.info("profile_restarted", { telegramId, userId: session.userId });
    sessions.reset(telegramId);

    const user = repo.getUserById(session.userId)!;
    await ctx.editMessageText("✅ Profile updated!");
    await showMainMenu(ctx, user.firstName);
  });

  bot.action("restart_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    sessions.reset(telegramId);
    const session = sessions.get(telegramId);
    const user = session.userId ? repo.getUserById(session.userId) : null;
    await ctx.editMessageText("Profile update cancelled. Nothing was changed.");
    if (user) await showMainMenu(ctx, user.firstName);
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
    const session = sessions.get(telegramId);

    if (!session.userId) {
      const existing = repo.getUserByTelegramId(telegramId);
      if (existing) {
        sessions.setUserId(telegramId, existing.id);
        sessions.setScene({ telegramId, scene: "idle" });
        await showMainMenu(ctx, existing.firstName);
        return;
      }
      // Auto-create from Telegram data
      const telegramName = ctx.from!.first_name;
      const newUser = repo.createUser(telegramId, telegramName);
      repo.addVerification({ userId: newUser.id, type: "phone" });
      sessions.setUserId(telegramId, newUser.id);
      sessions.setScene({ telegramId, scene: "idle" });
      logger.info("user_registered_via_menu_start", { telegramId, userId: newUser.id });
      await showMainMenu(ctx, telegramName);
      return;
    }

    const user = repo.getUserById(session.userId)!;
    sessions.setScene({ telegramId, scene: "idle" });
    await showMainMenu(ctx, user.firstName);
  });

  bot.action("back_to_menu", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);
    logger.info("flow_exited_back_to_menu", {
      telegramId,
      userId: session.userId,
      previousScene: session.scene,
    });
    await ctx.editMessageText("Left that flow.");
    await returnToHome(telegramId, ctx);
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
    await renderProfile(ctx, { userId: session.userId, repo });
  });
}

function isGender(value: unknown): value is Gender {
  return value === "male" || value === "female" || value === "other";
}
