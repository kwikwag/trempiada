import { Telegraf } from "telegraf";
import type { Repository } from "../db/repository";
import type { SessionManager } from "./session";
import type { MatchingService } from "../services/matching";
import type { RoutingService } from "../services/routing";
import type { CarRecognitionService } from "../services/car-recognition";
import type { GeocodingService } from "../services/geocoding";
import type { BotDeps } from "./deps";
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

  // Use this instead of bot.telegram.sendMessage whenever the target may be an alt user.
  // In dev mode, routes the message to the real chat with a persona prefix.
  async function notify(targetId: number, text: string, extra?: object): Promise<void> {
    const chatId = dev ? dev.resolveChat(targetId) : targetId;
    const prefix = dev ? dev.labelFor(targetId) : "";
    await bot.telegram.sendMessage(chatId, prefix + text, extra as any);
  }

  const deps: BotDeps = {
    repo,
    sessions,
    matching,
    routing,
    carRecognition,
    geocoding,
    notify,
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
    .catch((err) => console.error("Failed to set bot commands:", err));
}
