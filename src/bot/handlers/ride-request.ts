import { Markup } from "telegraf";
import type { Telegraf, Context } from "telegraf";
import type { BotDeps } from "../deps";
import { mainMenuKeyboard, resolveLocation } from "../ui";

export function registerRideRequestHandlers(bot: Telegraf, deps: BotDeps): void {
  const { repo, sessions, notify } = deps;

  bot.command("ride", async (ctx) => {
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) {
      await ctx.reply("You need to register first.", mainMenuKeyboard());
      return;
    }

    sessions.setScene(telegramId, "request_pickup", {});
    await ctx.reply(`Where do you need to be picked up?\n\n📍 Drop a pin or type an address.`);
  });

  bot.action("menu_ride", async (ctx) => {
    await ctx.answerCbQuery();
    const telegramId = ctx.from!.id;
    const session = sessions.get(telegramId);

    if (!session.userId) {
      await ctx.reply("You need to register first.");
      return;
    }

    sessions.setScene(telegramId, "request_pickup", {});
    await ctx.reply(`Where do you need to be picked up?\n\n📍 Drop a pin or type an address.`);
  });

  // --- Ride request: time window selection ---
  for (const [action, windowMinutes] of [
    ["req_time_30", 30],
    ["req_time_60", 60],
    ["req_time_120", 120],
  ] as const) {
    bot.action(action, async (ctx) => {
      await ctx.answerCbQuery();
      const telegramId = ctx.from!.id;
      const session = sessions.get(telegramId);
      if (!session.userId) return;

      const { matching } = deps;
      const now = new Date();
      const latest = new Date(now.getTime() + windowMinutes * 60 * 1000);

      const request = repo.createRideRequest({
        riderId: session.userId,
        pickupLat: session.data.pickupLat,
        pickupLng: session.data.pickupLng,
        dropoffLat: session.data.dropoffLat,
        dropoffLng: session.data.dropoffLng,
        pickupLabel: session.data.pickupLabel,
        dropoffLabel: session.data.dropoffLabel,
        earliestDeparture: now.toISOString(),
        latestDeparture: latest.toISOString(),
      });

      await ctx.editMessageText("Searching for drivers... 🔍");

      const candidates = await matching.findDriversForRider(request);
      sessions.reset(telegramId);

      if (candidates.length === 0) {
        await ctx.reply(
          "No drivers on your route right now.\n\n" +
            "Your request is saved — I'll notify you when a driver posts a matching ride. 🔔",
        );
        return;
      }

      let notified = 0;
      for (const c of candidates) {
        const driver = repo.getUserById(c.ride.driverId);
        if (!driver) continue;
        try {
          await notify(
            driver.telegramId,
            `🆕 New rider on your route!\n\n` +
              `📍 Pickup: ${request.pickupLabel}\n` +
              `📍 Dropoff: ${request.dropoffLabel}`,
            Markup.inlineKeyboard([
              [Markup.button.callback("Review riders →", "review_riders")],
            ]) as any,
          );
          notified++;
        } catch {
          // Driver may not have started the bot
        }
      }

      await ctx.reply(
        `Your request is posted! ✅\n\n` +
          `Found ${candidates.length} driver${candidates.length > 1 ? "s" : ""} on your route. ` +
          `${notified > 0 ? `I've notified them.` : ""}\n\n` +
          `You'll get a message here when a driver accepts.`,
      );
    });
  }
}

export async function handleRideRequestMessage(ctx: Context, deps: BotDeps): Promise<boolean> {
  const telegramId = ctx.from!.id;
  const { sessions, geocoding } = deps;
  const session = sessions.get(telegramId);
  const msg = (ctx as any).message;

  // --- Ride request: pickup location ---
  if (session.scene === "request_pickup") {
    const loc = await resolveLocation(msg, geocoding);
    if (!loc) {
      if ("location" in msg || "text" in msg) {
        await ctx.reply(
          "Couldn't find that address. Try a more specific address, or send a location pin.",
        );
      } else {
        await ctx.reply("Send a location pin or type an address.");
      }
      return true;
    }

    sessions.updateData(telegramId, {
      pickupLat: loc.lat,
      pickupLng: loc.lng,
      pickupLabel: loc.label,
    });
    sessions.setScene(telegramId, "request_dropoff");
    await ctx.reply(
      "Got it. Where do you need to be dropped off?\n\n📍 Drop a pin or type an address.",
    );
    return true;
  }

  // --- Ride request: dropoff location ---
  if (session.scene === "request_dropoff") {
    const loc = await resolveLocation(msg, geocoding);
    if (!loc) {
      if ("location" in msg || "text" in msg) {
        await ctx.reply(
          "Couldn't find that address. Try a more specific address, or send a location pin.",
        );
      } else {
        await ctx.reply("Send a location pin or type an address.");
      }
      return true;
    }

    sessions.updateData(telegramId, {
      dropoffLat: loc.lat,
      dropoffLng: loc.lng,
      dropoffLabel: loc.label,
    });
    sessions.setScene(telegramId, "request_time");
    await ctx.reply(
      `${session.data.pickupLabel} → ${loc.label}\n\nWhen do you need a ride?`,
      Markup.inlineKeyboard([
        [Markup.button.callback("Within 30 minutes", "req_time_30")],
        [Markup.button.callback("Within 1 hour", "req_time_60")],
        [Markup.button.callback("Within 2 hours", "req_time_120")],
      ]),
    );
    return true;
  }

  return false;
}
