import Database from "better-sqlite3";
import type {
  User, Car, Ride, RideRequest, Match, Rating,
  TrustVerification, Dispute, Gender, VerificationType,
  CancellationReason, MatchStatus, RideStatus, RequestStatus,
  POINTS, DEFAULTS,
} from "../types";

/**
 * Data access layer — thin wrapper over SQLite queries.
 * Every public method is a single prepared statement or small transaction.
 */
export class Repository {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
  }

  // ---- Users ----

  createUser(telegramId: number, firstName: string): User {
    const stmt = this.db.prepare(`
      INSERT INTO users (telegram_id, first_name, points_balance)
      VALUES (?, ?, 5.0)
      RETURNING *
    `);
    return this.mapUser(stmt.get(telegramId, firstName) as any);
  }

  getUserByTelegramId(telegramId: number): User | null {
    const stmt = this.db.prepare("SELECT * FROM users WHERE telegram_id = ?");
    const row = stmt.get(telegramId) as any;
    return row ? this.mapUser(row) : null;
  }

  getUserById(id: number): User | null {
    const stmt = this.db.prepare("SELECT * FROM users WHERE id = ?");
    const row = stmt.get(id) as any;
    return row ? this.mapUser(row) : null;
  }

  updateUserProfile(
    userId: number,
    updates: {
      firstName?: string;
      gender?: Gender;
      photoFileId?: string;
      phone?: string;
    }
  ): void {
    const fields: string[] = [];
    const values: any[] = [];

    if (updates.firstName !== undefined) { fields.push("first_name = ?"); values.push(updates.firstName); }
    if (updates.gender !== undefined) { fields.push("gender = ?"); values.push(updates.gender); }
    if (updates.photoFileId !== undefined) { fields.push("photo_file_id = ?"); values.push(updates.photoFileId); }
    if (updates.phone !== undefined) { fields.push("phone = ?"); values.push(updates.phone); }

    if (fields.length === 0) return;
    values.push(userId);

    this.db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  adjustPoints(userId: number, delta: number): void {
    this.db.prepare("UPDATE users SET points_balance = points_balance + ? WHERE id = ?")
      .run(delta, userId);
  }

  getPointsBalance(userId: number): number {
    const row = this.db.prepare("SELECT points_balance FROM users WHERE id = ?").get(userId) as any;
    return row?.points_balance ?? 0;
  }

  incrementRideCount(userId: number, role: "driver" | "rider"): void {
    const col = role === "driver" ? "total_rides_as_driver" : "total_rides_as_rider";
    this.db.prepare(`UPDATE users SET ${col} = ${col} + 1 WHERE id = ?`).run(userId);
  }

  updateAvgRating(userId: number, role: "driver" | "rider"): void {
    const col = role === "driver" ? "avg_rating_as_driver" : "avg_rating_as_rider";
    // Compute from all ratings where this user was rated in matching role
    const avg = this.db.prepare(`
      SELECT AVG(r.score) as avg_score
      FROM ratings r
      JOIN matches m ON r.match_id = m.id
      WHERE r.rated_id = ?
        AND ${role === "driver" ? "m.driver_id" : "m.rider_id"} = ?
    `).get(userId, userId) as any;

    this.db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`)
      .run(avg?.avg_score ?? null, userId);
  }

  suspendUser(userId: number): void {
    this.db.prepare("UPDATE users SET is_suspended = 1 WHERE id = ?").run(userId);
  }

  // ---- Trust Verifications ----

  addVerification(
    userId: number,
    type: VerificationType,
    externalRef: string | null = null,
    sharedWithRiders: boolean = true
  ): void {
    this.db.prepare(`
      INSERT INTO trust_verifications (user_id, type, external_ref, shared_with_riders)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, type) DO UPDATE SET
        external_ref = excluded.external_ref,
        shared_with_riders = excluded.shared_with_riders,
        verified_at = datetime('now')
    `).run(userId, type, externalRef, sharedWithRiders ? 1 : 0);

    this.recalcTrustScore(userId);
  }

  setVerificationVisibility(userId: number, type: VerificationType, shared: boolean): void {
    this.db.prepare(`
      UPDATE trust_verifications SET shared_with_riders = ? WHERE user_id = ? AND type = ?
    `).run(shared ? 1 : 0, userId, type);
  }

  getVerifications(userId: number): TrustVerification[] {
    const rows = this.db.prepare(
      "SELECT * FROM trust_verifications WHERE user_id = ?"
    ).all(userId) as any[];
    return rows.map(this.mapVerification);
  }

  /** Get only verifications the user chose to share (shown to riders) */
  getPublicVerifications(userId: number): TrustVerification[] {
    const rows = this.db.prepare(
      "SELECT * FROM trust_verifications WHERE user_id = ? AND shared_with_riders = 1"
    ).all(userId) as any[];
    return rows.map(this.mapVerification);
  }

  getVerificationCount(userId: number): number {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM trust_verifications WHERE user_id = ?"
    ).get(userId) as any;
    return row?.cnt ?? 0;
  }

  private recalcTrustScore(userId: number): void {
    // Simple weighted score: each verification type has a weight,
    // plus average rating contributes
    const verifications = this.getVerifications(userId);
    const weights: Record<VerificationType, number> = {
      phone: 1, photo: 1, car: 1,
      facebook: 2, linkedin: 2, google: 1.5, email: 1,
    };

    let score = verifications.reduce((sum, v) => sum + (weights[v.type] || 0), 0);

    const user = this.getUserById(userId);
    if (user?.avgRatingAsDriver && user.totalRidesAsDriver >= 3) {
      score += user.avgRatingAsDriver; // Add up to 5 points from ratings
    }

    this.db.prepare("UPDATE users SET trust_score = ? WHERE id = ?").run(score, userId);
  }

  // ---- Cars ----

  addCar(
    userId: number,
    plateNumber: string,
    make: string,
    model: string,
    color: string,
    year: number | null,
    seatCount: number,
    photoFileId: string | null
  ): Car {
    // Deactivate other cars for this user
    this.db.prepare("UPDATE cars SET is_active = 0 WHERE user_id = ?").run(userId);

    const stmt = this.db.prepare(`
      INSERT INTO cars (user_id, plate_number, make, model, color, year, seat_count, photo_file_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);
    return this.mapCar(
      stmt.get(userId, plateNumber, make, model, color, year, seatCount, photoFileId) as any
    );
  }

  getActiveCar(userId: number): Car | null {
    const row = this.db.prepare(
      "SELECT * FROM cars WHERE user_id = ? AND is_active = 1"
    ).get(userId) as any;
    return row ? this.mapCar(row) : null;
  }

  // ---- Rides ----

  createRide(ride: Omit<Ride, "id" | "status" | "createdAt">): Ride {
    const stmt = this.db.prepare(`
      INSERT INTO rides (
        driver_id, car_id, origin_lat, origin_lng, dest_lat, dest_lng,
        origin_label, dest_label, route_geometry, estimated_duration,
        departure_time, max_detour_minutes, available_seats
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);
    return this.mapRide(stmt.get(
      ride.driverId, ride.carId,
      ride.originLat, ride.originLng, ride.destLat, ride.destLng,
      ride.originLabel, ride.destLabel,
      ride.routeGeometry, ride.estimatedDuration,
      ride.departureTime, ride.maxDetourMinutes, ride.availableSeats,
    ) as any);
  }

  updateRideStatus(rideId: number, status: RideStatus): void {
    this.db.prepare("UPDATE rides SET status = ? WHERE id = ?").run(status, rideId);
  }

  getOpenRides(): Ride[] {
    const rows = this.db.prepare(
      "SELECT * FROM rides WHERE status = 'open' ORDER BY departure_time ASC"
    ).all() as any[];
    return rows.map(this.mapRide);
  }

  getRideById(rideId: number): Ride | null {
    const row = this.db.prepare("SELECT * FROM rides WHERE id = ?").get(rideId) as any;
    return row ? this.mapRide(row) : null;
  }

  // ---- Ride Requests ----

  createRideRequest(req: Omit<RideRequest, "id" | "status" | "createdAt">): RideRequest {
    const stmt = this.db.prepare(`
      INSERT INTO ride_requests (
        rider_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
        pickup_label, dropoff_label, earliest_departure, latest_departure
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);
    return this.mapRequest(stmt.get(
      req.riderId,
      req.pickupLat, req.pickupLng, req.dropoffLat, req.dropoffLng,
      req.pickupLabel, req.dropoffLabel,
      req.earliestDeparture, req.latestDeparture,
    ) as any);
  }

  getOpenRequests(): RideRequest[] {
    const rows = this.db.prepare(
      "SELECT * FROM ride_requests WHERE status = 'open' ORDER BY earliest_departure ASC"
    ).all() as any[];
    return rows.map(this.mapRequest);
  }

  updateRequestStatus(requestId: number, status: RequestStatus): void {
    this.db.prepare("UPDATE ride_requests SET status = ? WHERE id = ?").run(status, requestId);
  }

  // ---- Matches ----

  createMatch(match: Omit<Match, "id" | "status" | "cancellationReason" | "cancelledBy" | "pickedUpAt" | "completedAt" | "createdAt">): Match {
    const stmt = this.db.prepare(`
      INSERT INTO matches (
        ride_id, request_id, rider_id, driver_id,
        pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
        detour_seconds, confirmation_code, points_cost
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);
    return this.mapMatch(stmt.get(
      match.rideId, match.requestId, match.riderId, match.driverId,
      match.pickupLat, match.pickupLng, match.dropoffLat, match.dropoffLng,
      match.detourSeconds, match.confirmationCode, match.pointsCost,
    ) as any);
  }

  updateMatchStatus(matchId: number, status: MatchStatus): void {
    const extra = status === "picked_up"
      ? ", picked_up_at = datetime('now')"
      : status === "completed"
        ? ", completed_at = datetime('now')"
        : "";
    this.db.prepare(`UPDATE matches SET status = ?${extra} WHERE id = ?`).run(status, matchId);
  }

  cancelMatch(matchId: number, cancelledBy: number, reason: CancellationReason): void {
    this.db.prepare(`
      UPDATE matches SET status = 'cancelled', cancelled_by = ?, cancellation_reason = ? WHERE id = ?
    `).run(cancelledBy, reason, matchId);
  }

  getActiveMatchForUser(userId: number): Match | null {
    const row = this.db.prepare(`
      SELECT * FROM matches
      WHERE (rider_id = ? OR driver_id = ?)
        AND status IN ('pending', 'accepted', 'picked_up')
      ORDER BY created_at DESC LIMIT 1
    `).get(userId, userId) as any;
    return row ? this.mapMatch(row) : null;
  }

  getMatchById(matchId: number): Match | null {
    const row = this.db.prepare("SELECT * FROM matches WHERE id = ?").get(matchId) as any;
    return row ? this.mapMatch(row) : null;
  }

  /** Anti-gaming: check if same pair rode together recently */
  getRecentSamePairCount(userId1: number, userId2: number, hoursBack: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM matches
      WHERE status = 'completed'
        AND ((driver_id = ? AND rider_id = ?) OR (driver_id = ? AND rider_id = ?))
        AND completed_at > datetime('now', '-' || ? || ' hours')
    `).get(userId1, userId2, userId2, userId1, hoursBack) as any;
    return row?.cnt ?? 0;
  }

  /** Count recent cancellations for anti-abuse */
  getRecentCancellationCount(userId: number, daysBack: number): number {
    const row = this.db.prepare(`
      SELECT COUNT(*) as cnt FROM matches
      WHERE cancelled_by = ?
        AND created_at > datetime('now', '-' || ? || ' days')
    `).get(userId, daysBack) as any;
    return row?.cnt ?? 0;
  }

  // ---- Ratings ----

  addRating(matchId: number, raterId: number, ratedId: number, score: number, comment: string | null): Rating {
    const stmt = this.db.prepare(`
      INSERT INTO ratings (match_id, rater_id, rated_id, score, comment)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `);
    const rating = this.mapRating(stmt.get(matchId, raterId, ratedId, score, comment) as any);

    // Update the rated user's average
    const ratedUser = this.getUserById(ratedId);
    const match = this.getMatchById(matchId);
    if (ratedUser && match) {
      const role = match.driverId === ratedId ? "driver" : "rider";
      this.updateAvgRating(ratedId, role);
    }

    return rating;
  }

  getRatingsForMatch(matchId: number): Rating[] {
    const rows = this.db.prepare(
      "SELECT * FROM ratings WHERE match_id = ?"
    ).all(matchId) as any[];
    return rows.map(this.mapRating);
  }

  bothRated(matchId: number): boolean {
    const row = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM ratings WHERE match_id = ?"
    ).get(matchId) as any;
    return (row?.cnt ?? 0) >= 2;
  }

  // ---- Disputes ----

  createDispute(matchId: number, reporterId: number, description: string): Dispute {
    const stmt = this.db.prepare(`
      INSERT INTO disputes (match_id, reporter_id, description)
      VALUES (?, ?, ?)
      RETURNING *
    `);
    return this.mapDispute(stmt.get(matchId, reporterId, description) as any);
  }

  // ---- Row mappers ----

  private mapUser(row: any): User {
    return {
      id: row.id,
      telegramId: row.telegram_id,
      firstName: row.first_name,
      gender: row.gender,
      photoFileId: row.photo_file_id,
      phone: row.phone,
      pointsBalance: row.points_balance,
      trustScore: row.trust_score,
      totalRidesAsDriver: row.total_rides_as_driver,
      totalRidesAsRider: row.total_rides_as_rider,
      avgRatingAsDriver: row.avg_rating_as_driver,
      avgRatingAsRider: row.avg_rating_as_rider,
      isSuspended: !!row.is_suspended,
      createdAt: row.created_at,
    };
  }

  private mapVerification(row: any): TrustVerification {
    return {
      id: row.id,
      userId: row.user_id,
      type: row.type,
      verified: !!row.verified,
      sharedWithRiders: !!row.shared_with_riders,
      externalRef: row.external_ref,
      verifiedAt: row.verified_at,
    };
  }

  private mapCar(row: any): Car {
    return {
      id: row.id,
      userId: row.user_id,
      plateNumber: row.plate_number,
      make: row.make,
      model: row.model,
      color: row.color,
      year: row.year,
      seatCount: row.seat_count,
      photoFileId: row.photo_file_id,
      isActive: !!row.is_active,
      createdAt: row.created_at,
    };
  }

  private mapRide(row: any): Ride {
    return {
      id: row.id,
      driverId: row.driver_id,
      carId: row.car_id,
      originLat: row.origin_lat,
      originLng: row.origin_lng,
      destLat: row.dest_lat,
      destLng: row.dest_lng,
      originLabel: row.origin_label,
      destLabel: row.dest_label,
      routeGeometry: row.route_geometry,
      estimatedDuration: row.estimated_duration,
      departureTime: row.departure_time,
      maxDetourMinutes: row.max_detour_minutes,
      availableSeats: row.available_seats,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  private mapRequest(row: any): RideRequest {
    return {
      id: row.id,
      riderId: row.rider_id,
      pickupLat: row.pickup_lat,
      pickupLng: row.pickup_lng,
      dropoffLat: row.dropoff_lat,
      dropoffLng: row.dropoff_lng,
      pickupLabel: row.pickup_label,
      dropoffLabel: row.dropoff_label,
      earliestDeparture: row.earliest_departure,
      latestDeparture: row.latest_departure,
      status: row.status,
      createdAt: row.created_at,
    };
  }

  private mapMatch(row: any): Match {
    return {
      id: row.id,
      rideId: row.ride_id,
      requestId: row.request_id,
      riderId: row.rider_id,
      driverId: row.driver_id,
      pickupLat: row.pickup_lat,
      pickupLng: row.pickup_lng,
      dropoffLat: row.dropoff_lat,
      dropoffLng: row.dropoff_lng,
      detourSeconds: row.detour_seconds,
      confirmationCode: row.confirmation_code,
      status: row.status,
      pointsCost: row.points_cost,
      cancellationReason: row.cancellation_reason,
      cancelledBy: row.cancelled_by,
      pickedUpAt: row.picked_up_at,
      completedAt: row.completed_at,
      createdAt: row.created_at,
    };
  }

  private mapRating(row: any): Rating {
    return {
      id: row.id,
      matchId: row.match_id,
      raterId: row.rater_id,
      ratedId: row.rated_id,
      score: row.score,
      comment: row.comment,
      createdAt: row.created_at,
    };
  }

  private mapDispute(row: any): Dispute {
    return {
      id: row.id,
      matchId: row.match_id,
      reporterId: row.reporter_id,
      description: row.description,
      resolution: row.resolution,
      resolvedAt: row.resolved_at,
      createdAt: row.created_at,
    };
  }
}
