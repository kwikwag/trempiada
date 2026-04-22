import assert from "node:assert/strict";
import test from "node:test";
import { initDatabase } from "../../src/db/migrate";
import { DevRepository } from "../../src/db/dev-repository";
import { Repository } from "../../src/db/repository";

function makeRepos(): { repo: Repository; devRepo: DevRepository } {
  const db = initDatabase(":memory:");
  return { repo: new Repository(db), devRepo: new DevRepository(db) };
}

function minutesFromNow(n: number): string {
  return new Date(Date.now() + n * 60 * 1000).toISOString();
}

function seedDriver(repo: Repository) {
  const user = repo.createUser(10_001, "Driver");
  const car = repo.addCar(user.id, "12-345-67", "Toyota", "Corolla", "White", 2020, 4, null);
  return { user, car };
}

function seedRider(repo: Repository) {
  return repo.createUser(20_001, "Rider");
}

test("hardDeleteUserByTelegramId removes the user's data and cancels linked activity", () => {
  const { repo, devRepo } = makeRepos();
  const { user: driver, car } = seedDriver(repo);
  const rider = seedRider(repo);
  const ride = repo.createRide({
    driverId: driver.id,
    carId: car.id,
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
  const request = repo.createRideRequest({
    riderId: rider.id,
    pickupLat: 32.07,
    pickupLng: 34.77,
    pickupLabel: "Tel Aviv pickup",
    dropoffLat: 31.77,
    dropoffLng: 35.21,
    dropoffLabel: "Jerusalem dropoff",
    earliestDeparture: minutesFromNow(0),
    latestDeparture: minutesFromNow(60),
  });
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
  repo.updateMatchStatus(match.id, "completed");
  repo.updateRideStatus(ride.id, "completed");
  repo.updateRequestStatus(request.id, "completed");
  repo.addRating(match.id, rider.id, driver.id, 5, null);
  repo.createDispute(match.id, rider.id, "test dispute");

  assert.equal(devRepo.hardDeleteUserByTelegramId(driver.telegramId), true);

  assert.equal(repo.getUserByTelegramId(driver.telegramId), null);
  assert.equal(repo.getActiveCar(driver.id), null);
  assert.equal(repo.getRideById(ride.id), null);
  assert.equal(repo.getMatchById(match.id), null);
  assert.deepEqual(repo.getRatingsForMatch(match.id), []);
  assert.equal(repo.getRideRequestById(request.id)?.status, "cancelled");
  assert.equal(repo.getUserByTelegramId(rider.telegramId)?.id, rider.id);
});

test("hardDeleteUserByTelegramId returns false when no user exists", () => {
  const { devRepo } = makeRepos();

  assert.equal(devRepo.hardDeleteUserByTelegramId(404_404), false);
});
