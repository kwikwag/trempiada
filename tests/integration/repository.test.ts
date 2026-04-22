import assert from "node:assert/strict";
import test from "node:test";
import { initDatabase } from "../../src/db/migrate";
import { Repository } from "../../src/db/repository";

function makeRepo(): Repository {
  return new Repository(initDatabase(":memory:"));
}

function minutesFromNow(n: number): string {
  return new Date(Date.now() + n * 60 * 1000).toISOString();
}

function seedDriver(repo: Repository, n = 1) {
  const user = repo.createUser(10_000 + n, `Driver${n}`);
  const car = repo.addCar(user.id, `12-345-${n}${n}`, "Toyota", "Corolla", "White", 2020, 4, null);
  return { user, car };
}

function seedRider(repo: Repository, n = 1) {
  return repo.createUser(20_000 + n, `Rider${n}`);
}

function createRide(repo: Repository, driverId: number, carId: number) {
  return repo.createRide({
    driverId,
    carId,
    originLat: 32.08,
    originLng: 34.78,
    originLabel: "Tel Aviv",
    destLat: 31.78,
    destLng: 35.22,
    destLabel: "Jerusalem",
    routeGeometry: null,
    estimatedDuration: 3600,
    departureTime: minutesFromNow(30),
    maxDetourMinutes: 5,
    availableSeats: 3,
  });
}

function createRequest(repo: Repository, riderId: number) {
  return repo.createRideRequest({
    riderId,
    pickupLat: 32.07,
    pickupLng: 34.77,
    pickupLabel: "Tel Aviv pickup",
    dropoffLat: 31.77,
    dropoffLng: 35.21,
    dropoffLabel: "Jerusalem dropoff",
    earliestDeparture: minutesFromNow(0),
    latestDeparture: minutesFromNow(60),
  });
}

test("open ride helpers return and cancel only the driver's open ride", () => {
  const repo = makeRepo();
  const { user: driver, car } = seedDriver(repo);

  const ride = createRide(repo, driver.id, car.id);
  assert.equal(repo.getOpenRideForDriver(driver.id)?.id, ride.id);
  assert.equal(repo.getActiveRideForDriver(driver.id)?.id, ride.id);

  const cancelled = repo.cancelOpenRideForDriver(driver.id);
  assert.equal(cancelled?.id, ride.id);
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(repo.getOpenRideForDriver(driver.id), null);
  assert.equal(repo.getRideById(ride.id)?.status, "cancelled");
});

test("open request helpers return, fetch, and cancel only the rider's open request", () => {
  const repo = makeRepo();
  const rider = seedRider(repo);

  const request = createRequest(repo, rider.id);
  assert.equal(repo.getRideRequestById(request.id)?.id, request.id);
  assert.equal(repo.getOpenRideRequestForRider(rider.id)?.id, request.id);

  const cancelled = repo.cancelOpenRideRequestForRider(rider.id);
  assert.equal(cancelled?.id, request.id);
  assert.equal(cancelled?.status, "cancelled");
  assert.equal(repo.getOpenRideRequestForRider(rider.id), null);
  assert.equal(repo.getRideRequestById(request.id)?.status, "cancelled");
});

test("open helpers ignore matched rides and requests once a match exists", () => {
  const repo = makeRepo();
  const { user: driver, car } = seedDriver(repo);
  const rider = seedRider(repo);
  const ride = createRide(repo, driver.id, car.id);
  const request = createRequest(repo, rider.id);

  const match = repo.createMatch({
    rideId: ride.id,
    requestId: request.id,
    riderId: rider.id,
    driverId: driver.id,
    pickupLat: request.pickupLat,
    pickupLng: request.pickupLng,
    dropoffLat: request.dropoffLat,
    dropoffLng: request.dropoffLng,
    detourSeconds: 60,
    confirmationCode: "1234",
    pointsCost: 0,
  });
  repo.updateMatchStatus(match.id, "accepted");
  repo.updateRideStatus(ride.id, "matched");
  repo.updateRequestStatus(request.id, "matched");

  assert.equal(repo.getOpenRideForDriver(driver.id), null);
  assert.equal(repo.getOpenRideRequestForRider(rider.id), null);
  assert.equal(repo.getActiveMatchForUser(driver.id)?.id, match.id);
  assert.equal(repo.getActiveMatchForUser(rider.id)?.id, match.id);
});
