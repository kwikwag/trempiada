import { Markup, Telegraf } from "telegraf";
import type { Repository } from "../db/repository";
import type { SessionManager } from "./session";
import type { MatchingService } from "../services/matching";
import type { RoutingService } from "../services/routing";
import type { CarRecognitionService } from "../services/car-recognition";
import type { GeocodingService } from "../services/geocoding";
import type { TelegramPhotoService } from "../services/identity/telegram-photo";
import type { ProfileFaceService } from "../services/identity/profile-face";
import type { FaceLivenessService } from "../services/identity/liveness";
import type { BotDeps } from "./deps";
import type { NotifyArgs } from "./deps";
import type { DevRepository } from "../db/dev-repository";
import { DevService, registerDevHandlers } from "./dev";
import { registerRegistrationHandlers } from "./handlers/registration";
import {
  registerDrivePostingHandlers,
  handleDrivePostingMessage,
  startDrivePostingFlow,
  createWazeDriveFromUrl,
  rideDepartureKeyboard,
} from "./handlers/drive-posting";
import {
  registerRideRequestHandlers,
  handleRideRequestMessage,
  startRideRequestFlow,
  requestReviewContent,
  requestTimeWindowKeyboard,
} from "./handlers/ride-request";
import { registerInRideHandlers, handleInRideMessage } from "./handlers/in-ride";
import { registerAccountHandlers } from "./handlers/account";
import {
  backToMenuKeyboard,
  cancellationKeyboard,
  genderKeyboard,
  mainMenuKeyboard,
  replyNotRegistered,
  replyWithRideReview,
  statusKeyboard,
  verificationKeyboard,
} from "./ui";
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

