import { Markup } from "telegraf";
import type { Context } from "telegraf";
import type { BotDeps } from "../deps";
import { genderKeyboard } from "../ui";

export async function ensureProfileComplete({
  ctx,
  telegramId,
  deps,
  pendingAction,
}: {
  ctx: Context;
  telegramId: number;
  deps: BotDeps;
  pendingAction: "ride" | "drive";
}): Promise<boolean> {
  const { repo, sessions, logger } = deps;
  const session = sessions.get(telegramId);
  if (!session.userId) return false;

  const user = repo.getUserById(session.userId)!;

  if (!user.gender) {
    sessions.setScene({
      telegramId,
      scene: "registration_gender",
      data: { ...session.data, pendingAction },
    });
    logger.info("profile_completion_gender_needed", {
      telegramId,
      userId: session.userId,
      pendingAction,
    });
    await ctx.reply(
      "What's your gender? Some riders might feel more safe if you share this info.",
      genderKeyboard(),
    );
    return false;
  }

  if (!user.photoFileId && !user.photoNudgedAt) {
    sessions.setScene({
      telegramId,
      scene: "idle",
      data: { ...session.data, pendingAction },
    });
    logger.info("profile_completion_photo_nudge", {
      telegramId,
      userId: session.userId,
      pendingAction,
    });
    await ctx.reply(
      "Users with a profile photo are more likely to be matched. Want to add one now?",
      Markup.inlineKeyboard([
        [Markup.button.callback("Add photo", "photo_nudge_add")],
        [Markup.button.callback("Skip for now", "photo_nudge_skip")],
      ]),
    );
    return false;
  }

  return true;
}
