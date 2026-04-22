import { Markup } from "telegraf";
import type { Telegraf, Context } from "telegraf";
import type { BotDeps } from "../deps";
import type { MatchCandidate } from "../../services/matching";
import { DEFAULTS, POINTS } from "../../types";
import { formatTrustProfile, formatDuration, generateCode } from "../../utils";
import { SOS_KEYBOARD, mainMenuKeyboard, handleSos } from "../ui";

export function registerInRideHandlers(bot: Telegraf, deps: BotDeps): void {
  const { repo, sessions, notify, logger } = deps;

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
    logger.info("match_accepted", {
      telegramId,
      driverId: session.userId,
      riderId: candidate.request.riderId,
      matchId: match.id,
      rideId: session.data.rideId,
      requestId,
      detourSeconds: candidate.detour.addedSeconds,
    });

    const rider = repo.getUserById(candidate.request.riderId);
    if (!rider) return;

    sessions.setScene(telegramId, "in_ride_relay");
    sessions.updateData(telegramId, { matchId: match.id, codeAttempts: 0 });

    sessions.setUserId(rider.telegramId, rider.id);
    sessions.setScene(rider.telegramId, "in_ride_relay");
    sessions.updateData(rider.telegramId, { matchId: match.id });

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
      logger.warn("match_accept_rider_notification_failed", {
        telegramId,
        matchId: match.id,
        riderId: candidate.request.riderId,
        err,
      });
    }

    await ctx.editMessageText(
      `✅ Matched with ${rider.firstName}!\n\n` +
        `📍 Pick up: ${candidate.request.pickupLabel}\n\n` +
        `Head to the pickup point. When you meet the rider, ask for their ${DEFAULTS.CONFIRMATION_CODE_LENGTH}-digit code and enter it here.\n\n` +
        `You can also send messages to ${rider.firstName} through this chat.`,
    );
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
    logger.info("rider_candidate_skipped", {
      telegramId,
      userId: session.userId,
      skippedRequestId: parseInt(ctx.match![1]),
      nextIndex: idx,
      candidateCount: candidates.length,
    });

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
    logger.info("ride_completed", {
      telegramId,
      userId: session.userId,
      matchId,
      rideId: match.rideId,
      requestId: match.requestId,
      driverId: match.driverId,
      riderId: match.riderId,
    });

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
        logger.warn("rider_rating_prompt_failed", {
          matchId,
          riderId: rider.id,
          err,
        });
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
      logger.info("rating_submitted", {
        telegramId,
        userId: session.userId,
        matchId: match.id,
        ratedId,
        score,
      });

      if (repo.bothRated(match.id)) {
        const ratings = repo.getRatingsForMatch(match.id);
        const driverRating = ratings.find((r) => r.ratedId === match.driverId);
        const riderRating = ratings.find((r) => r.ratedId === match.riderId);

        if (driverRating) {
          const pts =
            driverRating.score >= 4 ? POINTS.DRIVER_REWARD_HIGH : POINTS.DRIVER_REWARD_LOW;
          repo.adjustPoints(match.driverId, pts);
          logger.info("points_awarded", {
            matchId: match.id,
            userId: match.driverId,
            role: "driver",
            points: pts,
            ratingScore: driverRating.score,
          });
        }
        if (riderRating) {
          const pts = riderRating.score >= 4 ? POINTS.RIDER_REWARD_HIGH : POINTS.RIDER_REWARD_LOW;
          repo.adjustPoints(match.riderId, pts);
          logger.info("points_awarded", {
            matchId: match.id,
            userId: match.riderId,
            role: "rider",
            points: pts,
            ratingScore: riderRating.score,
          });
        }

        repo.incrementRideCount(match.driverId, "driver");
        repo.incrementRideCount(match.riderId, "rider");

        const driver = repo.getUserById(match.driverId);
        const rider = repo.getUserById(match.riderId);
        logger.info("both_rated", {
          matchId: match.id,
          driverId: match.driverId,
          riderId: match.riderId,
        });

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

  // --- SOS false alarm ---
  bot.action("sos_ok", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText("Glad you're safe. Ride continues as normal.");
  });
}

export async function handleInRideMessage(ctx: Context, deps: BotDeps): Promise<boolean> {
  const telegramId = ctx.from!.id;
  const { repo, sessions, notify, logger } = deps;
  const session = sessions.get(telegramId);
  const msg = (ctx as any).message;

  // --- SOS reply keyboard tap ---
  if ("text" in msg && msg.text === "🚨 SOS") {
    if (session.userId) await handleSos(ctx, session.userId, repo, logger);
    return true;
  }

  // --- Message relay during active ride ---
  if (session.scene === "in_ride_relay" && session.userId) {
    const match = repo.getActiveMatchForUser(session.userId);
    if (match) {
      const otherUserId = match.driverId === session.userId ? match.riderId : match.driverId;
      const otherUser = repo.getUserById(otherUserId);
      const thisUser = repo.getUserById(session.userId);

      if (otherUser && thisUser && "text" in msg) {
        try {
          await notify(otherUser.telegramId, `💬 ${thisUser.firstName}: ${msg.text}`);
          logger.info("relay_message_sent", {
            telegramId,
            fromUserId: thisUser.id,
            toUserId: otherUser.id,
            matchId: match.id,
          });
        } catch {
          logger.warn("relay_message_failed", {
            telegramId,
            fromUserId: thisUser.id,
            toUserId: otherUser.id,
            matchId: match.id,
          });
          await ctx.reply("Couldn't relay your message. The other party may have blocked the bot.");
        }
        return true;
      }
    }
  }

  // --- Confirmation code entry during ride ---
  if (session.scene === "in_ride_relay" && "text" in msg) {
    const match = repo.getActiveMatchForUser(session.userId!);
    if (match && match.status === "accepted" && match.driverId === session.userId) {
      const code = msg.text.trim();
      if (code === match.confirmationCode) {
        repo.updateMatchStatus(match.id, "picked_up");
        logger.info("pickup_confirmed", {
          telegramId,
          userId: session.userId,
          matchId: match.id,
          attemptCount: session.data.codeAttempts ?? 0,
        });

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
            logger.warn("pickup_rider_notification_failed", {
              matchId: match.id,
              riderId: match.riderId,
              err,
            });
          }
        }
        return true;
      }

      const attempts = (session.data.codeAttempts || 0) + 1;
      sessions.updateData(telegramId, { codeAttempts: attempts });
      logger.warn("pickup_code_attempt_failed", {
        telegramId,
        userId: session.userId,
        matchId: match.id,
        attemptCount: attempts,
      });

      if (attempts >= DEFAULTS.CONFIRMATION_MAX_ATTEMPTS) {
        await ctx.reply(
          "Too many incorrect attempts. Please confirm with your rider that you've found the right person.",
        );
        return true;
      }

      await ctx.reply(
        `That code doesn't match. Double-check with your rider.\n` +
          `(${DEFAULTS.CONFIRMATION_MAX_ATTEMPTS - attempts} attempts remaining)`,
      );
      return true;
    }
  }

  return false;
}
