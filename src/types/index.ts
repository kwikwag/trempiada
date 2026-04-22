// ---- User & Identity ----

export type Gender = "male" | "female" | "other";

export type VerificationType =
  | "phone"
  | "photo"
  | "car"
  | "facebook"
  | "linkedin"
  | "google"
  | "email";

export interface User {
  id: number;
  telegramId: number;
  firstName: string;
  gender: Gender | null;
  photoFileId: string | null; // Telegram file ID
  phone: string | null;
  pointsBalance: number;
  trustScore: number; // Computed from verifications + ratings
  totalRidesAsDriver: number;
  totalRidesAsRider: number;
  avgRatingAsDriver: number | null;
  avgRatingAsRider: number | null;
  isSuspended: boolean;
  createdAt: string;
}

export interface TrustVerification {
  id: number;
  userId: number;
  type: VerificationType;
  /** Whether the user completed this verification (always true if row exists) */
  verified: boolean;
  /** Whether the user allows riders to SEE this verification */
  sharedWithRiders: boolean;
  /** External ID or handle (e.g. Facebook profile URL), stored for system use */
  externalRef: string | null;
  verifiedAt: string;
}

export interface Car {
  id: number;
  userId: number;
  plateNumber: string;
  make: string;
  model: string;
  color: string;
  year: number | null;
  seatCount: number; // Excludes driver
  photoFileId: string | null;
  isActive: boolean;
  createdAt: string;
}

// ---- Rides & Matching ----

export type RideStatus = "open" | "matched" | "in_progress" | "completed" | "cancelled";

export interface Ride {
  id: number;
  driverId: number;
  carId: number;
  originLat: number;
  originLng: number;
  destLat: number;
  destLng: number;
  originLabel: string;
  destLabel: string;
  /** OSRM-encoded polyline of the planned route */
  routeGeometry: string | null;
  /** Estimated drive time in seconds (without detours) */
  estimatedDuration: number | null;
  departureTime: string; // ISO 8601
  maxDetourMinutes: number;
  availableSeats: number;
  status: RideStatus;
  createdAt: string;
}

export type RequestStatus = "open" | "matched" | "completed" | "cancelled";

export interface RideRequest {
  id: number;
  riderId: number;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  pickupLabel: string;
  dropoffLabel: string;
  earliestDeparture: string;
  latestDeparture: string;
  status: RequestStatus;
  createdAt: string;
}

export type MatchStatus =
  | "pending" // Driver accepted, waiting for rider
  | "accepted" // Both accepted
  | "picked_up" // Confirmation code entered
  | "completed"
  | "cancelled";

export type CancellationReason = "changed_plans" | "no_show" | "felt_unsafe" | "other";

export interface Match {
  id: number;
  rideId: number;
  requestId: number;
  riderId: number;
  driverId: number;
  pickupLat: number;
  pickupLng: number;
  dropoffLat: number;
  dropoffLng: number;
  detourSeconds: number;
  confirmationCode: string; // 4-digit
  status: MatchStatus;
  pointsCost: number;
  cancellationReason: CancellationReason | null;
  cancelledBy: number | null; // User ID
  pickedUpAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

// ---- Ratings & Disputes ----

export interface Rating {
  id: number;
  matchId: number;
  raterId: number;
  ratedId: number;
  score: number; // 1-5
  comment: string | null;
  createdAt: string;
}

export interface Dispute {
  id: number;
  matchId: number;
  reporterId: number;
  description: string;
  resolution: string | null;
  resolvedAt: string | null;
  createdAt: string;
}

// ---- Bot State Machine ----

export type BotScene =
  | "idle"
  | "registration_gender"
  | "registration_photo"
  | "registration_verification" // Must complete at least one verification
  | "registration_verification_choice"
  | "car_registration_photo"
  | "car_registration_confirm"
  | "car_registration_seats"
  | "car_edit"
  | "ride_origin"
  | "ride_destination"
  | "ride_departure"
  | "ride_departure_custom"
  | "ride_review"
  | "ride_edit"
  | "request_pickup"
  | "request_dropoff"
  | "request_time"
  | "request_review"
  | "match_pending" // Waiting for other party
  | "in_ride_relay" // Message relay mode
  | "rating"
  | "cancel_reason"
  | "dispute_description"
  | "profile_restart_name";

export interface SessionState {
  scene: BotScene;
  userId: number | null; // DB user ID (null if not registered)
  data: Record<string, any>; // Scene-specific temp data
}

// ---- Service Interfaces ----

export interface GeoPoint {
  lat: number;
  lng: number;
}

export interface RouteResult {
  distanceMeters: number;
  durationSeconds: number;
  geometry: string; // Encoded polyline
}

export interface DetourResult {
  originalDuration: number;
  detourDuration: number;
  addedSeconds: number;
  pickupPoint: GeoPoint;
  dropoffPoint: GeoPoint;
}

export interface CarDetails {
  plateNumber: string;
  make: string;
  model: string;
  color: string;
  year: number | null;
  seatCount: number;
}

// ---- Points Economy Constants ----

export const POINTS = {
  STARTER_BALANCE: 5,
  DRIVER_REWARD_HIGH: 2, // Rating 4-5
  DRIVER_REWARD_LOW: 1, // Rating 1-3
  DRIVER_REWARD_CANCELLED: 0,
  RIDER_REWARD_HIGH: 0.5, // Rating 4-5
  RIDER_REWARD_LOW: 0.2, // Rating 1-3
  NO_SHOW_COMPENSATION: 1, // For the waiting party
  MIN_RIDE_DISTANCE_KM: 5,
  SAME_PAIR_COOLDOWN_HOURS: 24,
} as const;

// ---- Defaults ----

export const DEFAULTS = {
  MAX_DETOUR_MINUTES: 5,
  DEFAULT_SEAT_COUNT: 4,
  CONFIRMATION_CODE_LENGTH: 4,
  CONFIRMATION_MAX_ATTEMPTS: 3,
  MATCH_ACCEPT_TIMEOUT_MINUTES: 5,
  NO_SHOW_BUFFER_MINUTES: 5,
  CANCELLATION_THRESHOLD: 3, // Cancels per week before penalty
  NO_SHOW_THRESHOLD: 3, // Before suspension
  MIN_TRUST_VERIFICATIONS: 1, // Drivers must have at least 1
} as const;
