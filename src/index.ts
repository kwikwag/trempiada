import "dotenv/config";
import { Telegraf } from "telegraf";
import { initDatabase } from "./db/migrate";
import { Repository } from "./db/repository";
import { SessionManager } from "./bot/session";
import { RoutingService } from "./services/routing";
import { MatchingService } from "./services/matching";
import { CarRecognitionService } from "./services/car-recognition";
import { GeocodingService } from "./services/geocoding";
import { registerHandlers } from "./bot/handlers";

// ============================================================
// TrempBot — Main Entry Point
// ============================================================

async function main() {
  // --- Validate env ---
  const BOT_TOKEN = process.env.BOT_TOKEN;
  const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  const DATABASE_PATH = process.env.DATABASE_PATH || "./data/trempbot.db";
  const OSRM_URL = process.env.OSRM_URL || "http://localhost:5000";

  if (!BOT_TOKEN) {
    console.error("BOT_TOKEN is required. Set it in .env");
    process.exit(1);
  }
  if (!ANTHROPIC_API_KEY) {
    console.error("ANTHROPIC_API_KEY is required. Set it in .env");
    process.exit(1);
  }

  // --- Initialize services ---
  console.log("Initializing database...");
  const db = initDatabase(DATABASE_PATH);
  const repo = new Repository(db);

  const sessions = new SessionManager();
  const routing = new RoutingService(OSRM_URL);
  const matching = new MatchingService(repo, routing);
  const carRecognition = new CarRecognitionService(ANTHROPIC_API_KEY, BOT_TOKEN);
  const geocoding = new GeocodingService();

  // --- Initialize bot ---
  console.log("Starting bot...");
  const bot = new Telegraf(BOT_TOKEN);

  registerHandlers(bot, repo, sessions, matching, routing, carRecognition, geocoding);

  // --- Error handling ---
  bot.catch((err: any, ctx) => {
    console.error(`Error for ${ctx.updateType}:`, err);
    ctx.reply("Something went wrong. Please try again.").catch(() => {});
  });

  // --- Graceful shutdown ---
  const shutdown = (signal: string) => {
    console.log(`\n${signal} received. Shutting down...`);
    bot.stop(signal);
    db.close();
    process.exit(0);
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));

  // --- Launch ---
  await bot.launch();
  console.log("TrempBot is running! 🚗");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
