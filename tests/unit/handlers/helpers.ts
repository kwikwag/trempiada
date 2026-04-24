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
  photoReplies: Array<{ photo: any; extra: any }>;
  edits: Array<{ text: string; extra: any }>;
  captionEdits: Array<{ caption: string; extra: any }>;
  answerCbQueryCalls: unknown[];
  reply: (text: string, extra?: any) => Promise<void>;
  replyWithPhoto: (photo: any, extra?: any) => Promise<any>;
  editMessageText: (text: string, extra?: any) => Promise<void>;
  editMessageCaption: (caption: string, extra?: any) => Promise<void>;
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
    photoReplies: [],
    edits: [],
    captionEdits: [],
    answerCbQueryCalls: [],
    async reply(text: string, extra?: any) {
      this.replies.push({ text, extra });
    },
    async replyWithPhoto(photo: any, extra?: any) {
      this.photoReplies.push({ photo, extra });
      return {
        photo: [{ file_id: "generated-small" }, { file_id: "generated-photo-file" }],
      };
    },
    async editMessageText(text: string, extra?: any) {
      this.edits.push({ text, extra });
    },
    async editMessageCaption(caption: string, extra?: any) {
      this.captionEdits.push({ caption, extra });
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
    telegramPhotos: {
      downloadByFileId: async () => ({
        filePath: "photo.jpg",
        mimeType: "image/jpeg",
        buffer: Buffer.from([0xff, 0xd8, 0xff]),
      }),
    } as any,
    profileFace: {
      validateAndCropPhoto: async () => ({
        ok: true,
        croppedBuffer: Buffer.from([0xff, 0xd8, 0xff]),
        mimeType: "image/jpeg",
      }),
    } as any,
    faceLiveness: {
      createAttempt: async () => ({
        sessionId: "session-1",
        token: "token-1",
        url: "https://example.com/liveness?token=token-1",
        expiresAt: Math.floor(Date.now() / 1000) + 180,
        profilePhotoFileId: "photo-file-id",
      }),
      pollForResult: async () => ({
        status: "succeeded",
        confidence: 99,
        similarity: 99,
        userMessage: "Face liveness check complete. You're verified for this photo.",
      }),
    } as any,
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
