import assert from "node:assert/strict";
import test from "node:test";
import {
  registerRideRequestHandlers,
  handleRideRequestMessage,
} from "../../../src/bot/handlers/ride-request";
import { FakeBot, createDeps, inlineButtonTexts, makeCtx } from "./helpers";

function seedOpenRequest() {
  const bot = new FakeBot();
  const { repo, sessions, deps } = createDeps();
  deps.matching = {
    findDriversForRider: async () => [],
  } as any;

  const telegramId = 61_001;
  const rider = repo.createUser(telegramId, "Rider");
  const request = repo.createRideRequest({
    riderId: rider.id,
    pickupLat: 32.07,
    pickupLng: 34.77,
    pickupLabel: "Tel Aviv",
    dropoffLat: 31.77,
    dropoffLng: 35.21,
    dropoffLabel: "Jerusalem",
    earliestDeparture: new Date().toISOString(),
    latestDeparture: new Date(Date.now() + 3600_000).toISOString(),
  });

  sessions.setUserId(telegramId, rider.id);
  registerRideRequestHandlers(bot as any, deps);

  return { bot, repo, sessions, deps, telegramId, riderId: rider.id, requestId: request.id };
}

test("edit_open_request blocks active matches and otherwise loads request into edit mode", async () => {
  const blocked = seedOpenRequest();
  const driver = blocked.repo.createUser(61_002, "Driver");
  const car = blocked.repo.addCar({
    userId: driver.id,
    plateNumber: "12-333-44",
    make: "Mazda",
    model: "3",
    color: "Black",
    year: 2018,
    seatCount: 4,
    photoFileId: null,
  });
  const ride = blocked.repo.createRide({
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
    departureTime: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    maxDetourMinutes: 10,
    availableSeats: 3,
  });
  const match = blocked.repo.createMatch({
    rideId: ride.id,
    requestId: blocked.requestId,
    riderId: blocked.riderId,
    driverId: driver.id,
    pickupLat: 32.07,
    pickupLng: 34.77,
    dropoffLat: 31.77,
    dropoffLng: 35.21,
    detourSeconds: 100,
    confirmationCode: "2222",
    pointsCost: 0,
  });
  blocked.repo.updateMatchStatus(match.id, "accepted");
  blocked.repo.updateRideStatus(ride.id, "matched");
  blocked.repo.updateRequestStatus(blocked.requestId, "matched");

  const blockedCtx = makeCtx({ telegramId: blocked.telegramId });
  await blocked.bot.actions.get("edit_open_request")!(blockedCtx);
  assert.match(blockedCtx.replies.at(-1)?.text ?? "", /cancel the ride first/i);

  const open = seedOpenRequest();
  const openCtx = makeCtx({ telegramId: open.telegramId });
  await open.bot.actions.get("edit_open_request")!(openCtx);
  assert.equal(open.sessions.get(open.telegramId).scene, "request_review");
  const buttons = inlineButtonTexts(openCtx.edits.at(-1)?.extra);
  assert.ok(buttons.includes("Save changes ✅"));
});

test("request pickup/dropoff/time edits return to review without cancelling open request", async () => {
  const { bot, sessions, deps, telegramId, requestId } = seedOpenRequest();
  await bot.actions.get("edit_open_request")!(makeCtx({ telegramId }));

  await bot.actions.get("edit_request_pickup")!(makeCtx({ telegramId }));
  assert.equal(sessions.get(telegramId).scene, "request_pickup");

  deps.geocoding = {
    geocode: async () => ({ lat: 32.12, lng: 34.81, label: "New Pickup" }),
  } as any;
  await handleRideRequestMessage(
    makeCtx({ telegramId, message: { text: "New Pickup" } }) as any,
    deps,
  );
  assert.equal(sessions.get(telegramId).scene, "request_review");

  await bot.actions.get("edit_request_dropoff")!(makeCtx({ telegramId }));
  deps.geocoding = {
    geocode: async () => ({ lat: 31.9, lng: 35.05, label: "New Dropoff" }),
  } as any;
  await handleRideRequestMessage(
    makeCtx({ telegramId, message: { text: "New Dropoff" } }) as any,
    deps,
  );
  assert.equal(sessions.get(telegramId).scene, "request_review");

  await bot.actions.get("edit_request_time")!(makeCtx({ telegramId }));
  await bot.actions.get("req_time_60")!(makeCtx({ telegramId }));
  assert.equal(sessions.get(telegramId).scene, "request_review");
  assert.equal(sessions.get(telegramId).data.editingRequestId, requestId);
});

test("save_request_changes replaces previous open request", async () => {
  const { bot, repo, sessions, telegramId, riderId, requestId } = seedOpenRequest();
  await bot.actions.get("edit_open_request")!(makeCtx({ telegramId }));

  sessions.updateData(telegramId, { pickupLabel: "Updated Pickup" });
  await bot.actions.get("save_request_changes")!(makeCtx({ telegramId }));

  assert.equal(repo.getRideRequestById(requestId)?.status, "cancelled");
  const nextOpen = repo.getOpenRideRequestForRider(riderId);
  assert.ok(nextOpen);
  assert.notEqual(nextOpen?.id, requestId);
  assert.equal(nextOpen?.pickupLabel, "Updated Pickup");
});
