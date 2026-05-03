import "dotenv/config";
import path from "path";
import { Telegraf } from "telegraf";
import { LambdaClient } from "@aws-sdk/client-lambda";
import { RekognitionClient } from "@aws-sdk/client-rekognition";
import { initDatabase } from "./db/migrate";
import { Repository } from "./db/repository";
import { DevRepository } from "./db/dev-repository";
import { SessionManager } from "./bot/session";
import { RoutingService } from "./services/routing";
import { MatchingService } from "./services/matching";
import { CarRecognitionService } from "./services/car-recognition";
import { LicenseLookupService } from "./services/license-lookup";
import { GeocodingService } from "./services/geocoding";
import { TelegramPhotoService } from "./services/identity/telegram-photo";
import { ProfileFaceService } from "./services/identity/profile-face";
import { FaceLivenessService, createAwsClients } from "./services/identity/liveness";
import { registerHandlers } from "./bot/handlers";
import { DevService } from "./bot/dev";
import { createLogger } from "./logger";
import { loadConfig } from "./config";

function parseIdSet(env: string | undefined): Set<number> {
  if (!env) return new Set();
  return new Set(
    env
      .split(",")
      .map((s) => parseInt(s.trim(), 10))
      .filter(Boolean),
  );
}

function logPath(dbPath: string): { file: string; absolute: boolean } {
  return {
    file: path.basename(dbPath),
    absolute: path.isAbsolute(dbPath),
  };
}

// ============================================================
// Main Entry Point
// ============================================================

async function main() {
  const config = loadConfig();
  const logger = createLogger(config.logLevel);

  // --- Validate env ---
  const BOT_TOKEN = config.botToken;
  const GEMINI_API_KEY = config.geminiApiKey;
  const DATABASE_PATH = config.databasePath;
  const LICENSE_DATABASE_PATH = config.licenseDatabasePath;
  const OSRM_URL = config.osrmUrl;
  const whitelist = parseIdSet(config.whitelistIds);
  const devIds = parseIdSet(config.devIds);
  const altCount = config.altCount;

  // --- Initialize services ---
  logger.info("app_starting", {
    database: logPath(DATABASE_PATH),
    licenseDatabase: logPath(LICENSE_DATABASE_PATH),
    osrmUrl: OSRM_URL,
    geminiModel: config.geminiModel,
    whitelistEnabled: whitelist.size > 0,
    devModeEnabled: devIds.size > 0,
    altCount,
    awsRegion: config.aws.region,
    livenessPagesConfigured: Boolean(config.aws.livenessPagesUrl),
  });
  const db = initDatabase(DATABASE_PATH);
  logger.info("database_initialized", { database: logPath(DATABASE_PATH) });
  const repo = new Repository(db);

  const sessions = new SessionManager(logger);
  const routing = new RoutingService({ osrmUrl: OSRM_URL, logger });
  const matching = new MatchingService({ repo, routing, logger });
  const licenseLookup = new LicenseLookupService(LICENSE_DATABASE_PATH);
  const carRecognition = new CarRecognitionService({
    geminiApiKey: GEMINI_API_KEY,
    botToken: BOT_TOKEN,
    licenseLookup,
    model: config.geminiModel,
    logger,
  });
  const geocoding = new GeocodingService({ logger });
  const rekognition = new RekognitionClient({ region: config.aws.region });
  const { dynamo, sts } = createAwsClients(config.aws.region);
  const telegramPhotos = new TelegramPhotoService({ botToken: BOT_TOKEN, logger });
  const faceCropLambdaConfig =
    config.aws.faceCropLambdaName && config.aws.watermarkBucket && config.aws.watermarkKey
      ? {
          lambdaClient: new LambdaClient({ region: config.aws.region }),
          functionName: config.aws.faceCropLambdaName,
          watermarkBucket: config.aws.watermarkBucket,
          watermarkKey: config.aws.watermarkKey,
        }
      : undefined;
  const profileFace = new ProfileFaceService({
    rekognition,
    logger,
    thresholds: config.aws.face,
    faceCropLambda: faceCropLambdaConfig,
  });
  const faceLiveness = new FaceLivenessService({
    rekognition,
    sts,
    dynamo,
    logger,
    config: config.aws,
  });
  logger.info("services_initialized");

  // --- Initialize bot ---
  logger.info("bot_initializing");
  const bot = new Telegraf(BOT_TOKEN);

  const dev = devIds.size > 0 ? new DevService() : undefined;
  const devRepo = dev ? new DevRepository(db) : undefined;

  registerHandlers({
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
    options: {
      whitelist: whitelist.size > 0 ? whitelist : undefined,
      dev,
      devRepo,
      devIds,
      altCount,
      logger,
    },
  });

  // --- Error handling ---
  bot.catch((err: any, ctx) => {
    logger.error("bot_update_error", {
      updateType: ctx.updateType,
      telegramId: ctx.from?.id,
      err,
    });
    ctx.reply("Something went wrong. Please try again.").catch(() => {});
  });

  // --- Graceful shutdown ---
  const shutdown = (signal: string) => {
    logger.info("shutdown_started", { signal });
    bot.stop(signal);
    licenseLookup.close();
    db.close();
    logger.info("shutdown_completed", { signal });
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // --- Launch ---
  logger.info("bot_launching");
  await bot.launch();
  logger.info("bot_running");
}

main().catch((err) => {
  createLogger().error("fatal_error", { err });
  process.exit(1);
});