export interface RegisterHandlersArgs {
  bot: Telegraf;
  repo: Repository;
  sessions: SessionManager;
  matching: MatchingService;
  routing: RoutingService;
  carRecognition: CarRecognitionService;
  geocoding: GeocodingService;
  telegramPhotos: TelegramPhotoService;
  profileFace: ProfileFaceService;
  faceLiveness: FaceLivenessService;
  options?: HandlerOptions;
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

async function replyUnexpectedInput(ctx: any, deps: BotDeps): Promise<void> {
  const telegramId = ctx.from!.id;
  const { sessions } = deps;
  const session = sessions.get(telegramId);

  switch (session.scene) {
    case "idle":
      await ctx.reply("Choose what you'd like to do below.", mainMenuKeyboard());
      return;
    case "registration_gender":
      await ctx.reply("Please choose your gender using the buttons below.", genderKeyboard());
      return;
    case "registration_photo":
      await ctx.reply(
        "Please send a clear selfie photo, or tap Back to menu.",
        backToMenuKeyboard(),
      );
      return;
    case "registration_photo_confirm":
      await ctx.reply(
        "Use the buttons on the cropped photo to keep it, try again, or skip for now.",
        backToMenuKeyboard(),
      );
      return;
    case "registration_verification":
    case "registration_verification_choice":
      await ctx.reply(
        "Please choose a verification method below, or tap Back to menu.",
        verificationKeyboard(),
      );
      return;
    case "car_registration_photo":
      await ctx.reply(
        "Please send a photo of the rear of your car with the plate visible, or tap Back to menu.",
        backToMenuKeyboard(),
      );
      return;
    case "car_registration_confirm":
      await ctx.reply(
        "Please use the buttons on the previous message to confirm your car details, or tap Back to menu.",
        backToMenuKeyboard(),
      );
      return;
    case "car_edit":
      await ctx.reply(
        "Please send the updated car detail as text, or tap Back to menu.",
        backToMenuKeyboard(),
      );
      return;
    case "ride_origin":
      await ctx.reply(
        "I'm waiting for your starting point. Send a pin or type an address.",
        backToMenuKeyboard(),
      );
      return;
    case "ride_destination":
      await ctx.reply(
        "I'm waiting for your destination. Send a pin or type an address.",
        backToMenuKeyboard(),
      );
      return;
    case "ride_departure":
      await ctx.reply(
        "Please choose when you're leaving using the buttons below.",
        rideDepartureKeyboard(),
      );
      return;
    case "ride_departure_custom":
      await ctx.reply("Send a time like *18:00* or *6:30 PM*.", {
        parse_mode: "Markdown",
        ...backToMenuKeyboard(),
      });
      return;
    case "ride_review":
      await replyWithRideReview(ctx, { telegramId, sessions });
      return;
    case "ride_edit":
      if (session.data.editField === "seats") {
        const maxSeats = session.data.carSeatCount ?? session.data.seats;
        await ctx.reply(
          `Enter a number from 1 to ${maxSeats}, or tap Back to menu.`,
          backToMenuKeyboard(),
        );
      } else {
        await ctx.reply(
          "Please use the buttons on the previous message to continue, or tap Back to menu.",
          backToMenuKeyboard(),
        );
      }
      return;
    case "request_pickup":
      await ctx.reply(
        "I'm waiting for your pickup point. Send a pin or type an address.",
        backToMenuKeyboard(),
      );
      return;
    case "request_dropoff":
      await ctx.reply(
        "I'm waiting for your dropoff point. Send a pin or type an address.",
        backToMenuKeyboard(),
      );
      return;
    case "request_time":
      await ctx.reply(
        "Please choose a time window using the buttons below.",
        requestTimeWindowKeyboard(),
      );
      return;
    case "request_review": {
      const review = requestReviewContent(telegramId, deps);
      await ctx.reply(review.text, review.extra);
      return;
    }
    case "match_pending":
      await ctx.reply(
        "You're waiting for the other party to confirm. Use the button below to check your status.",
        statusKeyboard(),
      );
      return;
    case "in_ride_relay":
      await ctx.reply(
        "I can relay text messages here. Send a text message, or tap SOS if you need urgent help.",
        Markup.inlineKeyboard([[Markup.button.callback("Show my status", "menu_status")]]),
      );
      return;
    case "rating":
      await ctx.reply("Please rate using the buttons on the previous message.");
      return;
    case "cancel_reason":
      await ctx.reply(
        "Please choose a cancellation reason below, or tap Back to menu.",
        cancellationKeyboard(),
      );
      return;
    case "dispute_description":
      await ctx.reply("Please describe what happened, or tap Back to menu.", backToMenuKeyboard());
      return;
    case "profile_restart_name":
      await ctx.reply("Please type your name, or tap Back to menu.", backToMenuKeyboard());
      return;
    case "profile_restart_confirm":
      await ctx.reply(
        "Please use the buttons on the previous message to confirm or cancel your profile update.",
        backToMenuKeyboard(),
      );
      return;
    default:
      await ctx.reply("Please use the buttons below to continue.", statusKeyboard());
  }
}

export function registerHandlers({
  bot,
  repo,
  sessions,
  matching,
  routing,
  carRecognition,
  geocoding,
  telegramPhotos,
  profileFace,
  faceLiveness,
  options = {},
}: RegisterHandlersArgs) {
  const { whitelist, dev, devIds, altCount = 2, logger = noopLogger } = options;

  // ---- Dev: track all users before whitelist filtering ----
  if (dev) {
    bot.use((ctx, next) => {
      if (ctx.from) dev.trackUser(ctx.from);
      return next();
    });
  }

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
    registerDevHandlers({
      bot,
      dev,
      devIds: devIds ?? new Set(),
      sessions,
      devRepo: options.devRepo,
      altCount,
      routing,
      geocoding,
      whitelist,
    });
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
  async function notify({ targetId, text, extra }: NotifyArgs): Promise<void> {
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
    telegramPhotos,
    profileFace,
    faceLiveness,
    notify,
    logger,
  };

  // ---- Register domain handlers ----

  registerAccountHandlers(bot, deps);

  registerDrivePostingHandlers(bot, deps);

  registerRideRequestHandlers(bot, deps);

  registerInRideHandlers(bot, deps);

  const { handleMessage: handleRegistrationMessage } = registerRegistrationHandlers({
    bot,
    deps,
    startDrivePostingFlow: ({ ctx, telegramId }) =>
      startDrivePostingFlow({ ctx, telegramId, deps }),
    startRideRequestFlow: ({ ctx, telegramId }) => startRideRequestFlow({ ctx, telegramId, deps }),
    createWazeDriveFromUrl: ({ ctx, telegramId, url }) =>
      createWazeDriveFromUrl({ ctx, telegramId, wazeUrl: url, deps }),
  });

  // ---- Single message handler — routes to domain handlers in priority order ----
  bot.on("message", async (ctx) => {
    if (await handleInRideMessage(ctx, deps)) return;
    if (await handleDrivePostingMessage(ctx, deps)) return;
    if (await handleRideRequestMessage(ctx, deps)) return;
    if (await handleRegistrationMessage(ctx)) return;

    const session = sessions.get(ctx.from!.id);
    if (!session.userId) {
      await replyNotRegistered(ctx);
      return;
    }
    await replyUnexpectedInput(ctx, deps);
  });

  // ---- Register bot command list in Telegram UI ----
  bot.telegram
    .setMyCommands([
      { command: "drive", description: "Offer a ride" },
      { command: "ride", description: "Request a ride" },
      { command: "status", description: "My status and points" },
      { command: "profile", description: "My profile" },
      { command: "liveness", description: "Run face liveness check" },
      { command: "cancel", description: "Cancel your current ride" },
      { command: "sos", description: "🚨 Emergency — call for help" },
      { command: "delete", description: "Delete my account" },
    ])
    .then(() => logger.info("bot_commands_registered"))
    .catch((err) => logger.warn("bot_commands_registration_failed", { err }));
}
