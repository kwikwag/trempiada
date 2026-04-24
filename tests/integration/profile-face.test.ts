/**
 * Integration tests for ProfileFaceService against real AWS Rekognition.
 *
 * Requires AWS credentials and AWS_REGION to be set in the environment.
 * Skipped automatically when credentials are absent.
 *
 * Test images in tests/assets/:
 *   ok-face.jpg       — clear front-facing selfie, expected to pass
 *   occluded-face.jpg — face partially hidden, expected to be rejected as occluded
 */

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { RekognitionClient } from "@aws-sdk/client-rekognition";
import { ProfileFaceService } from "../../src/services/identity/profile-face";

const ASSETS = path.join(__dirname, "..", "assets");

const region = process.env.AWS_REGION;
const skip = !region ? "AWS_REGION not set — skipping Rekognition integration tests" : false;

const DEFAULT_THRESHOLDS = {
  minSharpness: 40,
  minBrightness: 30,
  maxYaw: 20,
  maxPitch: 20,
  maxRoll: 15,
  outputSize: 512,
  cropPaddingRatio: 2.2,
};

function makeService() {
  return new ProfileFaceService({
    rekognition: new RekognitionClient({ region: region! }),
    thresholds: DEFAULT_THRESHOLDS,
  });
}

test("ok-face.jpg: accepted by Rekognition and cropped to a JPEG", { skip }, async () => {
  const buf = await readFile(path.join(ASSETS, "ok-face.jpg"));
  const result = await makeService().validateAndCropPhoto(buf, "image/jpeg");
  assert.ok(result.ok, `Expected ok but got: ${!result.ok && result.userMessage}`);
  assert.equal(result.mimeType, "image/jpeg");
  assert.ok(result.croppedBuffer.length > 0);
});

test("occluded-face.jpg: rejected as occluded by Rekognition", { skip }, async () => {
  const buf = await readFile(path.join(ASSETS, "occluded-face.jpg"));
  const result = await makeService().validateAndCropPhoto(buf, "image/jpeg");
  assert.ok(!result.ok, `Expected rejection but got ok`);
  assert.equal(result.rejectionCode, "occluded");
});
