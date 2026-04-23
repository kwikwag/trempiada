import { initDatabase } from "../../../src/db/migrate";
import { Repository } from "../../../src/db/repository";
import { noopLogger } from "../../../src/logger";
import { SessionManager } from "../../../src/bot/session";
import type { BotDeps } from "../../../src/bot/deps";

type Handler = (ctx: any) => Promise<void> | void;
type Middleware = (ctx: any, next: () => Promise<void>) => Promise<void> | void;

export class FakeBot {
  actions = new Map<string, Handler>();
  middlewares: Middleware[] = [];
  handlers = new Map<string, Handler>();
  telegram = {
    async setMyCommands() {
      return undefined;
    },
    async sendMessage() {
      return undefined;
    },
  };

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

  use(middleware: Middleware): this {
    this.middlewares.push(middleware);
    return this;
  }

  on(event: string, handler: Handler): this {
    this.handlers.set(event, handler);
    return this;
  }

  async emit(event: string, ctx: any): Promise<void> {
    const handler = this.handlers.get(event);
    const stack = [...this.middlewares];
    if (handler) {
      stack.push(async (innerCtx, next) => {
        await handler(innerCtx);
        await next();
      });
    }

    let index = -1;
    const dispatch = async (nextIndex: number): Promise<void> => {
      if (nextIndex <= index) throw new Error("next() called multiple times");
      index = nextIndex;
      const fn = stack[nextIndex];
      if (!fn) return;
      await fn(ctx, () => dispatch(nextIndex + 1));
    };

    await dispatch(0);
  }
}

export interface FakeCtx {
  from: { id: number; first_name: string };
  message?: any;
  update?: any;
  updateType?: string;
  telegram?: any;
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
    update: { update_id: 1, message },
    updateType: message ? "message" : undefined,
    telegram: {
      async getUserProfilePhotos() {
        return { total_count: 0, photos: [] };
      },
    },
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
