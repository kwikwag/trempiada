import type Database from "better-sqlite3";

interface UserIdRow {
  id: number;
}

/**
 * Dev-only data access for destructive reset operations.
 * Keep this separate from Repository so unsafe helpers are not available to normal bot flows.
 */
export class DevRepository {
  constructor(private db: Database.Database) {}

  /**
   * Hard delete a test identity by Telegram ID.
   * Removes the user row and every dependent row that can reference it.
   */
  hardDeleteUserByTelegramId(telegramId: number): boolean {
    return this.db.transaction(() => {
      const user = this.db
        .prepare<[number], UserIdRow>("SELECT id FROM users WHERE telegram_id = ?")
        .get(telegramId);
      if (!user) return false;

      this.db
        .prepare(
          `
        UPDATE rides SET status = 'cancelled'
        WHERE id IN (
          SELECT ride_id FROM matches
          WHERE driver_id = ? OR rider_id = ? OR cancelled_by = ?
        )
      `,
        )
        .run(user.id, user.id, user.id);

      this.db
        .prepare(
          `
        UPDATE ride_requests SET status = 'cancelled'
        WHERE id IN (
          SELECT request_id FROM matches
          WHERE driver_id = ? OR rider_id = ? OR cancelled_by = ?
        )
      `,
        )
        .run(user.id, user.id, user.id);

      this.db
        .prepare(
          `
        DELETE FROM disputes
        WHERE reporter_id = ?
           OR match_id IN (
             SELECT id FROM matches
             WHERE driver_id = ? OR rider_id = ? OR cancelled_by = ?
           )
      `,
        )
        .run(user.id, user.id, user.id, user.id);

      this.db
        .prepare(
          `
        DELETE FROM ratings
        WHERE rater_id = ?
           OR rated_id = ?
           OR match_id IN (
             SELECT id FROM matches
             WHERE driver_id = ? OR rider_id = ? OR cancelled_by = ?
           )
      `,
        )
        .run(user.id, user.id, user.id, user.id, user.id);

      this.db
        .prepare("DELETE FROM matches WHERE driver_id = ? OR rider_id = ? OR cancelled_by = ?")
        .run(user.id, user.id, user.id);
      this.db.prepare("DELETE FROM ride_requests WHERE rider_id = ?").run(user.id);
      this.db.prepare("DELETE FROM rides WHERE driver_id = ?").run(user.id);
      this.db.prepare("DELETE FROM cars WHERE user_id = ?").run(user.id);
      this.db.prepare("DELETE FROM trust_verifications WHERE user_id = ?").run(user.id);
      this.db.prepare("DELETE FROM users WHERE id = ?").run(user.id);

      return true;
    })();
  }
}
