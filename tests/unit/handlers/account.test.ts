import assert from "node:assert/strict";
import test from "node:test";
import type { VerificationType } from "../../../src/types";
import { registerAccountHandlers } from "../../../src/bot/handlers/account";
import { FakeBot, createDeps, inlineButtonTexts, makeCtx } from "./helpers";

function seedRestartProfileCase({
  restartRemoveCar,
  restartRemoveSocials,
}: {
  restartRemoveCar: boolean;
  restartRemoveSocials: boolean;
}) {
  const bot = new FakeBot();
  const { repo, sessions, deps } = createDeps();
  const telegramId = 40_001;
  const user = repo.createUser(telegramId, "Old Name");
  repo.updateUserProfile(user.id, { gender: "male", photoFileId: "old-photo" });
  repo.addCar({
    userId: user.id,
    plateNumber: "12-345-67",
    make: "Toyota",
    model: "Corolla",
    color: "White",
    year: 2020,
    seatCount: 4,
    photoFileId: "car-photo",
  });
  for (const type of ["photo", "car", "facebook", "linkedin", "google"] as const) {
    repo.addVerification({ userId: user.id, type, externalRef: `${type}-ref` });
  }

  sessions.setUserId(telegramId, user.id);
  sessions.setScene({
    telegramId,
    scene: "profile_restart_confirm",
    data: {
      restartMode: true,
      newName: "New Name",
      newGender: "female",
      newPhotoFileId: "new-photo",
      restartRemoveCar,
      restartRemoveSocials,
    },
  });

  registerAccountHandlers(bot as any, deps);

  return { bot, repo, telegramId, userId: user.id };
}

function verificationTypes(
  repo: ReturnType<typeof createDeps>["repo"],
  userId: number,
): Set<string> {
  return new Set(repo.getVerifications(userId).map((v) => v.type));
}

test("restart_apply keeps active cars and social verifications when choices are No", async () => {
  const { bot, repo, telegramId, userId } = seedRestartProfileCase({
    restartRemoveCar: false,
    restartRemoveSocials: false,
  });

  await bot.actions.get("restart_apply")!(makeCtx({ telegramId }));

  const user = repo.getUserById(userId)!;
  assert.equal(user.firstName, "New Name");
  assert.equal(user.gender, "female");
  assert.equal(user.photoFileId, "new-photo");
  assert.notEqual(repo.getActiveCar(userId), null);
  assert.deepEqual(
    verificationTypes(repo, userId),
    new Set<VerificationType>(["photo", "car", "facebook", "linkedin", "google"]),
  );
});

test("restart_apply removes only car data when restartRemoveCar is true", async () => {
  const { bot, repo, telegramId, userId } = seedRestartProfileCase({
    restartRemoveCar: true,
    restartRemoveSocials: false,
  });

  await bot.actions.get("restart_apply")!(makeCtx({ telegramId }));

  assert.equal(repo.getActiveCar(userId), null);
  assert.deepEqual(
    verificationTypes(repo, userId),
    new Set<VerificationType>(["photo", "facebook", "linkedin", "google"]),
  );
});

test("restart_apply removes only social verifications when restartRemoveSocials is true", async () => {
  const { bot, repo, telegramId, userId } = seedRestartProfileCase({
    restartRemoveCar: false,
    restartRemoveSocials: true,
  });

  await bot.actions.get("restart_apply")!(makeCtx({ telegramId }));

  assert.notEqual(repo.getActiveCar(userId), null);
  assert.deepEqual(verificationTypes(repo, userId), new Set<VerificationType>(["photo", "car"]));
});

test("back_to_menu resets draft flow and returns user to main menu when no active activity exists", async () => {
  const bot = new FakeBot();
  const { repo, sessions, deps } = createDeps();
  const telegramId = 40_010;
  const user = repo.createUser(telegramId, "Dana");
  sessions.setUserId(telegramId, user.id);
  sessions.setScene({
    telegramId,
    scene: "ride_origin",
    data: { originLabel: "Draft start" },
  });
  registerAccountHandlers(bot as any, deps);

  const ctx = makeCtx({ telegramId });
  await bot.actions.get("back_to_menu")!(ctx);

  assert.equal(sessions.get(telegramId).scene, "idle");
  assert.equal(sessions.get(telegramId).data.originLabel, undefined);
  assert.equal(ctx.edits.at(-1)?.text, "Left that flow.");
  assert.equal(ctx.replies.at(-1)?.text, "What would you like to do, Dana?");
  const buttons = inlineButtonTexts(ctx.replies.at(-1)?.extra);
  assert.ok(buttons.includes("🚗 Offer a ride"));
});

test("back_to_menu keeps open request active and returns user to status", async () => {
  const bot = new FakeBot();
  const { repo, sessions, deps } = createDeps();
  const telegramId = 40_011;
  const user = repo.createUser(telegramId, "Rider");
  const request = repo.createRideRequest({
    riderId: user.id,
    pickupLat: 32.07,
    pickupLng: 34.77,
    pickupLabel: "Tel Aviv",
    dropoffLat: 31.77,
    dropoffLng: 35.21,
    dropoffLabel: "Jerusalem",
    earliestDeparture: new Date().toISOString(),
    latestDeparture: new Date(Date.now() + 3600_000).toISOString(),
  });
  sessions.setUserId(telegramId, user.id);
  sessions.setScene({
    telegramId,
    scene: "request_pickup",
    data: { pickupLabel: "Unsaved draft pickup" },
  });
  registerAccountHandlers(bot as any, deps);

  const ctx = makeCtx({ telegramId });
  await bot.actions.get("back_to_menu")!(ctx);

  assert.equal(sessions.get(telegramId).scene, "idle");
  assert.equal(repo.getOpenRideRequestForRider(user.id)?.id, request.id);
  assert.match(ctx.replies.at(-1)?.text ?? "", /You are requesting a ride/i);
  const buttons = inlineButtonTexts(ctx.replies.at(-1)?.extra);
  assert.ok(buttons.includes("Modify request"));
  assert.ok(buttons.includes("Cancel request"));
});
