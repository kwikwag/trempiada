import "dotenv/config";
import path from "path";
import { Telegraf } from "telegraf";
import { initDatabase } from "./db/migrate";
import { Repository } from "./db/repository";
import { SessionManager } from "./bot/session";
import { RoutingService } from "./services/routing";
import { MatchingService } from "./services/matching";
import { CarRecognitionService } from "./services/car-recognition";
import { LicenseLookupService } from "./services/license-lookup";
import { GeocodingService } from "./services/geocoding";
import { registerHandlers } from "./bot/handlers";
import { DevService } from "./bot/dev";
import { createLogger } from "./logger";

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
  const logger = createLogger();

  // --- Validate env ---
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
  const DATABASE_PATH = process.env.DATABASE_PATH || "./data/rides.db";
  const LICENSE_DATABASE_PATH = process.env.LICENSE_DATABASE_PATH || "./data/licenses.db";
  const OSRM_URL = process.env.OSRM_URL || "http://localhost:5000";
  const whitelist = parseIdSet(process.env.WHITELIST_IDS);
  const devIds = parseIdSet(process.env.DEV_IDS);
  const altCount = parseInt(process.env.ALT_COUNT ?? "2", 10);

  if (!BOT_TOKEN) {
    logger.error("missing_required_env", { variable: "BOT_TOKEN" });
    process.exit(1);
  }
  if (!GEMINI_API_KEY) {
    logger.error("missing_required_env", { variable: "GEMINI_API_KEY" });
    process.exit(1);
  }

  // --- Initialize services ---
  logger.info("app_starting", {
    database: logPath(DATABASE_PATH),
    licenseDatabase: logPath(LICENSE_DATABASE_PATH),
    osrmUrl: OSRM_URL,
    geminiModel: process.env.GEMINI_MODEL ?? "gemini-2.5-flash-lite",
    whitelistEnabled: whitelist.size > 0,
    devModeEnabled: devIds.size > 0,
    altCount,
  });
  const db = initDatabase(DATABASE_PATH);
  logger.info("database_initialized", { database: logPath(DATABASE_PATH) });
  const repo = new Repository(db);

  const sessions = new SessionManager(logger);
  const routing = new RoutingService(OSRM_URL, logger);
  const matching = new MatchingService(repo, routing, logger);
  const licenseLookup = new LicenseLookupService(LICENSE_DATABASE_PATH);
  const carRecognition = new CarRecognitionService(
    GEMINI_API_KEY,
    BOT_TOKEN,
    licenseLookup,
    process.env.GEMINI_MODEL,
    logger,
  );
  const geocoding = new GeocodingService(undefined, undefined, logger);
  logger.info("services_initialized");

  // --- Initialize bot ---
  logger.info("bot_initializing");
  const bot = new Telegraf(BOT_TOKEN);

  const dev = devIds.size > 0 ? new DevService() : undefined;

  registerHandlers(bot, repo, sessions, matching, routing, carRecognition, geocoding, {
    whitelist: whitelist.size > 0 ? whitelist : undefined,
    dev,
    devIds,
    altCount,
    logger,
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
