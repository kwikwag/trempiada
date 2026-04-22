import assert from "node:assert/strict";
import test from "node:test";
import type { VerificationType } from "../../../src/types";
import { registerAccountHandlers } from "../../../src/bot/handlers/account";
import { FakeBot, createDeps, makeCtx } from "./helpers";

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
