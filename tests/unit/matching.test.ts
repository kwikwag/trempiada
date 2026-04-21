import assert from "node:assert/strict";
import test from "node:test";
import { MatchingService } from "../../src/services/matching";
import type { Repository } from "../../src/db/repository";
import type { RoutingService } from "../../src/services/routing";
import type { Ride, RideRequest, DetourResult } from "../../src/types";

// ---------------------------------------------------------------------------
// Factories
// ---------------------------------------------------------------------------

function makeRide(overrides: Partial<Ride> = {}): Ride {
  return {
    id: 1,
    driverId: 10,
    carId: 1,
    originLat: 32.08,
    originLng: 34.78,
    destLat: 31.77,
    destLng: 35.21,
    originLabel: "Tel Aviv",
    destLabel: "Jerusalem",
    routeGeometry: null,
    estimatedDuration: 3600,
    departureTime: new Date(Date.now() + 10 * 60 * 1000).toISOString(), // 10 min from now
    maxDetourMinutes: 5,
    availableSeats: 3,
    status: "open",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function makeRequest(overrides: Partial<RideRequest> = {}): RideRequest {
  const now = Date.now();
  return {
    id: 2,
    riderId: 20,
    pickupLat: 32.06,
    pickupLng: 34.76,
    dropoffLat: 31.9,
    dropoffLng: 35.0,
    pickupLabel: "Holon",
    dropoffLabel: "Mevasseret Zion",
    earliestDeparture: new Date(now).toISOString(),
    latestDeparture: new Date(now + 60 * 60 * 1000).toISOString(),
    status: "open",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const DETOUR_OK: DetourResult = {
  originalDuration: 3600,
  detourDuration: 3840,
  addedSeconds: 240, // 4 min — within 5 min limit
  pickupPoint: { lat: 32.06, lng: 34.76 },
  dropoffPoint: { lat: 31.9, lng: 35.0 },
};

const DETOUR_OVER_LIMIT: DetourResult = {
  originalDuration: 3600,
  detourDuration: 4200,
  addedSeconds: 600, // 10 min — exceeds 5 min limit
  pickupPoint: { lat: 32.06, lng: 34.76 },
  dropoffPoint: { lat: 31.9, lng: 35.0 },
};

// ---------------------------------------------------------------------------
// Mock builders
// ---------------------------------------------------------------------------

function makeRepo(overrides: Partial<Repository> = {}): Repository {
  return {
    getOpenRequests: () => [],
    getOpenRides: () => [],
    getRecentSamePairCount: () => 0,
    createMatch: () => ({ id: 99 }) as any,
    updateRideStatus: () => {},
    updateRequestStatus: () => {},
    ...overrides,
  } as unknown as Repository;
}

function makeRouting(detour: DetourResult | null = DETOUR_OK): RoutingService {
  return {
    calculateDetour: async () => detour,
  } as unknown as RoutingService;
}

// ---------------------------------------------------------------------------
// findRidersForDriver
// ---------------------------------------------------------------------------

test("findRidersForDriver returns empty when no open requests", async () => {
  const service = new MatchingService(makeRepo(), makeRouting());
  const result = await service.findRidersForDriver(makeRide());
  assert.deepEqual(result, []);
});

test("findRidersForDriver excludes same user as rider", async () => {
  const req = makeRequest({ riderId: 10 }); // same as driverId
  const repo = makeRepo({ getOpenRequests: () => [req] });
  const service = new MatchingService(repo, makeRouting());
  const result = await service.findRidersForDriver(makeRide());
  assert.equal(result.length, 0);
});

test("findRidersForDriver excludes requests outside time window", async () => {
  const now = Date.now();
  // Request window is 2 hours from now — driver departs in 10 min (inside)... actually
  // let's make the ride depart BEFORE the earliest departure of the request
  const req = makeRequest({
    earliestDeparture: new Date(now + 2 * 60 * 60 * 1000).toISOString(),
    latestDeparture: new Date(now + 3 * 60 * 60 * 1000).toISOString(),
  });
  const repo = makeRepo({ getOpenRequests: () => [req] });
  const service = new MatchingService(repo, makeRouting());
  const result = await service.findRidersForDriver(makeRide());
  assert.equal(result.length, 0);
});

test("findRidersForDriver excludes same-pair within cooldown", async () => {
  const req = makeRequest();
  const repo = makeRepo({
    getOpenRequests: () => [req],
    getRecentSamePairCount: () => 1,
  });
  const service = new MatchingService(repo, makeRouting());
  const result = await service.findRidersForDriver(makeRide());
  assert.equal(result.length, 0);
});

test("findRidersForDriver excludes when detour exceeds max", async () => {
  const req = makeRequest();
  const repo = makeRepo({ getOpenRequests: () => [req] });
  const service = new MatchingService(repo, makeRouting(DETOUR_OVER_LIMIT));
  const result = await service.findRidersForDriver(makeRide());
  assert.equal(result.length, 0);
});

test("findRidersForDriver excludes when routing returns null", async () => {
  const req = makeRequest();
  const repo = makeRepo({ getOpenRequests: () => [req] });
  const service = new MatchingService(repo, makeRouting(null));
  const result = await service.findRidersForDriver(makeRide());
  assert.equal(result.length, 0);
});

test("findRidersForDriver returns candidate when all checks pass", async () => {
  const req = makeRequest();
  const repo = makeRepo({ getOpenRequests: () => [req] });
  const service = new MatchingService(repo, makeRouting());
  const result = await service.findRidersForDriver(makeRide());
  assert.equal(result.length, 1);
  assert.equal(result[0].request.id, req.id);
  assert.equal(result[0].detour.addedSeconds, DETOUR_OK.addedSeconds);
});

test("findRidersForDriver sorts by detour ascending", async () => {
  const req1 = makeRequest({ id: 2, riderId: 20 });
  const req2 = makeRequest({ id: 3, riderId: 21 });
  let call = 0;
  const repo = makeRepo({ getOpenRequests: () => [req1, req2] });
  const routing = {
    calculateDetour: async () => {
      call++;
      return call === 1 ? { ...DETOUR_OK, addedSeconds: 200 } : { ...DETOUR_OK, addedSeconds: 100 };
    },
  } as unknown as RoutingService;

  const service = new MatchingService(repo, routing);
  const result = await service.findRidersForDriver(makeRide());
  assert.equal(result.length, 2);
  assert.ok(result[0].detour.addedSeconds <= result[1].detour.addedSeconds);
});

// ---------------------------------------------------------------------------
// findDriversForRider
// ---------------------------------------------------------------------------

test("findDriversForRider returns empty when no open rides", async () => {
  const service = new MatchingService(makeRepo(), makeRouting());
  const result = await service.findDriversForRider(makeRequest());
  assert.deepEqual(result, []);
});

test("findDriversForRider excludes same user as driver", async () => {
  const ride = makeRide({ driverId: 20 }); // same as riderId
  const repo = makeRepo({ getOpenRides: () => [ride] });
  const service = new MatchingService(repo, makeRouting());
  const result = await service.findDriversForRider(makeRequest());
  assert.equal(result.length, 0);
});

test("findDriversForRider excludes rides with no available seats", async () => {
  const ride = makeRide({ availableSeats: 0 });
  const repo = makeRepo({ getOpenRides: () => [ride] });
  const service = new MatchingService(repo, makeRouting());
  const result = await service.findDriversForRider(makeRequest());
  assert.equal(result.length, 0);
});

test("findDriversForRider excludes rides outside time window", async () => {
  const now = Date.now();
  const ride = makeRide({
    departureTime: new Date(now + 3 * 60 * 60 * 1000).toISOString(), // 3h from now
  });
  const req = makeRequest({
    earliestDeparture: new Date(now).toISOString(),
    latestDeparture: new Date(now + 60 * 60 * 1000).toISOString(), // window closes in 1h
  });
  const repo = makeRepo({ getOpenRides: () => [ride] });
  const service = new MatchingService(repo, makeRouting());
  const result = await service.findDriversForRider(req);
  assert.equal(result.length, 0);
});

test("findDriversForRider excludes same-pair within cooldown", async () => {
  const ride = makeRide();
  const repo = makeRepo({
    getOpenRides: () => [ride],
    getRecentSamePairCount: () => 2,
  });
  const service = new MatchingService(repo, makeRouting());
  const result = await service.findDriversForRider(makeRequest());
  assert.equal(result.length, 0);
});

test("findDriversForRider excludes when detour exceeds max", async () => {
  const ride = makeRide();
  const repo = makeRepo({ getOpenRides: () => [ride] });
  const service = new MatchingService(repo, makeRouting(DETOUR_OVER_LIMIT));
  const result = await service.findDriversForRider(makeRequest());
  assert.equal(result.length, 0);
});

test("findDriversForRider returns match when all checks pass", async () => {
  const ride = makeRide();
  const repo = makeRepo({ getOpenRides: () => [ride] });
  const service = new MatchingService(repo, makeRouting());
  const result = await service.findDriversForRider(makeRequest());
  assert.equal(result.length, 1);
  assert.equal(result[0].ride.id, ride.id);
});

// ---------------------------------------------------------------------------
// createMatch
// ---------------------------------------------------------------------------

test("createMatch calls repo and returns a match with confirmation code", () => {
  let capturedArgs: any;
  const repo = makeRepo({
    createMatch: (args) => {
      capturedArgs = args;
      return { id: 99, ...args, status: "pending", createdAt: "" } as any;
    },
  });
  const service = new MatchingService(repo, makeRouting());
  const ride = makeRide();
  const req = makeRequest();

  const match = service.createMatch(ride, req, DETOUR_OK);

  assert.ok(match);
  assert.equal(capturedArgs.rideId, ride.id);
  assert.equal(capturedArgs.requestId, req.id);
  assert.equal(typeof capturedArgs.confirmationCode, "string");
  assert.equal(capturedArgs.confirmationCode.length, 4);
  assert.match(capturedArgs.confirmationCode, /^\d{4}$/);
});
