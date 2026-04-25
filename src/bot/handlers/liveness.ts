import { Markup } from "telegraf";
import type { Context } from "telegraf";
import type { BotDeps } from "../deps";
import { replyNotRegistered } from "../ui";

export async function startLivenessCheck(
  ctx: Context,
  telegramId: number,
  deps: BotDeps,
): Promise<void> {
  const { repo, sessions, notify, logger } = deps;
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
    "This is a one-time liveness link. It stays valid for the next 3 minutes, so open it now on this phone and complete the check in one go.\n\nIf it expires or anything goes wrong, come back here and tap Restart liveness check.",
    Markup.inlineKeyboard([
      [Markup.button.url("Open liveness check", attempt.url)],
      [Markup.button.callback("Restart liveness check", "profile_liveness")],
    ]),
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
      if (result.status === "expired") {
        logger.info("liveness_attempt_expired", {
          telegramId,
          userId: session.userId,
          sessionId: attempt.sessionId,
        });
        return;
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
