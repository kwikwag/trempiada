import Database from "better-sqlite3";
import type {
  User,
  Car,
  Ride,
  RideRequest,
  Match,
  Rating,
  TrustVerification,
  FaceLivenessVerification,
  Dispute,
  Gender,
  VerificationType,
  CancellationReason,
  MatchStatus,
  RideStatus,
  RequestStatus,
} from "../types";

// ---- Private DB row interfaces (snake_case column names) ----

interface UserRow {
  id: number;
  telegram_id: number;
  first_name: string;
  gender: Gender | null;
  photo_file_id: string | null;
  photo_nudged_at: string | null;
  phone: string | null;
  points_balance: number;
  trust_score: number;
  total_rides_as_driver: number;
  total_rides_as_rider: number;
  avg_rating_as_driver: number | null;
  avg_rating_as_rider: number | null;
  is_suspended: number;
  created_at: string;
}

interface VerificationRow {
  id: number;
  user_id: number;
  type: VerificationType;
  verified: number;
  shared_with_riders: number;
  external_ref: string | null;
  verified_at: string;
}

interface FaceLivenessVerificationRow {
  user_id: number;
  profile_photo_file_id: string;
  verified_at: string;
}

interface CarRow {
  id: number;
  user_id: number;
  plate_number: string;
  make: string;
  model: string;
  color: string;
  year: number | null;
  seat_count: number;
  photo_file_id: string | null;
  is_active: number;
  created_at: string;
}

interface RideRow {
  id: number;
  driver_id: number;
  car_id: number;
  origin_lat: number;
  origin_lng: number;
  dest_lat: number;
  dest_lng: number;
  origin_label: string;
  dest_label: string;
  route_geometry: string | null;
  estimated_duration: number | null;
  departure_time: string;
  max_detour_minutes: number;
  available_seats: number;
  status: RideStatus;
  created_at: string;
}

interface RideRequestRow {
  id: number;
  rider_id: number;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_lat: number;
  dropoff_lng: number;
  pickup_label: string;
  dropoff_label: string;
  earliest_departure: string;
  latest_departure: string;
  status: RequestStatus;
  created_at: string;
}

