import type { Context } from "telegraf";
import type { BotDeps } from "../deps";
import { profilePhotoConfirmKeyboard, profilePhotoPromptKeyboard } from "../ui";

export async function beginProfilePhotoFlow({
  ctx,
  telegramId,
  deps,
  prompt,
  extraData = {},
}: {
  ctx: Context;
  telegramId: number;
  deps: BotDeps;
  prompt: string;
  extraData?: Record<string, unknown>;
}): Promise<void> {
  const session = deps.sessions.get(telegramId);
  deps.sessions.setScene({
    telegramId,
    scene: "registration_photo",
    data: { ...session.data, ...extraData },
  });

  const usedTelegramPhoto = await tryTelegramProfilePhoto({
    ctx,
    telegramId,
    deps,
    extraData,
  });
  if (usedTelegramPhoto) return;

  await ctx.reply(prompt, profilePhotoPromptKeyboard());
}

export async function tryTelegramProfilePhoto({
  ctx,
  telegramId,
  deps,
  extraData = {},
}: {
  ctx: Context;
  telegramId: number;
  deps: BotDeps;
  extraData?: Record<string, unknown>;
}): Promise<boolean> {
  try {
    const profilePhotos = await ctx.telegram.getUserProfilePhotos(telegramId, 0, 1);
    if (profilePhotos.total_count === 0) return false;
    const largest = profilePhotos.photos[0][profilePhotos.photos[0].length - 1];
    await processPhotoCandidate({
      ctx,
      telegramId,
      deps,
      fileId: largest.file_id,
      extraData,
    });
    return true;
  } catch {
    return false;
  }
}

export async function processPhotoCandidate({
  ctx,
  telegramId,
  deps,
  fileId,
  extraData = {},
}: {
  ctx: Context;
  telegramId: number;
  deps: BotDeps;
  fileId: string;
  extraData?: Record<string, unknown>;
}): Promise<boolean> {
  const downloaded = await deps.telegramPhotos.downloadByFileId(fileId);
  if (!downloaded) {
    await ctx.reply(
      "I couldn't download that photo. Please try another one.",
      profilePhotoPromptKeyboard(),
    );
    deps.sessions.setScene({
      telegramId,
      scene: "registration_photo",
      data: { ...deps.sessions.get(telegramId).data, ...extraData },
    });
    return false;
  }

  const validation = await deps.profileFace.validateAndCropPhoto(
    downloaded.buffer,
    downloaded.mimeType,
  );
  if (!validation.ok) {
    await ctx.reply(validation.userMessage, profilePhotoPromptKeyboard());
    deps.sessions.setScene({
      telegramId,
      scene: "registration_photo",
      data: { ...deps.sessions.get(telegramId).data, ...extraData },
    });
    return false;
  }

  const sent = await (ctx as any).replyWithPhoto(
    { source: validation.croppedBuffer },
    {
      caption:
        "I cropped that photo so your face is centered. Use this picture, try another one, or skip for now.",
      ...profilePhotoConfirmKeyboard(),
    },
  );
  const sentPhotos = sent?.photo ?? [];
  const largest = sentPhotos[sentPhotos.length - 1];
  if (!largest?.file_id) {
    await ctx.reply(
      "I couldn't save that cropped photo. Please try again.",
      profilePhotoPromptKeyboard(),
    );
    deps.sessions.setScene({
      telegramId,
      scene: "registration_photo",
      data: { ...deps.sessions.get(telegramId).data, ...extraData },
    });
    return false;
  }

  deps.sessions.setScene({
    telegramId,
    scene: "registration_photo_confirm",
    data: {
      ...deps.sessions.get(telegramId).data,
      ...extraData,
      candidatePhotoFileId: largest.file_id,
    },
  });
  return true;
}

export function applyConfirmedPhoto({
  userId,
  photoFileId,
  deps,
}: {
  userId: number;
  photoFileId: string;
  deps: BotDeps;
}): void {
  deps.repo.updateUserProfile(userId, { photoFileId });
  deps.repo.clearFaceLivenessVerification(userId);
  const verifications = deps.repo.getVerifications(userId);
  if (!verifications.find((v) => v.type === "photo")) {
    deps.repo.addVerification({ userId, type: "photo" });
  }
}
