import type { BotScene, SessionState } from "../types";

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

  get(telegramId: number): SessionState {
    if (!this.sessions.has(telegramId)) {
      this.sessions.set(telegramId, {
        scene: "idle",
        userId: null,
        data: {},
      });
    }
    return this.sessions.get(telegramId)!;
  }

  setScene(telegramId: number, scene: BotScene, data?: Record<string, any>): void {
    const session = this.get(telegramId);
    session.scene = scene;
    if (data !== undefined) {
      session.data = data;
    }
  }

  updateData(telegramId: number, updates: Record<string, any>): void {
    const session = this.get(telegramId);
    session.data = { ...session.data, ...updates };
  }

  setUserId(telegramId: number, userId: number): void {
    const session = this.get(telegramId);
    session.userId = userId;
  }

  reset(telegramId: number): void {
    const session = this.get(telegramId);
    session.scene = "idle";
    session.data = {};
  }

  /** Check if user is in message relay mode (active ride) */
  isInRelay(telegramId: number): boolean {
    return this.get(telegramId).scene === "in_ride_relay";
  }
}
