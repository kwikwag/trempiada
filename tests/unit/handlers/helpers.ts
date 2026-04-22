import { initDatabase } from "../../../src/db/migrate";
import { Repository } from "../../../src/db/repository";
import { noopLogger } from "../../../src/logger";
import { SessionManager } from "../../../src/bot/session";
import type { BotDeps } from "../../../src/bot/deps";

type Handler = (ctx: any) => Promise<void> | void;

export class FakeBot {
  actions = new Map<string, Handler>();

  action(trigger: string | RegExp, handler: Handler): this {
    if (typeof trigger === "string") {
      this.actions.set(trigger, handler);
    }
    return this;
  }

  command(): this {
    return this;
  }

  start(): this {
    return this;
  }
}

export interface FakeCtx {
  from: { id: number; first_name: string };
  message?: any;
  replies: Array<{ text: string; extra: any }>;
  edits: Array<{ text: string; extra: any }>;
  answerCbQueryCalls: unknown[];
  reply: (text: string, extra?: any) => Promise<void>;
  editMessageText: (text: string, extra?: any) => Promise<void>;
  answerCbQuery: (message?: unknown) => Promise<void>;
}

export function makeCtx({ telegramId, message }: { telegramId: number; message?: any }): FakeCtx {
  const ctx: FakeCtx = {
    from: { id: telegramId, first_name: "Test" },
    message,
    replies: [],
    edits: [],
    answerCbQueryCalls: [],
    async reply(text: string, extra?: any) {
      this.replies.push({ text, extra });
    },
    async editMessageText(text: string, extra?: any) {
      this.edits.push({ text, extra });
    },
    async answerCbQuery(message?: unknown) {
      this.answerCbQueryCalls.push(message);
    },
  };

  return ctx;
}

export function createDeps(): { repo: Repository; sessions: SessionManager; deps: BotDeps } {
  const repo = new Repository(initDatabase(":memory:"));
  const sessions = new SessionManager(noopLogger);
  const deps: BotDeps = {
    repo,
    sessions,
    matching: {} as any,
    routing: {} as any,
    carRecognition: {} as any,
    geocoding: {} as any,
    notify: async () => undefined,
    logger: noopLogger,
  };

  return { repo, sessions, deps };
}

export function inlineButtonTexts(extra: any): string[] {
  return (
    extra?.reply_markup?.inline_keyboard?.flat().map((button: { text: string }) => button.text) ??
    []
  );
}