interface MatchRow {
  id: number;
  ride_id: number;
  request_id: number;
  rider_id: number;
  driver_id: number;
  pickup_lat: number;
  pickup_lng: number;
  dropoff_lat: number;
  dropoff_lng: number;
  detour_seconds: number;
  confirmation_code: string;
  status: MatchStatus;
  points_cost: number;
  cancellation_reason: CancellationReason | null;
  cancelled_by: number | null;
  picked_up_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface RatingRow {
  id: number;
  match_id: number;
  rater_id: number;
  rated_id: number;
  score: number;
  comment: string | null;
  created_at: string;
}

interface DisputeRow {
  id: number;
  match_id: number;
  reporter_id: number;
  description: string;
  resolution: string | null;
  resolved_at: string | null;
  created_at: string;
}

interface CountRow {
  cnt: number;
}
interface AvgScoreRow {
  avg_score: number | null;
}
interface PointsBalanceRow {
  points_balance: number;
}

export interface AddVerificationArgs {
  userId: number;
  type: VerificationType;
  externalRef?: string | null;
  sharedWithRiders?: boolean;
}

export interface SetVerificationVisibilityArgs {
  userId: number;
  type: VerificationType;
  shared: boolean;
}

export interface AddCarArgs {
  userId: number;
  plateNumber: string;
  make: string;
  model: string;
  color: string;
  year: number | null;
  seatCount: number;
  photoFileId: string | null;
}

export interface CancelMatchArgs {
  matchId: number;
  cancelledBy: number;
  reason: CancellationReason;
}

export interface RecentSamePairCountArgs {
  userId1: number;
  userId2: number;
  hoursBack: number;
}

export interface AddRatingArgs {
  matchId: number;
  raterId: number;
  ratedId: number;
  score: number;
  comment: string | null;
}

export interface CreateDisputeArgs {
  matchId: number;
  reporterId: number;
  description: string;
}

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
    const stmt = this.db.prepare<[number, string], UserRow>(`
      INSERT INTO users (telegram_id, first_name, points_balance)
      VALUES (?, ?, 5.0)
      RETURNING *
    `);
    return this.mapUser(stmt.get(telegramId, firstName)!);
  }

  getUserByTelegramId(telegramId: number): User | null {
    const stmt = this.db.prepare<[number], UserRow>("SELECT * FROM users WHERE telegram_id = ?");
    const row = stmt.get(telegramId);
    return row ? this.mapUser(row) : null;
  }

  getUserById(id: number): User | null {
    const stmt = this.db.prepare<[number], UserRow>("SELECT * FROM users WHERE id = ?");
    const row = stmt.get(id);
    return row ? this.mapUser(row) : null;
  }

  updateUserProfile(
    userId: number,
    updates: {
      firstName?: string;
      gender?: Gender;
      photoFileId?: string;
      phone?: string;
    },
  ): void {
    const fields: string[] = [];
    const values: (string | number)[] = [];

    if (updates.firstName !== undefined) {
      fields.push("first_name = ?");
      values.push(updates.firstName);
    }
    if (updates.gender !== undefined) {
      fields.push("gender = ?");
      values.push(updates.gender);
    }
    if (updates.photoFileId !== undefined) {
      fields.push("photo_file_id = ?");
      values.push(updates.photoFileId);
    }
    if (updates.phone !== undefined) {
      fields.push("phone = ?");
      values.push(updates.phone);
    }

    if (fields.length === 0) return;
    values.push(userId);

    this.db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...values);
  }

  setPhotoNudgedAt(userId: number): void {
    this.db.prepare("UPDATE users SET photo_nudged_at = datetime('now') WHERE id = ?").run(userId);
  }

  clearUserProfileData(userId: number): void {
    this.db
      .prepare("UPDATE users SET gender = NULL, photo_file_id = NULL WHERE id = ?")
      .run(userId);
    this.clearFaceLivenessVerification(userId);
  }

  deactivateAllCarsForUser(userId: number): void {
    this.db.prepare("UPDATE cars SET is_active = 0 WHERE user_id = ?").run(userId);
  }

  removeVerificationsByTypes(userId: number, types: VerificationType[]): void {
    if (types.length === 0) return;
    const placeholders = types.map(() => "?").join(", ");
    this.db
      .prepare(`DELETE FROM trust_verifications WHERE user_id = ? AND type IN (${placeholders})`)
      .run(userId, ...types);
  }

  adjustPoints(userId: number, delta: number): void {
    this.db
      .prepare("UPDATE users SET points_balance = points_balance + ? WHERE id = ?")
      .run(delta, userId);
  }

  getPointsBalance(userId: number): number {
    const row = this.db
      .prepare<[number], PointsBalanceRow>("SELECT points_balance FROM users WHERE id = ?")
      .get(userId);
    return row?.points_balance ?? 0;
  }

  incrementRideCount(userId: number, role: "driver" | "rider"): void {
    const col = role === "driver" ? "total_rides_as_driver" : "total_rides_as_rider";
    this.db.prepare(`UPDATE users SET ${col} = ${col} + 1 WHERE id = ?`).run(userId);
  }

  updateAvgRating(userId: number, role: "driver" | "rider"): void {
    const col = role === "driver" ? "avg_rating_as_driver" : "avg_rating_as_rider";
    // Compute from all ratings where this user was rated in matching role
    const avg = this.db
      .prepare<[number, number], AvgScoreRow>(
        `
      SELECT AVG(r.score) as avg_score
      FROM ratings r
      JOIN matches m ON r.match_id = m.id
      WHERE r.rated_id = ?
        AND ${role === "driver" ? "m.driver_id" : "m.rider_id"} = ?
    `,
      )
      .get(userId, userId);

    this.db.prepare(`UPDATE users SET ${col} = ? WHERE id = ?`).run(avg?.avg_score ?? null, userId);
  }

  suspendUser(userId: number): void {
    this.db.prepare("UPDATE users SET is_suspended = 1 WHERE id = ?").run(userId);
  }

  /**
   * Anonymise a user's personal data in-place (right to erasure).
   * Keeps the row skeleton and telegram_id so historical match/rating
   * FK references remain intact and the account cannot be silently re-created.
   * Deletes trust_verifications (which hold external refs / social handles).
   * Nulls out car plate and photo but keeps the make/model for ride records.
   */
  anonymizeUser(userId: number): void {
    this.db.transaction(() => {
      this.db
        .prepare(
          `
        UPDATE users SET
          first_name    = 'Deleted User',
          gender        = NULL,
          photo_file_id = NULL,
          phone         = NULL,
          trust_score   = 0,
          is_suspended  = 1
        WHERE id = ?
      `,
        )
        .run(userId);

      this.db.prepare("DELETE FROM trust_verifications WHERE user_id = ?").run(userId);
      this.db.prepare("DELETE FROM face_liveness_verifications WHERE user_id = ?").run(userId);

      this.db
        .prepare(
          `
        UPDATE cars SET
          plate_number  = 'DELETED',
          photo_file_id = NULL
        WHERE user_id = ?
      `,
        )
        .run(userId);
    })();
  }

  // ---- Trust Verifications ----

  addVerification({
    userId,
    type,
    externalRef = null,
    sharedWithRiders = true,
  }: AddVerificationArgs): void {
    this.db
      .prepare(
        `
      INSERT INTO trust_verifications (user_id, type, external_ref, shared_with_riders)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(user_id, type) DO UPDATE SET
        external_ref = excluded.external_ref,
        shared_with_riders = excluded.shared_with_riders,
        verified_at = datetime('now')
    `,
      )
      .run(userId, type, externalRef, sharedWithRiders ? 1 : 0);

    this.recalcTrustScore(userId);
  }

  setVerificationVisibility({ userId, type, shared }: SetVerificationVisibilityArgs): void {
    this.db
      .prepare(
        `
      UPDATE trust_verifications SET shared_with_riders = ? WHERE user_id = ? AND type = ?
    `,
      )
      .run(shared ? 1 : 0, userId, type);
  }

  getVerifications(userId: number): TrustVerification[] {
    const rows = this.db
      .prepare<[number], VerificationRow>("SELECT * FROM trust_verifications WHERE user_id = ?")
      .all(userId);
    return rows.map(this.mapVerification);
  }

  /** Get only verifications the user chose to share (shown to riders) */
  getPublicVerifications(userId: number): TrustVerification[] {
    const rows = this.db
      .prepare<
        [number],
        VerificationRow
      >("SELECT * FROM trust_verifications WHERE user_id = ? AND shared_with_riders = 1")
      .all(userId);
    return rows.map(this.mapVerification);
  }

  getVerificationCount(userId: number): number {
    const row = this.db
      .prepare<
        [number],
        CountRow
      >("SELECT COUNT(*) as cnt FROM trust_verifications WHERE user_id = ?")
      .get(userId);
    return row?.cnt ?? 0;
  }

  setFaceLivenessVerification({
    userId,
    profilePhotoFileId,
  }: {
    userId: number;
    profilePhotoFileId: string;
  }): void {
    this.db
      .prepare(
        `
      INSERT INTO face_liveness_verifications (user_id, profile_photo_file_id)
      VALUES (?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        profile_photo_file_id = excluded.profile_photo_file_id,
        verified_at = datetime('now')
    `,
      )
      .run(userId, profilePhotoFileId);
  }

  getFaceLivenessVerification(userId: number): FaceLivenessVerification | null {
    const row = this.db
      .prepare<
        [number],
        FaceLivenessVerificationRow
      >("SELECT * FROM face_liveness_verifications WHERE user_id = ?")
      .get(userId);
    return row ? this.mapFaceLivenessVerification(row) : null;
  }

  hasCurrentFaceLivenessVerification(userId: number): boolean {
    const user = this.getUserById(userId);
    const verification = this.getFaceLivenessVerification(userId);
    return Boolean(
      user?.photoFileId && verification && verification.profilePhotoFileId === user.photoFileId,
    );
  }

  clearFaceLivenessVerification(userId: number): void {
    this.db.prepare("DELETE FROM face_liveness_verifications WHERE user_id = ?").run(userId);
  }

  private recalcTrustScore(userId: number): void {
    // Simple weighted score: each verification type has a weight,
    // plus average rating contributes
    const verifications = this.getVerifications(userId);
    const weights: Record<VerificationType, number> = {
      phone: 1,
      photo: 1,
      car: 1,
      facebook: 2,
      linkedin: 2,
      google: 1.5,
      email: 1,
    };

    let score = verifications.reduce((sum, v) => sum + (weights[v.type] || 0), 0);

    const user = this.getUserById(userId);
    if (user?.avgRatingAsDriver && user.totalRidesAsDriver >= 3) {
      score += user.avgRatingAsDriver; // Add up to 5 points from ratings
    }

    this.db.prepare("UPDATE users SET trust_score = ? WHERE id = ?").run(score, userId);
  }

  // ---- Cars ----

  addCar({
    userId,
    plateNumber,
    make,
    model,
    color,
    year,
    seatCount,
    photoFileId,
  }: AddCarArgs): Car {
    // Deactivate other cars for this user
    this.db.prepare("UPDATE cars SET is_active = 0 WHERE user_id = ?").run(userId);

    const stmt = this.db.prepare<
      [number, string, string, string, string, number | null, number, string | null],
      CarRow
    >(`
      INSERT INTO cars (user_id, plate_number, make, model, color, year, seat_count, photo_file_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);
    return this.mapCar(
      stmt.get(userId, plateNumber, make, model, color, year, seatCount, photoFileId)!,
    );
  }

  getActiveCar(userId: number): Car | null {
    const row = this.db
      .prepare<[number], CarRow>("SELECT * FROM cars WHERE user_id = ? AND is_active = 1")
      .get(userId);
    return row ? this.mapCar(row) : null;
  }

  // ---- Rides ----

  createRide(ride: Omit<Ride, "id" | "status" | "createdAt">): Ride {
    const stmt = this.db.prepare<
      [
        number,
        number,
        number,
        number,
        number,
        number,
        string,
        string,
        string | null,
        number | null,
        string,
        number,
        number,
      ],
      RideRow
    >(`
      INSERT INTO rides (
        driver_id, car_id, origin_lat, origin_lng, dest_lat, dest_lng,
        origin_label, dest_label, route_geometry, estimated_duration,
        departure_time, max_detour_minutes, available_seats
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);
    return this.mapRide(
      stmt.get(
        ride.driverId,
        ride.carId,
        ride.originLat,
        ride.originLng,
        ride.destLat,
        ride.destLng,
        ride.originLabel,
        ride.destLabel,
        ride.routeGeometry,
        ride.estimatedDuration,
        ride.departureTime,
        ride.maxDetourMinutes,
        ride.availableSeats,
      )!,
    );
  }

  updateRideStatus(rideId: number, status: RideStatus): void {
    this.db.prepare("UPDATE rides SET status = ? WHERE id = ?").run(status, rideId);
  }

  getOpenRides(): Ride[] {
    const rows = this.db
      .prepare<[], RideRow>("SELECT * FROM rides WHERE status = 'open' ORDER BY departure_time ASC")
      .all();
    return rows.map(this.mapRide);
  }

  getRideById(rideId: number): Ride | null {
    const row = this.db.prepare<[number], RideRow>("SELECT * FROM rides WHERE id = ?").get(rideId);
    return row ? this.mapRide(row) : null;
  }

  getOpenRideForDriver(driverId: number): Ride | null {
    const row = this.db
      .prepare<
        [number],
        RideRow
      >("SELECT * FROM rides WHERE driver_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1")
      .get(driverId);
    return row ? this.mapRide(row) : null;
  }

  getActiveRideForDriver(driverId: number): Ride | null {
    const row = this.db
      .prepare<
        [number],
        RideRow
      >("SELECT * FROM rides WHERE driver_id = ? AND status IN ('open', 'matched') ORDER BY created_at DESC LIMIT 1")
      .get(driverId);
    return row ? this.mapRide(row) : null;
  }

  cancelOpenRideForDriver(driverId: number): Ride | null {
    const ride = this.getOpenRideForDriver(driverId);
    if (!ride) return null;
    this.updateRideStatus(ride.id, "cancelled");
    return { ...ride, status: "cancelled" };
  }

  // ---- Ride Requests ----

  createRideRequest(req: Omit<RideRequest, "id" | "status" | "createdAt">): RideRequest {
    const stmt = this.db.prepare<
      [number, number, number, number, number, string, string, string, string],
      RideRequestRow
    >(`
      INSERT INTO ride_requests (
        rider_id, pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
        pickup_label, dropoff_label, earliest_departure, latest_departure
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);
    return this.mapRequest(
      stmt.get(
        req.riderId,
        req.pickupLat,
        req.pickupLng,
        req.dropoffLat,
        req.dropoffLng,
        req.pickupLabel,
        req.dropoffLabel,
        req.earliestDeparture,
        req.latestDeparture,
      )!,
    );
  }

  getOpenRequests(): RideRequest[] {
    const rows = this.db
      .prepare<
        [],
        RideRequestRow
      >("SELECT * FROM ride_requests WHERE status = 'open' ORDER BY earliest_departure ASC")
      .all();
    return rows.map(this.mapRequest);
  }

  updateRequestStatus(requestId: number, status: RequestStatus): void {
    this.db.prepare("UPDATE ride_requests SET status = ? WHERE id = ?").run(status, requestId);
  }

  getRideRequestById(requestId: number): RideRequest | null {
    const row = this.db
      .prepare<[number], RideRequestRow>("SELECT * FROM ride_requests WHERE id = ?")
      .get(requestId);
    return row ? this.mapRequest(row) : null;
  }

  getOpenRideRequestForRider(riderId: number): RideRequest | null {
    const row = this.db
      .prepare<
        [number],
        RideRequestRow
      >("SELECT * FROM ride_requests WHERE rider_id = ? AND status = 'open' ORDER BY created_at DESC LIMIT 1")
      .get(riderId);
    return row ? this.mapRequest(row) : null;
  }

  cancelOpenRideRequestForRider(riderId: number): RideRequest | null {
    const request = this.getOpenRideRequestForRider(riderId);
    if (!request) return null;
    this.updateRequestStatus(request.id, "cancelled");
    return { ...request, status: "cancelled" };
  }

  // ---- Matches ----

  createMatch(
    match: Omit<
      Match,
      | "id"
      | "status"
      | "cancellationReason"
      | "cancelledBy"
      | "pickedUpAt"
      | "completedAt"
      | "createdAt"
    >,
  ): Match {
    const stmt = this.db.prepare<
      [number, number, number, number, number, number, number, number, number, string, number],
      MatchRow
    >(`
      INSERT INTO matches (
        ride_id, request_id, rider_id, driver_id,
        pickup_lat, pickup_lng, dropoff_lat, dropoff_lng,
        detour_seconds, confirmation_code, points_cost
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING *
    `);
    return this.mapMatch(
      stmt.get(
        match.rideId,
        match.requestId,
        match.riderId,
        match.driverId,
        match.pickupLat,
        match.pickupLng,
        match.dropoffLat,
        match.dropoffLng,
        match.detourSeconds,
        match.confirmationCode,
        match.pointsCost,
      )!,
    );
  }

  updateMatchStatus(matchId: number, status: MatchStatus): void {
    const extra =
      status === "picked_up"
        ? ", picked_up_at = datetime('now')"
        : status === "completed"
          ? ", completed_at = datetime('now')"
          : "";
    this.db.prepare(`UPDATE matches SET status = ?${extra} WHERE id = ?`).run(status, matchId);
  }

  cancelMatch({ matchId, cancelledBy, reason }: CancelMatchArgs): void {
    this.db
      .prepare(
        `
      UPDATE matches SET status = 'cancelled', cancelled_by = ?, cancellation_reason = ? WHERE id = ?
    `,
      )
      .run(cancelledBy, reason, matchId);
  }

  getActiveMatchForUser(userId: number): Match | null {
    const row = this.db
      .prepare<[number, number], MatchRow>(
        `
      SELECT * FROM matches
      WHERE (rider_id = ? OR driver_id = ?)
        AND status IN ('pending', 'accepted', 'picked_up')
      ORDER BY created_at DESC LIMIT 1
    `,
      )
      .get(userId, userId);
    return row ? this.mapMatch(row) : null;
  }

  getMatchById(matchId: number): Match | null {
    const row = this.db
      .prepare<[number], MatchRow>("SELECT * FROM matches WHERE id = ?")
      .get(matchId);
    return row ? this.mapMatch(row) : null;
  }

  /** Anti-gaming: check if same pair rode together recently */
  getRecentSamePairCount({ userId1, userId2, hoursBack }: RecentSamePairCountArgs): number {
    const row = this.db
      .prepare<[number, number, number, number, number], CountRow>(
        `
      SELECT COUNT(*) as cnt FROM matches
      WHERE status = 'completed'
        AND ((driver_id = ? AND rider_id = ?) OR (driver_id = ? AND rider_id = ?))
        AND completed_at > datetime('now', '-' || ? || ' hours')
    `,
      )
      .get(userId1, userId2, userId2, userId1, hoursBack);
    return row?.cnt ?? 0;
  }

  /** Count recent cancellations for anti-abuse */
  getRecentCancellationCount(userId: number, daysBack: number): number {
    const row = this.db
      .prepare<[number, number], CountRow>(
        `
      SELECT COUNT(*) as cnt FROM matches
      WHERE cancelled_by = ?
        AND created_at > datetime('now', '-' || ? || ' days')
    `,
      )
      .get(userId, daysBack);
    return row?.cnt ?? 0;
  }

  // ---- Ratings ----

  addRating({ matchId, raterId, ratedId, score, comment }: AddRatingArgs): Rating {
    const stmt = this.db.prepare<[number, number, number, number, string | null], RatingRow>(`
      INSERT INTO ratings (match_id, rater_id, rated_id, score, comment)
      VALUES (?, ?, ?, ?, ?)
      RETURNING *
    `);
    const rating = this.mapRating(stmt.get(matchId, raterId, ratedId, score, comment)!);

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
    const rows = this.db
      .prepare<[number], RatingRow>("SELECT * FROM ratings WHERE match_id = ?")
      .all(matchId);
    return rows.map(this.mapRating);
  }

  bothRated(matchId: number): boolean {
    const row = this.db
      .prepare<[number], CountRow>("SELECT COUNT(*) as cnt FROM ratings WHERE match_id = ?")
      .get(matchId);
    return (row?.cnt ?? 0) >= 2;
  }

  // ---- Disputes ----

  createDispute({ matchId, reporterId, description }: CreateDisputeArgs): Dispute {
    const stmt = this.db.prepare<[number, number, string], DisputeRow>(`
      INSERT INTO disputes (match_id, reporter_id, description)
      VALUES (?, ?, ?)
      RETURNING *
    `);
    return this.mapDispute(stmt.get(matchId, reporterId, description)!);
  }

  // ---- Row mappers ----

  private mapUser(row: UserRow): User {
    return {
      id: row.id,
      telegramId: row.telegram_id,
      firstName: row.first_name,
      gender: row.gender,
      photoFileId: row.photo_file_id,
      photoNudgedAt: row.photo_nudged_at,
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

  private mapVerification(row: VerificationRow): TrustVerification {
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

  private mapFaceLivenessVerification(row: FaceLivenessVerificationRow): FaceLivenessVerification {
    return {
      userId: row.user_id,
      profilePhotoFileId: row.profile_photo_file_id,
      verifiedAt: row.verified_at,
    };
  }

  private mapCar(row: CarRow): Car {
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

  private mapRide(row: RideRow): Ride {
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

  private mapRequest(row: RideRequestRow): RideRequest {
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

  private mapMatch(row: MatchRow): Match {
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

  private mapRating(row: RatingRow): Rating {
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

  private mapDispute(row: DisputeRow): Dispute {
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
