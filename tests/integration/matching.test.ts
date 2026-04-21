/**
 * Integration tests for the matching service with realistic Israeli geography.
 *
 * These tests use a real in-memory SQLite database and the real MatchingService,
 * but mock the RoutingService (no live OSRM required). The goal is to verify
 * that the matching algorithm correctly handles the geographic and temporal
 * scenarios that the bot will encounter in production.
 *
 * One test is marked as a KNOWN LIMITATION and is expected to fail: the system
 * does not support en-route matching for riders who post after the driver has
 * already departed. See the test for details.
 */

import assert from "node:assert/strict";
import test from "node:test";
import { initDatabase } from "../../src/db/migrate";
import { Repository } from "../../src/db/repository";
import { MatchingService } from "../../src/services/matching";
import type { RoutingService } from "../../src/services/routing";
import type { DetourResult, GeoPoint } from "../../src/types";
import { DEFAULTS } from "../../src/types";

// ---------------------------------------------------------------------------
// Real Israeli coordinates
// ---------------------------------------------------------------------------

/** King George Blvd, Tel Aviv — driver's starting point */
const DRIVER_ORIGIN_1 = { lat: 32.0757, lng: 34.7782, label: "46 King George Blvd, Tel Aviv" };
/** Ahad Ha'Am St, Tel Aviv — rider's pickup; ~1.5 km from King George TA */
const RIDER_ORIGIN_1 = { lat: 32.0625, lng: 34.7768, label: "134 Ahad Ha'Am St, Tel Aviv" };
/** King George St, Jerusalem — driver's destination */
const DRIVER_DEST_1 = { lat: 31.7795, lng: 35.2193, label: "46 King George St, Jerusalem" };
/** Ahad Ha'Am St, Jerusalem — rider's dropoff; ~1.2 km from King George JM */
const RIDER_DEST_1 = { lat: 31.7706, lng: 35.2139, label: "2 Ahad Ha'Am St, Jerusalem" };
/**
 * Hemed Interchange on Route 1 — roughly 40 km / 40 min east of Tel Aviv.
 * A rider here only needs a short detour from the TA→Jerusalem route.
 */
const RIDER_ORIGIN_1A = { lat: 31.845, lng: 34.969, label: "Hemed Interchange" };
/** Haifa — far north, clearly off the TA→Jerusalem route */
const DRIVER_ORIGIN_2 = { lat: 32.794, lng: 34.989, label: "Haifa" };

// ---------------------------------------------------------------------------
// Helper: estimate drive time from TA to a midpoint along Route 1
//
// Route 1 TA → Jerusalem is roughly 60 km and takes ~3600 s.
// We estimate fractional progress linearly by longitude (crude but sufficient
// for test setup — OSRM is mocked anyway).
// ---------------------------------------------------------------------------

const DRIVE_DURATION_1 = 3600; // in seconds
const DRIVE_DISTANCE_1 = 60_000; // in meters

function minutesAgo(n: number): string {
  return new Date(Date.now() - n * 60 * 1000).toISOString();
}

