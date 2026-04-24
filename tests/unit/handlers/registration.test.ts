import assert from "node:assert/strict";
import test from "node:test";
import { registerRegistrationHandlers } from "../../../src/bot/handlers/registration";
import { FakeBot, createDeps, inlineButtonTexts, makeCtx } from "./helpers";

test("restart profile review asks car and social keep/remove questions after photo confirmation", async () => {
  const bot = new FakeBot();
  const { repo, sessions, deps } = createDeps();
  const telegramId = 30_001;
  const user = repo.createUser(telegramId, "Old Name");
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
  repo.addVerification({ userId: user.id, type: "car" });
  repo.addVerification({ userId: user.id, type: "facebook", externalRef: "fb" });
  repo.addVerification({ userId: user.id, type: "google", externalRef: "google" });

  const { handleMessage } = registerRegistrationHandlers({
    bot: bot as any,
    deps,
    startDrivePostingFlow: async () => undefined,
    startRideRequestFlow: async () => undefined,
    createWazeDriveFromUrl: async () => false,
  });

  sessions.setUserId(telegramId, user.id);
  sessions.setScene({
    telegramId,
    scene: "registration_photo",
    data: {
      restartMode: true,
      newName: "New Name",
      newGender: "female",
    },
  });

  const photoCtx = makeCtx({
    telegramId,
    message: { photo: [{ file_id: "small" }, { file_id: "new-photo" }] },
  });
  assert.equal(await handleMessage(photoCtx as any), true);
  assert.equal(sessions.get(telegramId).scene, "registration_photo_confirm");

  const confirmPhotoCtx = makeCtx({ telegramId });
  await bot.actions.get("photo_confirm_use")!(confirmPhotoCtx);
  assert.match(confirmPhotoCtx.replies.at(-1)?.text ?? "", /Remove your car from your profile\?/);
  assert.deepEqual(inlineButtonTexts(confirmPhotoCtx.replies.at(-1)?.extra).slice(0, 2), [
    "Yes, remove it",
    "No, keep it",
  ]);

  const keepCarCtx = makeCtx({ telegramId });
  await bot.actions.get("restart_remove_car_no")!(keepCarCtx);
  assert.match(
    keepCarCtx.edits.at(-1)?.text ?? "",
    /Forget associations with the following social accounts\?/,
  );
  assert.match(keepCarCtx.edits.at(-1)?.text ?? "", /Facebook, Google/);
  assert.deepEqual(inlineButtonTexts(keepCarCtx.edits.at(-1)?.extra).slice(0, 2), [
    "Yes, forget them",
    "No, keep them",
  ]);

  const forgetSocialsCtx = makeCtx({ telegramId });
  await bot.actions.get("restart_remove_socials_yes")!(forgetSocialsCtx);
  const finalText = forgetSocialsCtx.edits.at(-1)?.text ?? "";
  assert.match(finalText, /Here's your new profile:/);
  assert.match(finalText, /Name: New Name/);
  assert.match(finalText, /Car: Keep on profile/);
  assert.match(finalText, /Social accounts: Forget Facebook, Google/);
  assert.deepEqual(inlineButtonTexts(forgetSocialsCtx.edits.at(-1)?.extra), [
    "✅ Confirm, update my profile",
    "✗ Cancel, keep current profile",
  ]);
});

test("registration photo upload validates, crops, and waits for confirmation", async () => {
  const bot = new FakeBot();
  const { repo, sessions, deps } = createDeps();
  const telegramId = 30_002;
  const user = repo.createUser(telegramId, "Dana");

  const { handleMessage } = registerRegistrationHandlers({
    bot: bot as any,
    deps,
    startDrivePostingFlow: async () => undefined,
    startRideRequestFlow: async () => undefined,
    createWazeDriveFromUrl: async () => false,
  });

  sessions.setUserId(telegramId, user.id);
  sessions.setScene({ telegramId, scene: "registration_photo", data: {} });

  const photoCtx = makeCtx({
    telegramId,
    message: { photo: [{ file_id: "small" }, { file_id: "new-photo" }] },
  });
  assert.equal(await handleMessage(photoCtx as any), true);
  assert.equal(sessions.get(telegramId).scene, "registration_photo_confirm");
  assert.equal(sessions.get(telegramId).data.candidatePhotoFileId, "generated-photo-file");
  assert.match(photoCtx.photoReplies.at(-1)?.extra?.caption ?? "", /cropped that photo/i);

  const confirmCtx = makeCtx({ telegramId });
  await bot.actions.get("photo_confirm_use")!(confirmCtx);
  assert.equal(repo.getUserById(user.id)?.photoFileId, "generated-photo-file");
  assert.ok(repo.getVerifications(user.id).some((v) => v.type === "photo"));
});
