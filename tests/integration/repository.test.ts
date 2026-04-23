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
  const car = repo.addCar({
    userId: user.id,
    plateNumber: `12-345-${n}${n}`,
    make: "Toyota",
    model: "Corolla",
    color: "White",
    year: 2020,
    seatCount: 4,
    photoFileId: null,
  });
  return { user, car };
}

function seedRider(repo: Repository, n = 1) {
  return repo.createUser(20_000 + n, `Rider${n}`);
}

function createRide({
  repo,
  driverId,
  carId,
}: {
  repo: Repository;
  driverId: number;
  carId: number;
}) {
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

  const ride = createRide({ repo, driverId: driver.id, carId: car.id });
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
  const ride = createRide({ repo, driverId: driver.id, carId: car.id });
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

test("repository supports CRUD for users, cars, rides, requests, and matches", () => {
  const repo = makeRepo();
  const user = repo.createUser(77_001, "Alice");
  assert.equal(repo.getUserByTelegramId(77_001)?.id, user.id);

  repo.updateUserProfile(user.id, {
    firstName: "Alice Updated",
    gender: "female",
    photoFileId: "photo-file",
  });
  assert.equal(repo.getUserById(user.id)?.firstName, "Alice Updated");

  const car = repo.addCar({
    userId: user.id,
    plateNumber: "11-222-33",
    make: "Hyundai",
    model: "Ioniq",
    color: "Blue",
    year: 2021,
    seatCount: 4,
    photoFileId: "car-photo",
  });
  assert.equal(repo.getActiveCar(user.id)?.id, car.id);

  const ride = repo.createRide({
    driverId: user.id,
    carId: car.id,
    originLat: 32.08,
    originLng: 34.78,
    originLabel: "Origin",
    destLat: 31.77,
    destLng: 35.21,
    destLabel: "Dest",
    routeGeometry: null,
    estimatedDuration: 3600,
    departureTime: minutesFromNow(30),
    maxDetourMinutes: 10,
    availableSeats: 2,
  });
  assert.equal(repo.getRideById(ride.id)?.status, "open");

  const rider = repo.createUser(77_002, "Bob");
  const request = repo.createRideRequest({
    riderId: rider.id,
    pickupLat: 32.1,
    pickupLng: 34.8,
    pickupLabel: "Pickup",
    dropoffLat: 31.8,
    dropoffLng: 35.1,
    dropoffLabel: "Dropoff",
    earliestDeparture: minutesFromNow(0),
    latestDeparture: minutesFromNow(60),
  });
  assert.equal(repo.getRideRequestById(request.id)?.status, "open");

  const match = repo.createMatch({
    rideId: ride.id,
    requestId: request.id,
    riderId: rider.id,
    driverId: user.id,
    pickupLat: request.pickupLat,
    pickupLng: request.pickupLng,
    dropoffLat: request.dropoffLat,
    dropoffLng: request.dropoffLng,
    detourSeconds: 180,
    confirmationCode: "9999",
    pointsCost: 0,
  });
  assert.equal(repo.getMatchById(match.id)?.status, "pending");

  repo.updateMatchStatus(match.id, "accepted");
  repo.updateRideStatus(ride.id, "matched");
  repo.updateRequestStatus(request.id, "matched");
  assert.equal(repo.getMatchById(match.id)?.status, "accepted");
  assert.equal(repo.getRideById(ride.id)?.status, "matched");
  assert.equal(repo.getRideRequestById(request.id)?.status, "matched");
});

test("anonymizeUser removes PII while keeping user row", () => {
  const repo = makeRepo();
  const user = repo.createUser(77_100, "Sensitive User");
  repo.updateUserProfile(user.id, {
    gender: "male",
    photoFileId: "private-photo",
    phone: "+972123456",
  });
  repo.addVerification({ userId: user.id, type: "facebook", externalRef: "fb:secret" });
  repo.addCar({
    userId: user.id,
    plateNumber: "99-999-99",
    make: "Toyota",
    model: "Yaris",
    color: "Silver",
    year: 2019,
    seatCount: 4,
    photoFileId: "car-private-photo",
  });

  repo.anonymizeUser(user.id);

  const anonymized = repo.getUserById(user.id)!;
  assert.equal(anonymized.firstName, "Deleted User");
  assert.equal(anonymized.gender, null);
  assert.equal(anonymized.photoFileId, null);
  assert.equal(anonymized.phone, null);
  assert.equal(anonymized.isSuspended, true);
  assert.equal(repo.getVerifications(user.id).length, 0);
  assert.equal(repo.getActiveCar(user.id)?.plateNumber, "DELETED");
});

test("adjustPoints updates balance and getPointsBalance returns it", () => {
  const repo = makeRepo();
  const user = repo.createUser(77_200, "Points User");

  assert.equal(repo.getPointsBalance(user.id), 5);
  repo.adjustPoints(user.id, 2.5);
  assert.equal(repo.getPointsBalance(user.id), 7.5);
  repo.adjustPoints(user.id, -1.2);
  assert.equal(repo.getPointsBalance(user.id), 6.3);
});
