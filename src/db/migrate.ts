import Database from "better-sqlite3";
import path from "path";
import fs from "fs";

const SCHEMA = `
-- ============================================================
-- TrempBot Database Schema
-- ============================================================

CREATE TABLE IF NOT EXISTS users (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id           INTEGER UNIQUE NOT NULL,
  first_name            TEXT NOT NULL,
  gender                TEXT CHECK(gender IN ('male', 'female', 'other')),
  photo_file_id         TEXT,
  phone                 TEXT,
  points_balance        REAL NOT NULL DEFAULT 5.0,
  trust_score           REAL NOT NULL DEFAULT 0,
  total_rides_as_driver INTEGER NOT NULL DEFAULT 0,
  total_rides_as_rider  INTEGER NOT NULL DEFAULT 0,
  avg_rating_as_driver  REAL,
  avg_rating_as_rider   REAL,
  is_suspended          INTEGER NOT NULL DEFAULT 0,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS trust_verifications (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id            INTEGER NOT NULL REFERENCES users(id),
  type               TEXT NOT NULL CHECK(type IN (
                       'phone','photo','car','facebook','linkedin','google','email'
                     )),
  verified           INTEGER NOT NULL DEFAULT 1,
  shared_with_riders INTEGER NOT NULL DEFAULT 1,
  external_ref       TEXT,
  verified_at        TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, type)
);

CREATE TABLE IF NOT EXISTS face_liveness_verifications (
  user_id               INTEGER PRIMARY KEY REFERENCES users(id),
  profile_photo_file_id TEXT NOT NULL,
  verified_at           TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS cars (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id        INTEGER NOT NULL REFERENCES users(id),
  plate_number   TEXT NOT NULL,
  make           TEXT NOT NULL,
  model          TEXT NOT NULL,
  color          TEXT NOT NULL,
  year           INTEGER,
  seat_count     INTEGER NOT NULL DEFAULT 4,
  photo_file_id  TEXT,
  is_active      INTEGER NOT NULL DEFAULT 1,
  created_at     TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS rides (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  driver_id          INTEGER NOT NULL REFERENCES users(id),
  car_id             INTEGER NOT NULL REFERENCES cars(id),
  origin_lat         REAL NOT NULL,
  origin_lng         REAL NOT NULL,
  dest_lat           REAL NOT NULL,
  dest_lng           REAL NOT NULL,
  origin_label       TEXT NOT NULL,
  dest_label         TEXT NOT NULL,
  route_geometry     TEXT,
  estimated_duration INTEGER,
  departure_time     TEXT NOT NULL,
  max_detour_minutes INTEGER NOT NULL DEFAULT 5,
  available_seats    INTEGER NOT NULL DEFAULT 4,
  status             TEXT NOT NULL DEFAULT 'open'
                       CHECK(status IN ('open','matched','in_progress','completed','cancelled')),
  created_at         TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ride_requests (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  rider_id            INTEGER NOT NULL REFERENCES users(id),
  pickup_lat          REAL NOT NULL,
  pickup_lng          REAL NOT NULL,
  dropoff_lat         REAL NOT NULL,
  dropoff_lng         REAL NOT NULL,
  pickup_label        TEXT NOT NULL,
  dropoff_label       TEXT NOT NULL,
  earliest_departure  TEXT NOT NULL,
  latest_departure    TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'open'
                        CHECK(status IN ('open','matched','completed','cancelled')),
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS matches (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  ride_id             INTEGER NOT NULL REFERENCES rides(id),
  request_id          INTEGER NOT NULL REFERENCES ride_requests(id),
  rider_id            INTEGER NOT NULL REFERENCES users(id),
  driver_id           INTEGER NOT NULL REFERENCES users(id),
  pickup_lat          REAL NOT NULL,
  pickup_lng          REAL NOT NULL,
  dropoff_lat         REAL NOT NULL,
  dropoff_lng         REAL NOT NULL,
  detour_seconds      INTEGER NOT NULL,
  confirmation_code   TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                        CHECK(status IN ('pending','accepted','picked_up','completed','cancelled')),
  points_cost         REAL NOT NULL DEFAULT 0,
  cancellation_reason TEXT CHECK(cancellation_reason IN (
                        'changed_plans','no_show','felt_unsafe','other'
                      )),
  cancelled_by        INTEGER REFERENCES users(id),
  picked_up_at        TEXT,
  completed_at        TEXT,
  created_at          TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ratings (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id   INTEGER NOT NULL REFERENCES matches(id),
  rater_id   INTEGER NOT NULL REFERENCES users(id),
  rated_id   INTEGER NOT NULL REFERENCES users(id),
  score      INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
  comment    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(match_id, rater_id)
);

CREATE TABLE IF NOT EXISTS disputes (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  match_id    INTEGER NOT NULL REFERENCES matches(id),
  reporter_id INTEGER NOT NULL REFERENCES users(id),
  description TEXT NOT NULL,
  resolution  TEXT,
  resolved_at TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================
-- Indexes for query performance
-- ============================================================

CREATE INDEX IF NOT EXISTS idx_users_telegram_id ON users(telegram_id);
CREATE INDEX IF NOT EXISTS idx_cars_user_id ON cars(user_id);
CREATE INDEX IF NOT EXISTS idx_rides_status ON rides(status);
CREATE INDEX IF NOT EXISTS idx_rides_driver ON rides(driver_id);
CREATE INDEX IF NOT EXISTS idx_rides_departure ON rides(departure_time);
CREATE INDEX IF NOT EXISTS idx_requests_status ON ride_requests(status);
CREATE INDEX IF NOT EXISTS idx_requests_rider ON ride_requests(rider_id);
CREATE INDEX IF NOT EXISTS idx_matches_ride ON matches(ride_id);
CREATE INDEX IF NOT EXISTS idx_matches_status ON matches(status);
CREATE INDEX IF NOT EXISTS idx_matches_driver ON matches(driver_id);
CREATE INDEX IF NOT EXISTS idx_matches_rider ON matches(rider_id);
CREATE INDEX IF NOT EXISTS idx_ratings_match ON ratings(match_id);
CREATE INDEX IF NOT EXISTS idx_trust_user ON trust_verifications(user_id);
CREATE INDEX IF NOT EXISTS idx_face_liveness_photo
  ON face_liveness_verifications(profile_photo_file_id);
`;

export function initDatabase(dbPath: string): Database.Database {
  const dir = path.dirname(dbPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const db = new Database(dbPath);

  // Performance settings for SQLite
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");

  // Run schema
  db.exec(SCHEMA);

  return db;
}

// Run directly: ts-node src/db/migrate.ts
if (require.main === module) {
  const dbPath = process.env.DATABASE_PATH || "./data/rides.db";
  console.log(`Initializing database at ${dbPath}...`);
  const db = initDatabase(dbPath);
  console.log("Database initialized successfully.");
  db.close();
}
