import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "../../src/bot/session";
import { rideReviewContent, showStatus } from "../../src/bot/ui";
import { noopLogger } from "../../src/logger";
import { initDatabase } from "../../src/db/migrate";
import { Repository } from "../../src/db/repository";
import { makeCtx, inlineButtonTexts } from "./handlers/helpers";

test("rideReviewContent renders post vs save buttons based on editingRideId", () => {
  const sessions = new SessionManager(noopLogger);
  const telegramId = 71_001;

  sessions.setScene({
    telegramId,
    scene: "ride_review",
    data: {
      originLabel: "Tel Aviv",
      destLabel: "Jerusalem",
      estimatedDuration: 3600,
      departureTime: new Date().toISOString(),
      carInfo: "🚗 Car",
      seats: 3,
      maxDetour: 10,
    },
  });
  const postModeButtons = inlineButtonTexts(rideReviewContent(telegramId, sessions).extra);
  assert.ok(postModeButtons.includes("Post this ride ✅"));

  sessions.updateData(telegramId, {
    editingRideId: 1,
    originalSeats: 3,
    originalCarId: 1,
    carId: 1,
    originalDepartureTime: sessions.get(telegramId).data.departureTime,
    originalOriginLabel: "Tel Aviv",
    originalDestLabel: "Jerusalem",
  });
  const saveModeButtons = inlineButtonTexts(rideReviewContent(telegramId, sessions).extra);
  assert.ok(saveModeButtons.includes("Save changes ✅"));
});

test("showStatus includes modify actions for open driver offers and rider requests", async () => {
  const repo = new Repository(initDatabase(":memory:"));

  const driver = repo.createUser(71_010, "Driver");
  const car = repo.addCar({
    userId: driver.id,
    plateNumber: "22-222-22",
    make: "Toyota",
    model: "Corolla",
    color: "White",
    year: 2022,
    seatCount: 4,
    photoFileId: null,
  });
  repo.createRide({
    driverId: driver.id,
    carId: car.id,
    originLat: 32.08,
    originLng: 34.78,
    originLabel: "Tel Aviv",
    destLat: 31.77,
    destLng: 35.21,
    destLabel: "Jerusalem",
    routeGeometry: null,
    estimatedDuration: 3600,
    departureTime: new Date(Date.now() + 1800_000).toISOString(),
    maxDetourMinutes: 10,
    availableSeats: 3,
  });

  const driverCtx = makeCtx({ telegramId: driver.telegramId });
  await showStatus(driverCtx as any, { userId: driver.id, repo });
  const driverButtons = inlineButtonTexts(driverCtx.replies.at(-1)?.extra);
  assert.ok(driverButtons.includes("Modify offer"));

  const rider = repo.createUser(71_020, "Rider");
  repo.createRideRequest({
    riderId: rider.id,
    pickupLat: 32.07,
    pickupLng: 34.77,
    pickupLabel: "Pickup",
    dropoffLat: 31.8,
    dropoffLng: 35.2,
    dropoffLabel: "Dropoff",
    earliestDeparture: new Date().toISOString(),
    latestDeparture: new Date(Date.now() + 3600_000).toISOString(),
  });

  const riderCtx = makeCtx({ telegramId: rider.telegramId });
  await showStatus(riderCtx as any, { userId: rider.id, repo });
  const riderButtons = inlineButtonTexts(riderCtx.replies.at(-1)?.extra);
  assert.ok(riderButtons.includes("Modify request"));
});
