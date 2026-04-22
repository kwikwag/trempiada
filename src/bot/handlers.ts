import { Telegraf } from "telegraf";
import type { Repository } from "../db/repository";
import type { SessionManager } from "./session";
import type { MatchingService } from "../services/matching";
import type { RoutingService } from "../services/routing";
import type { CarRecognitionService } from "../services/car-recognition";
import type { GeocodingService } from "../services/geocoding";
import type { BotDeps } from "./deps";
import type { DevRepository } from "../db/dev-repository";
import { DevService, registerDevHandlers } from "./dev";
import { registerRegistrationHandlers, handleRegistrationMessage } from "./handlers/registration";
import {
  registerDrivePostingHandlers,
  handleDrivePostingMessage,
  startDrivePostingFlow,
  createWazeDriveFromUrl,
} from "./handlers/drive-posting";
import { registerRideRequestHandlers, handleRideRequestMessage } from "./handlers/ride-request";
import { registerInRideHandlers, handleInRideMessage } from "./handlers/in-ride";
import { registerAccountHandlers } from "./handlers/account";
import { formatTrustProfile } from "../utils";
import type { Logger, LogContext } from "../logger";
import { noopLogger } from "../logger";

export interface HandlerOptions {
  whitelist?: Set<number>;
  dev?: DevService;
  devRepo?: DevRepository;
  devIds?: Set<number>;
  altCount?: number;
  logger?: Logger;
}

function messageKind(message: unknown): string | undefined {
  if (!message || typeof message !== "object") return undefined;
  const keys = Object.keys(message);
  return ["text", "location", "photo", "contact", "voice", "video", "document"].find((key) =>
    keys.includes(key),
  );
}

function updateMetadata(ctx: any, sessions: SessionManager): LogContext {
  const telegramId = ctx.from?.id;
  const session = telegramId ? sessions.get(telegramId) : null;
  const msg = ctx.message;
  const text = msg && "text" in msg ? String(msg.text) : undefined;
  const callbackData =
    ctx.callbackQuery && "data" in ctx.callbackQuery ? ctx.callbackQuery.data : undefined;

  return {
    updateId: ctx.update?.update_id,
    updateType: ctx.updateType,
    telegramId,
    userId: session?.userId,
    scene: session?.scene,
    messageKind: messageKind(msg),
    command: text?.startsWith("/") ? text.split(/\s+/, 1)[0] : undefined,
    callbackData,
  };
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
  const { whitelist, dev, devIds, altCount = 2, logger = noopLogger } = options;

  // ---- Whitelist middleware ----
  // Silently drop updates from non-whitelisted users (no reply, to avoid revealing the bot).
  if (whitelist && whitelist.size > 0) {
    bot.use((ctx, next) => {
      if (!whitelist.has(ctx.from?.id ?? 0)) {
        logger.info("update_dropped_not_whitelisted", {
          updateId: (ctx.update as any).update_id,
          updateType: ctx.updateType,
          telegramId: ctx.from?.id,
        });
        return;
      }
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
          logger.debug("dev_impersonation_applied", {
            realTelegramId: realId,
            effectiveTelegramId: effectiveId,
          });
        }
      }
      return next();
    });

    if (!options.devRepo) {
      throw new Error("DevRepository is required when dev mode is enabled");
    }
    registerDevHandlers(
      bot,
      dev,
      devIds ?? new Set(),
      sessions,
      options.devRepo,
      altCount,
      routing,
      geocoding,
      whitelist,
    );
  }

  // ---- Structured update logging ----
  bot.use(async (ctx, next) => {
    const start = Date.now();
    const before = updateMetadata(ctx, sessions);
    logger.debug("update_received", before);

    try {
      await next();
      logger.info("update_handled", {
        ...updateMetadata(ctx, sessions),
        previousScene: before.scene,
        durationMs: Date.now() - start,
      });
    } catch (err) {
      logger.error("update_failed", {
        ...updateMetadata(ctx, sessions),
        previousScene: before.scene,
        durationMs: Date.now() - start,
        err,
      });
      throw err;
    }
  });

  // Use this instead of bot.telegram.sendMessage whenever the target may be an alt user.
  // In dev mode, routes the message to the real chat with a persona prefix.
  async function notify(targetId: number, text: string, extra?: object): Promise<void> {
    const chatId = dev ? dev.resolveChat(targetId) : targetId;
    const prefix = dev ? dev.labelFor(targetId) : "";
    const start = Date.now();
    try {
      await bot.telegram.sendMessage(chatId, prefix + text, extra as any);
      logger.debug("notification_sent", {
        targetId,
        chatId,
        devRouted: Boolean(dev && chatId !== targetId),
        durationMs: Date.now() - start,
      });
    } catch (err) {
      logger.warn("notification_failed", {
        targetId,
        chatId,
        devRouted: Boolean(dev && chatId !== targetId),
        durationMs: Date.now() - start,
        err,
      });
      throw err;
    }
  }

  const deps: BotDeps = {
    repo,
    sessions,
    matching,
    routing,
    carRecognition,
    geocoding,
    notify,
    logger,
  };

  // ---- Register domain handlers ----

  registerAccountHandlers(bot, deps);

  registerDrivePostingHandlers(bot, deps);

  registerRideRequestHandlers(bot, deps);

  registerInRideHandlers(bot, deps);

  registerRegistrationHandlers(
    bot,
    deps,
    (ctx, telegramId) => startDrivePostingFlow(ctx, telegramId, deps),
    (ctx, telegramId, url) => createWazeDriveFromUrl(ctx, telegramId, url, deps),
  );

  // ---- Single message handler — routes to domain handlers in priority order ----
  bot.on("message", async (ctx) => {
    if (await handleInRideMessage(ctx, deps)) return;
    if (await handleDrivePostingMessage(ctx, deps)) return;
    if (await handleRideRequestMessage(ctx, deps)) return;

    // finishRegistration callback for use inside handleRegistrationMessage
    async function finishRegistration(ctx: any, telegramId: number): Promise<void> {
      const session = sessions.get(telegramId);
      if (!session.userId) return;
      const user = repo.getUserById(session.userId)!;
      const verifications = repo.getVerifications(session.userId);
      const profile = formatTrustProfile(user, verifications);
      await ctx.reply(`You're all set! 🎉\n\nYour trust profile:\n${profile}`);
      const { showMainMenu } = await import("./ui");
      await showMainMenu(ctx, user.firstName);
      if (session.data.pendingWazeDriveUrl) {
        await createWazeDriveFromUrl(ctx, telegramId, session.data.pendingWazeDriveUrl, deps);
      }
    }

    await handleRegistrationMessage(ctx, deps, finishRegistration);
  });

  // ---- Register bot command list in Telegram UI ----
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
    .then(() => logger.info("bot_commands_registered"))
    .catch((err) => logger.warn("bot_commands_registration_failed", { err }));
}
