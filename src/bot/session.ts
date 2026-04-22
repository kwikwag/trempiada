import type { BotScene, SessionState } from "../types";
import type { Logger } from "../logger";
import { noopLogger } from "../logger";

/**
 * In-memory session store for bot conversation state.
 * Keyed by Telegram user ID.
 *
 * This is intentionally simple — sessions are ephemeral and
 * losing them on restart just means users re-enter their current
 * flow. No persistence needed.
 */
export class SessionManager {
  private sessions = new Map<number, SessionState>();

  constructor(private logger: Logger = noopLogger) {}

  get(telegramId: number): SessionState {
    if (!this.sessions.has(telegramId)) {
      this.sessions.set(telegramId, {
        scene: "idle",
        userId: null,
        data: {},
      });
      this.logger.debug("session_created", { telegramId });
    }
    return this.sessions.get(telegramId)!;
  }

  setScene(telegramId: number, scene: BotScene, data?: Record<string, any>): void {
    const session = this.get(telegramId);
    const previousScene = session.scene;
    session.scene = scene;
    if (data !== undefined) {
      session.data = data;
    }
    this.logger.debug("session_scene_changed", {
      telegramId,
      userId: session.userId,
      previousScene,
      scene,
      dataKeys: Object.keys(session.data),
    });
  }

  updateData(telegramId: number, updates: Record<string, any>): void {
    const session = this.get(telegramId);
    session.data = { ...session.data, ...updates };
    this.logger.debug("session_data_updated", {
      telegramId,
      userId: session.userId,
      scene: session.scene,
      updateKeys: Object.keys(updates),
      dataKeys: Object.keys(session.data),
    });
  }

  setUserId(telegramId: number, userId: number): void {
    const session = this.get(telegramId);
    session.userId = userId;
    this.logger.debug("session_user_bound", {
      telegramId,
      userId,
      scene: session.scene,
    });
  }

  reset(telegramId: number): void {
    const session = this.get(telegramId);
    const previousScene = session.scene;
    session.scene = "idle";
    session.data = {};
    this.logger.debug("session_reset", {
      telegramId,
      userId: session.userId,
      previousScene,
    });
  }

  /** Check if user is in message relay mode (active ride) */
  isInRelay(telegramId: number): boolean {
    return this.get(telegramId).scene === "in_ride_relay";
  }
}
