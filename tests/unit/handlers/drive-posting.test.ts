import assert from "node:assert/strict";
import test from "node:test";
import { registerDrivePostingHandlers } from "../../../src/bot/handlers/drive-posting";
import { FakeBot, createDeps, inlineButtonTexts, makeCtx } from "./helpers";

function seedOpenRideForDriver() {
  const bot = new FakeBot();
  const { repo, sessions, deps } = createDeps();
  deps.matching = {
    findRidersForDriver: async () => [],
  } as any;

  const telegramId = 51_001;
  const driver = repo.createUser(telegramId, "Driver");
  const car = repo.addCar({
    userId: driver.id,
    plateNumber: "12-123-12",
    make: "Toyota",
    model: "Corolla",
    color: "White",
    year: 2020,
    seatCount: 4,
    photoFileId: null,
  });
  const ride = repo.createRide({
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
    departureTime: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    maxDetourMinutes: 10,
    availableSeats: 3,
  });

  sessions.setUserId(telegramId, driver.id);
  registerDrivePostingHandlers(bot as any, deps);

  return { bot, repo, sessions, telegramId, driverId: driver.id, rideId: ride.id };
}

test("edit_open_ride loads open offer into ride review with save-mode buttons", async () => {
  const { bot, sessions, telegramId, rideId } = seedOpenRideForDriver();

  await bot.actions.get("edit_open_ride")!(makeCtx({ telegramId }));

  const session = sessions.get(telegramId);
  assert.equal(session.scene, "ride_review");
  assert.equal(session.data.editingRideId, rideId);

  const actionCtx = makeCtx({ telegramId });
  await bot.actions.get("edit_open_ride")!(actionCtx);
  const buttons = inlineButtonTexts(actionCtx.edits.at(-1)?.extra);
  assert.ok(buttons.includes("Save changes ✅"));
  assert.ok(buttons.includes("Keep current offer"));
});

test("postRideFromSession while editing cancels old open offer and creates replacement", async () => {
  const { bot, repo, sessions, telegramId, driverId, rideId } = seedOpenRideForDriver();

  await bot.actions.get("edit_open_ride")!(makeCtx({ telegramId }));
  sessions.updateData(telegramId, { seats: 2 });

  await bot.actions.get("post_ride")!(makeCtx({ telegramId }));

  assert.equal(repo.getRideById(rideId)?.status, "cancelled");
  const newOpenRide = repo.getOpenRideForDriver(driverId);
  assert.ok(newOpenRide);
  assert.notEqual(newOpenRide?.id, rideId);
  assert.equal(newOpenRide?.availableSeats, 2);
});

test("matched or stale posted-offer edit callbacks force cancel-first flow", async () => {
  const matchedCase = seedOpenRideForDriver();
  const rider = matchedCase.repo.createUser(51_002, "Rider");
  const request = matchedCase.repo.createRideRequest({
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
  const match = matchedCase.repo.createMatch({
    rideId: matchedCase.rideId,
    requestId: request.id,
    riderId: rider.id,
    driverId: matchedCase.driverId,
    pickupLat: request.pickupLat,
    pickupLng: request.pickupLng,
    dropoffLat: request.dropoffLat,
    dropoffLng: request.dropoffLng,
    detourSeconds: 100,
    confirmationCode: "1234",
    pointsCost: 0,
  });
  matchedCase.repo.updateMatchStatus(match.id, "accepted");
  matchedCase.repo.updateRideStatus(matchedCase.rideId, "matched");
  matchedCase.repo.updateRequestStatus(request.id, "matched");
  matchedCase.sessions.setScene({
    telegramId: matchedCase.telegramId,
    scene: "ride_review",
    data: { editingRideId: matchedCase.rideId },
  });

  const matchedCtx = makeCtx({ telegramId: matchedCase.telegramId });
  await matchedCase.bot.actions.get("edit_ride_seats")!(matchedCtx);
  assert.match(matchedCtx.replies.at(-1)?.text ?? "", /cancel the ride first/i);

  const staleCase = seedOpenRideForDriver();
  staleCase.sessions.setScene({
    telegramId: staleCase.telegramId,
    scene: "ride_review",
    data: { editingRideId: staleCase.rideId + 999 },
  });
  const staleCtx = makeCtx({ telegramId: staleCase.telegramId });
  await staleCase.bot.actions.get("edit_ride_seats")!(staleCtx);
  assert.match(staleCtx.replies.at(-1)?.text ?? "", /no longer open/i);
});