function minutesFromNow(n: number): string {
  return new Date(Date.now() + n * 60 * 1000).toISOString();
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeDb() {
  const db = initDatabase(":memory:");
  return { db, repo: new Repository(db) };
}

function seedDriver(repo: Repository, n: number) {
  const user = repo.createUser(1000 + n, `Driver${n}`);
  const car = repo.addCar(user.id, `10-00${n}-0${n}`, "Toyota", "Corolla", "White", 2020, 4, null);
  repo.addVerification(user.id, "car");
  return { user, car };
}

function seedRider(repo: Repository, n: number) {
  return repo.createUser(2000 + n, `Rider${n}`);
}

/**
 * A routing service that always returns a small, valid detour.
 * addedSeconds defaults to 60 s — well within the 5-minute default limit.
 */
function makeRouting(addedSeconds = 60): RoutingService {
  return {
    calculateDetour: async (
      _origin: GeoPoint,
      _dest: GeoPoint,
      pickup: GeoPoint,
      dropoff: GeoPoint,
    ): Promise<DetourResult> => ({
      originalDuration: DRIVE_DURATION_1,
      detourDuration: DRIVE_DURATION_1 + addedSeconds,
      addedSeconds,
      pickupPoint: pickup,
      dropoffPoint: dropoff,
    }),
    getRoute: async () => ({
      distanceMeters: DRIVE_DISTANCE_1,
      durationSeconds: DRIVE_DURATION_1,
      geometry: "",
    }),
    findNearest: async (pt: GeoPoint) => pt,
  } as unknown as RoutingService;
}

// ---------------------------------------------------------------------------
// Scenario 1: Basic match — rider posts first, then driver posts
//
// Rider in Tel Aviv (Ahad Ha'Am TA) posts a ride request.
// A few minutes later a driver going to Jerusalem posts their ride.
// The driver's findRidersForDriver call should immediately surface the rider.
// ---------------------------------------------------------------------------

test("rider posts first: driver immediately sees the rider as a candidate", async () => {
  const { repo } = makeDb();
  const { user: driver, car } = seedDriver(repo, 1);
  const rider = seedRider(repo, 1);
  const matching = new MatchingService(repo, makeRouting());

  // Rider posts first
  repo.createRideRequest({
    riderId: rider.id,
    pickupLat: RIDER_ORIGIN_1.lat,
    pickupLng: RIDER_ORIGIN_1.lng,
    pickupLabel: RIDER_ORIGIN_1.label,
    dropoffLat: RIDER_DEST_1.lat,
    dropoffLng: RIDER_DEST_1.lng,
    dropoffLabel: RIDER_DEST_1.label,
    earliestDeparture: minutesFromNow(0),
    latestDeparture: minutesFromNow(60),
  });

  // Driver posts their ride
  const ride = repo.createRide({
    driverId: driver.id,
    carId: car.id,
    originLat: DRIVER_ORIGIN_1.lat,
    originLng: DRIVER_ORIGIN_1.lng,
    originLabel: DRIVER_ORIGIN_1.label,
    destLat: DRIVER_DEST_1.lat,
    destLng: DRIVER_DEST_1.lng,
    destLabel: DRIVER_DEST_1.label,
    routeGeometry: null,
    estimatedDuration: DRIVE_DURATION_1,
    departureTime: minutesFromNow(5),
    maxDetourMinutes: DEFAULTS.MAX_DETOUR_MINUTES,
    availableSeats: 3,
  });

  const candidates = await matching.findRidersForDriver(ride);

  assert.equal(candidates.length, 1, "driver should see the waiting rider");
  assert.equal(candidates[0].request.riderId, rider.id);
  assert.ok(
    candidates[0].detour.addedSeconds <= DEFAULTS.MAX_DETOUR_MINUTES * 60,
    "detour should be within driver's tolerance",
  );
});

// ---------------------------------------------------------------------------
// Scenario 2: Basic match — driver posts first, then rider posts
//
// Driver has already posted a ride to Jerusalem.
// A rider then requests a ride; findDriversForRider should surface the driver.
// ---------------------------------------------------------------------------

test("driver posts first: rider immediately sees matching driver", async () => {
  const { repo } = makeDb();
  const { user: driver, car } = seedDriver(repo, 2);
  const rider = seedRider(repo, 2);
  const matching = new MatchingService(repo, makeRouting());

  // Driver posts first — departs in 10 minutes
  repo.createRide({
    driverId: driver.id,
    carId: car.id,
    originLat: DRIVER_ORIGIN_1.lat,
    originLng: DRIVER_ORIGIN_1.lng,
    originLabel: DRIVER_ORIGIN_1.label,
    destLat: DRIVER_DEST_1.lat,
    destLng: DRIVER_DEST_1.lng,
    destLabel: DRIVER_DEST_1.label,
    routeGeometry: null,
    estimatedDuration: DRIVE_DURATION_1,
    departureTime: minutesFromNow(10),
    maxDetourMinutes: DEFAULTS.MAX_DETOUR_MINUTES,
    availableSeats: 3,
  });

  // Rider requests a ride within a 30-minute window
  const request = repo.createRideRequest({
    riderId: rider.id,
    pickupLat: RIDER_ORIGIN_1.lat,
    pickupLng: RIDER_ORIGIN_1.lng,
    pickupLabel: RIDER_ORIGIN_1.label,
    dropoffLat: RIDER_DEST_1.lat,
    dropoffLng: RIDER_DEST_1.lng,
    dropoffLabel: RIDER_DEST_1.label,
    earliestDeparture: minutesFromNow(0),
    latestDeparture: minutesFromNow(30),
  });

  const candidates = await matching.findDriversForRider(request);

  assert.equal(candidates.length, 1, "rider should see the waiting driver");
  assert.equal(candidates[0].ride.driverId, driver.id);
});

// ---------------------------------------------------------------------------
// Scenario 3: Midpoint pickup — Hemed Interchange
//
// Driver leaves King George TA now heading to Jerusalem.
// Rider at Hemed Interchange (40 km along Route 1) needs a ride within 60 min.
//
// The driver departs at T+0, which is within the rider's window [T+0, T+60].
// Hemed is on the route, so the detour is minimal.
// Expected: MATCH.
// ---------------------------------------------------------------------------

test("midpoint pickup: driver leaving now matches rider at Hemed within 60-min window", async () => {
  const { repo } = makeDb();
  const { user: driver, car } = seedDriver(repo, 3);
  const rider = seedRider(repo, 3);
  const matching = new MatchingService(repo, makeRouting(30)); // 30s detour — Hemed is on-route

  repo.createRideRequest({
    riderId: rider.id,
    pickupLat: RIDER_ORIGIN_1A.lat,
    pickupLng: RIDER_ORIGIN_1A.lng,
    pickupLabel: RIDER_ORIGIN_1A.label,
    dropoffLat: DRIVER_DEST_1.lat,
    dropoffLng: DRIVER_DEST_1.lng,
    dropoffLabel: DRIVER_DEST_1.label,
    earliestDeparture: minutesFromNow(0),
    latestDeparture: minutesFromNow(60),
  });

  const ride = repo.createRide({
    driverId: driver.id,
    carId: car.id,
    originLat: DRIVER_ORIGIN_1.lat,
    originLng: DRIVER_ORIGIN_1.lng,
    originLabel: DRIVER_ORIGIN_1.label,
    destLat: DRIVER_DEST_1.lat,
    destLng: DRIVER_DEST_1.lng,
    destLabel: DRIVER_DEST_1.label,
    routeGeometry: null,
    estimatedDuration: DRIVE_DURATION_1,
    departureTime: minutesFromNow(0), // leaving now
    maxDetourMinutes: DEFAULTS.MAX_DETOUR_MINUTES,
    availableSeats: 3,
  });

  const candidates = await matching.findRidersForDriver(ride);

  assert.equal(candidates.length, 1, "driver should see the Hemed rider");
  assert.equal(candidates[0].request.riderId, rider.id);
});

// ---------------------------------------------------------------------------
// Scenario 4: Correct rejection — driver left 45 minutes ago, rider needs
// pickup at Hemed in the next 5 minutes.
//
// The driver departed from TA 45 minutes ago. Hemed is ~40 min from TA,
// so the driver has already passed it. The rider's window [T+0, T+5] is
// entirely in the future. Since the driver's departure (T-45) precedes the
// rider's earliest departure (T+0), the time-window check correctly rejects
// the match.
// Expected: NO MATCH.
// ---------------------------------------------------------------------------

test("correctly rejects: driver already past pickup, rider too late to catch them", async () => {
  const { repo } = makeDb();
  const { user: driver, car } = seedDriver(repo, 4);
  const rider = seedRider(repo, 4);
  const matching = new MatchingService(repo, makeRouting());

  // The request is posted now; rider needs pickup at Hemed within 5 minutes
  repo.createRideRequest({
    riderId: rider.id,
    pickupLat: RIDER_ORIGIN_1A.lat,
    pickupLng: RIDER_ORIGIN_1A.lng,
    pickupLabel: RIDER_ORIGIN_1A.label,
    dropoffLat: DRIVER_DEST_1.lat,
    dropoffLng: DRIVER_DEST_1.lng,
    dropoffLabel: DRIVER_DEST_1.label,
    earliestDeparture: minutesFromNow(0),
    latestDeparture: minutesFromNow(5),
  });

  const ride = repo.createRide({
    driverId: driver.id,
    carId: car.id,
    originLat: DRIVER_ORIGIN_1.lat,
    originLng: DRIVER_ORIGIN_1.lng,
    originLabel: DRIVER_ORIGIN_1.label,
    destLat: DRIVER_DEST_1.lat,
    destLng: DRIVER_DEST_1.lng,
    destLabel: DRIVER_DEST_1.label,
    routeGeometry: null,
    estimatedDuration: DRIVE_DURATION_1,
    departureTime: minutesAgo(45), // left 45 min ago, already past Hemed
    maxDetourMinutes: DEFAULTS.MAX_DETOUR_MINUTES,
    availableSeats: 3,
  });

  const candidates = await matching.findRidersForDriver(ride);
  assert.equal(candidates.length, 0, "driver who already passed the pickup should not match");
});

// ---------------------------------------------------------------------------
// Scenario 5 — KNOWN LIMITATION (expected to fail with current implementation)
//
// Driver left 30 minutes ago (still ~10 minutes from Hemed).
// Rider at Hemed posts a request and needs pickup within 10 minutes.
//
// Conceptually this should match: the driver will arrive at Hemed in ~10 min,
// which is within the rider's window. But the current matching algorithm
// compares the driver's *original departure time* (T-30) against the rider's
// *earliestDeparture* (T+0). Since T-30 < T+0 the time-window check rejects
// the match.
//
// A correct fix would compare the driver's *estimated arrival time at pickup*
// (T-30 + OSRM_time_from_origin_to_pickup ≈ T+10) against the rider's window.
// That requires an extra OSRM call during matching and is a meaningful change.
//
// This test intentionally asserts the ideal (currently failing) behavior so
// that fixing the limitation produces a green test.
// ---------------------------------------------------------------------------

test("KNOWN LIMITATION: en-route driver approaching pickup should match riding request", async () => {
  const { repo } = makeDb();
  const { user: driver, car } = seedDriver(repo, 5);
  const rider = seedRider(repo, 5);
  const matching = new MatchingService(repo, makeRouting(30));

  // Rider at Hemed posts now, needs pickup in 10 minutes
  repo.createRideRequest({
    riderId: rider.id,
    pickupLat: RIDER_ORIGIN_1A.lat,
    pickupLng: RIDER_ORIGIN_1A.lng,
    pickupLabel: RIDER_ORIGIN_1A.label,
    dropoffLat: DRIVER_DEST_1.lat,
    dropoffLng: DRIVER_DEST_1.lng,
    dropoffLabel: DRIVER_DEST_1.label,
    earliestDeparture: minutesFromNow(0),
    latestDeparture: minutesFromNow(10),
  });

  // Driver departed 30 min ago — still ~10 min from Hemed
  const ride = repo.createRide({
    driverId: driver.id,
    carId: car.id,
    originLat: DRIVER_ORIGIN_1.lat,
    originLng: DRIVER_ORIGIN_1.lng,
    originLabel: DRIVER_ORIGIN_1.label,
    destLat: DRIVER_DEST_1.lat,
    destLng: DRIVER_DEST_1.lng,
    destLabel: DRIVER_DEST_1.label,
    routeGeometry: null,
    estimatedDuration: DRIVE_DURATION_1,
    departureTime: minutesAgo(30),
    maxDetourMinutes: DEFAULTS.MAX_DETOUR_MINUTES,
    availableSeats: 3,
  });

  const candidates = await matching.findRidersForDriver(ride);

  // This assertion currently fails: the time-window check rejects the ride
  // because ride.departureTime (T-30) < request.earliestDeparture (T+0).
  // To fix: matching should compare estimated arrival-at-pickup time against
  // the rider's window, not the driver's original departure time.
  assert.equal(
    candidates.length,
    1,
    "driver approaching pickup point should still be offered to the rider " +
      "(KNOWN LIMITATION: currently fails because matching uses departure time, not arrival-at-pickup time)",
  );
});

// ---------------------------------------------------------------------------
// Scenario 6: Quick-filter rejection — pickup far off route
//
// A Haifa rider should never match a Tel Aviv → Jerusalem driver.
// The haversine quick-filter should eliminate them before OSRM is even called.
// We use a failing routing service to confirm that OSRM is never consulted.
// ---------------------------------------------------------------------------

test("pickup far off route (Haifa) is quick-filtered without calling OSRM", async () => {
  const { repo } = makeDb();
  const { user: driver, car } = seedDriver(repo, 6);
  const rider = seedRider(repo, 6);

  // Use a routing service that throws if called — confirms the quick-filter works
  const routingThatMustNotBeCalled = {
    calculateDetour: async () => {
      assert.fail("OSRM should not have been called — haversine filter should have rejected this");
    },
  } as unknown as RoutingService;

  const matching = new MatchingService(repo, routingThatMustNotBeCalled);

  repo.createRideRequest({
    riderId: rider.id,
    pickupLat: DRIVER_ORIGIN_2.lat,
    pickupLng: DRIVER_ORIGIN_2.lng,
    pickupLabel: DRIVER_ORIGIN_2.label,
    dropoffLat: DRIVER_DEST_1.lat,
    dropoffLng: DRIVER_DEST_1.lng,
    dropoffLabel: DRIVER_DEST_1.label,
    earliestDeparture: minutesFromNow(0),
    latestDeparture: minutesFromNow(60),
  });

  const ride = repo.createRide({
    driverId: driver.id,
    carId: car.id,
    originLat: DRIVER_ORIGIN_1.lat,
    originLng: DRIVER_ORIGIN_1.lng,
    originLabel: DRIVER_ORIGIN_1.label,
    destLat: DRIVER_DEST_1.lat,
    destLng: DRIVER_DEST_1.lng,
    destLabel: DRIVER_DEST_1.label,
    routeGeometry: null,
    estimatedDuration: DRIVE_DURATION_1,
    departureTime: minutesFromNow(5),
    maxDetourMinutes: DEFAULTS.MAX_DETOUR_MINUTES,
    availableSeats: 3,
  });

  const candidates = await matching.findRidersForDriver(ride);
  assert.equal(candidates.length, 0, "Haifa rider should not match TA→Jerusalem driver");
});

// ---------------------------------------------------------------------------
// Scenario 7: No match when OSRM reports too large a detour
//
// The detour is within the haversine quick-filter (pickup is geographically
// plausible) but the actual OSRM-computed detour exceeds maxDetourMinutes.
// ---------------------------------------------------------------------------

test("no match when OSRM detour exceeds driver's tolerance", async () => {
  const { repo } = makeDb();
  const { user: driver, car } = seedDriver(repo, 7);
  const rider = seedRider(repo, 7);

  // Detour of 7 min — exceeds default tolerance of 5 min
  const matching = new MatchingService(repo, makeRouting(7 * 60));

  repo.createRideRequest({
    riderId: rider.id,
    pickupLat: RIDER_ORIGIN_1.lat,
    pickupLng: RIDER_ORIGIN_1.lng,
    pickupLabel: RIDER_ORIGIN_1.label,
    dropoffLat: RIDER_DEST_1.lat,
    dropoffLng: RIDER_DEST_1.lng,
    dropoffLabel: RIDER_DEST_1.label,
    earliestDeparture: minutesFromNow(0),
    latestDeparture: minutesFromNow(60),
  });

  const ride = repo.createRide({
    driverId: driver.id,
    carId: car.id,
    originLat: DRIVER_ORIGIN_1.lat,
    originLng: DRIVER_ORIGIN_1.lng,
    originLabel: DRIVER_ORIGIN_1.label,
    destLat: DRIVER_DEST_1.lat,
    destLng: DRIVER_DEST_1.lng,
    destLabel: DRIVER_DEST_1.label,
    routeGeometry: null,
    estimatedDuration: DRIVE_DURATION_1,
    departureTime: minutesFromNow(5),
    maxDetourMinutes: DEFAULTS.MAX_DETOUR_MINUTES, // 5 min
    availableSeats: 3,
  });

  const candidates = await matching.findRidersForDriver(ride);
  assert.equal(candidates.length, 0, "7-minute detour should exceed the 5-minute tolerance");
});
