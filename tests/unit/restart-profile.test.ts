import assert from "node:assert/strict";
import test from "node:test";
import type { TrustVerification } from "../../src/types";
import {
  buildRestartConfirmationText,
  getSocialVerificationTypes,
  nextRestartProfileChoice,
} from "../../src/bot/handlers/restart-profile";

function verification(type: TrustVerification["type"]): TrustVerification {
  return {
    id: 1,
    userId: 1,
    type,
    verified: true,
    sharedWithRiders: true,
    externalRef: null,
    verifiedAt: new Date(0).toISOString(),
  };
}

test("getSocialVerificationTypes returns only social login verification types", () => {
  assert.deepEqual(
    getSocialVerificationTypes([
      verification("phone"),
      verification("car"),
      verification("facebook"),
      verification("google"),
      verification("photo"),
    ]),
    ["facebook", "google"],
  );
});

test("nextRestartProfileChoice asks for car before social accounts", () => {
  assert.equal(
    nextRestartProfileChoice({
      hasActiveCar: true,
      socialTypes: ["facebook"],
    }),
    "car",
  );
  assert.equal(
    nextRestartProfileChoice({
      hasActiveCar: true,
      socialTypes: ["facebook"],
      removeCar: false,
    }),
    "socials",
  );
  assert.equal(
    nextRestartProfileChoice({
      hasActiveCar: true,
      socialTypes: ["facebook"],
      removeCar: false,
      removeSocials: true,
    }),
    null,
  );
});

test("buildRestartConfirmationText includes keep/remove decisions", () => {
  assert.equal(
    buildRestartConfirmationText({
      newName: "Dana",
      newGender: "female",
      newPhotoFileId: "photo-file-id",
      hasActiveCar: true,
      socialTypes: ["facebook", "email"],
      removeCar: false,
      removeSocials: true,
    }),
    [
      "Here's your new profile:\n",
      "👤 Name: Dana",
      "⚧ Gender: Female",
      "📸 Photo: ✅",
      "🚗 Car: Keep on profile",
      "🔗 Social accounts: Forget Facebook, Email",
    ].join("\n"),
  );
});
