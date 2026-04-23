import type { Context } from "telegraf";
import type { BotDeps } from "../deps";
import { backToMenuKeyboard, genderKeyboard } from "../ui";

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

  if (!user.photoFileId) {
    try {
      const profilePhotos = await ctx.telegram.getUserProfilePhotos(telegramId, 0, 1);
      if (profilePhotos.total_count > 0) {
        const largest = profilePhotos.photos[0][profilePhotos.photos[0].length - 1];
        repo.updateUserProfile(session.userId, { photoFileId: largest.file_id });
        const verifications = repo.getVerifications(session.userId);
        if (!verifications.find((v) => v.type === "photo")) {
          repo.addVerification({ userId: session.userId, type: "photo" });
        }
        logger.info("profile_photo_obtained_telegram", { telegramId, userId: session.userId });
        return true;
      }
    } catch {
      // fall through to manual upload
    }

    sessions.setScene({
      telegramId,
      scene: "registration_photo",
      data: { ...session.data, pendingAction },
    });
    logger.info("profile_completion_photo_needed", {
      telegramId,
      userId: session.userId,
      pendingAction,
    });
    await ctx.reply(
      "Please send a photo of your face so the other party can recognize you. 📸",
      backToMenuKeyboard(),
    );
    return false;
  }

  return true;
}
