import { Telegraf, Markup } from "telegraf";
import type { Context } from "telegraf";
import type { SessionManager } from "./session";
import type { DevRepository } from "../db/dev-repository";

// Synthetic Telegram IDs for alt personas. Above the real Telegram ID range.
const ALT_BASE_ID = 9_000_000_000;

export class DevService {
  private activeAlt = new Map<number, number>(); // realId → altId
  private altChats = new Map<number, number>(); // altId → realChatId

  getEffectiveId(realId: number): number {
    return this.activeAlt.get(realId) ?? realId;
  }

  setAlt(realId: number, altIndex: number | null): void {
    if (altIndex === null) {
      this.activeAlt.delete(realId);
    } else {
      this.activeAlt.set(realId, ALT_BASE_ID + altIndex);
    }
  }

  /** Called by the impersonation middleware each turn to keep the routing table fresh. */
  registerChat(altId: number, realChatId: number): void {
    this.altChats.set(altId, realChatId);
  }

  /** Returns the real chat ID to deliver a message to, given any user ID. */
  resolveChat(targetId: number): number {
    return this.altChats.get(targetId) ?? targetId;
  }

  isAlt(id: number): boolean {
    return id >= ALT_BASE_ID;
  }

  /** Prefix to prepend to messages delivered to an alt's real chat. */
  labelFor(id: number): string {
    return this.isAlt(id) ? `[🎭 Alt ${id - ALT_BASE_ID}] ` : "";
  }

  getActiveAltIndex(realId: number): number | null {
    const eff = this.activeAlt.get(realId);
    return eff !== undefined ? eff - ALT_BASE_ID : null;
  }

  resetAltSessions(sessions: SessionManager, altCount: number): void {
    for (let i = 1; i <= altCount; i++) {
      sessions.reset(ALT_BASE_ID + i);
    }
  }
}

export function registerDevHandlers(
  bot: Telegraf,
  dev: DevService,
  devIds: Set<number>,
  sessions: SessionManager,
  devRepo: DevRepository,
  altCount: number,
  whitelist?: Set<number>,
): void {
  function getRealId(ctx: Context): number {
    return (ctx as any).__realTelegramId ?? ctx.from!.id;
  }

  function getEffectiveId(ctx: Context): number {
    return ctx.from!.id;
  }

  function labelForEffectiveId(dev: DevService, realId: number, effectiveId: number): string {
    if (effectiveId === realId) return "Self";
    return dev.labelFor(effectiveId).trim() || String(effectiveId);
  }

  async function showDevMenu(ctx: Context, realId: number): Promise<void> {
    const activeIndex = dev.getActiveAltIndex(realId);
    const label = activeIndex === null ? "Self" : `Alt ${activeIndex}`;

    const selfButton = Markup.button.callback(
      activeIndex === null ? "👤 Self ✓" : "👤 Self",
      "dev_self",
    );
    const altButtons = Array.from({ length: altCount }, (_, i) => {
      const n = i + 1;
      const active = activeIndex === n;
      return Markup.button.callback(active ? `🎭 Alt ${n} ✓` : `Alt ${n}`, `dev_alt_${n}`);
    });

    await ctx.reply(`🛠 *Dev Tools*\nActing as: *${label}*`, {
      parse_mode: "Markdown",
      ...Markup.inlineKeyboard([
        [selfButton, ...altButtons],
        [Markup.button.callback("🗑 Reset alt sessions", "dev_reset")],
        [Markup.button.callback("Delete current identity data", "dev_delete_current")],
      ]),
    });
  }

  if (whitelist) {
    bot.command("whitelist", async (ctx) => {
      const realId = getRealId(ctx);
      if (!devIds.has(realId)) return;
      const arg = ctx.message.text.split(/\s+/)[1];
      const id = Number(arg);
      if (!arg || !Number.isInteger(id) || id <= 0) {
        await ctx.reply("Usage: /whitelist <telegram_id>");
        return;
      }
      whitelist.add(id);
      await ctx.reply(`✅ Added ${id} to whitelist (${whitelist.size} total). Restart to persist.`);
    });
  }

  bot.command("dev", async (ctx) => {
    const realId = getRealId(ctx);
    if (!devIds.has(realId)) return;
    await showDevMenu(ctx, realId);
  });

  bot.action("dev_self", async (ctx) => {
    await ctx.answerCbQuery();
    const realId = getRealId(ctx);
    if (!devIds.has(realId)) return;
    dev.setAlt(realId, null);
    await ctx.editMessageText("✅ Now acting as: *Self*", { parse_mode: "Markdown" });
  });

  for (let n = 1; n <= altCount; n++) {
    const index = n;
    bot.action(`dev_alt_${index}`, async (ctx) => {
      await ctx.answerCbQuery();
      const realId = getRealId(ctx);
      if (!devIds.has(realId)) return;
      dev.setAlt(realId, index);
      await ctx.editMessageText(`✅ Now acting as: *Alt ${index}*`, { parse_mode: "Markdown" });
    });
  }

  bot.action("dev_reset", async (ctx) => {
    await ctx.answerCbQuery();
    const realId = getRealId(ctx);
    if (!devIds.has(realId)) return;
    dev.resetAltSessions(sessions, altCount);
    await ctx.editMessageText("✅ Alt sessions cleared.");
  });

  bot.action("dev_delete_current", async (ctx) => {
    await ctx.answerCbQuery();
    const realId = getRealId(ctx);
    if (!devIds.has(realId)) return;

    const effectiveId = getEffectiveId(ctx);
    const label = labelForEffectiveId(dev, realId, effectiveId);
    await ctx.reply(
      `Delete all database rows and session data for ${label} (${effectiveId})?\n\n` +
        "This is a dev-only hard delete and cannot be undone.",
      {
        ...Markup.inlineKeyboard([
          [Markup.button.callback("Yes, delete permanently", `dev_delete_confirm_${effectiveId}`)],
          [Markup.button.callback("Cancel", "dev_delete_cancel")],
        ]),
      },
    );
  });

  bot.action(/^dev_delete_confirm_(\d+)$/, async (ctx) => {
    await ctx.answerCbQuery();
    const realId = getRealId(ctx);
    if (!devIds.has(realId)) return;

    const targetId = Number.parseInt(ctx.match![1], 10);
    const label = labelForEffectiveId(dev, realId, targetId);
    const deleted = devRepo.hardDeleteUserByTelegramId(targetId);
    sessions.reset(targetId);

    await ctx.editMessageText(
      deleted
        ? `✅ Deleted all data for ${label} (${targetId}). Start with /start.`
        : `No database user found for ${label} (${targetId}). Session was reset.`,
    );
  });

  bot.action("dev_delete_cancel", async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText("Delete cancelled.");
  });
}
