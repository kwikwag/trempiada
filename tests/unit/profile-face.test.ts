import assert from "node:assert/strict";
import test from "node:test";
import sharp from "sharp";
import { ProfileFaceService } from "../../src/services/identity/profile-face";

const DEFAULT_THRESHOLDS = {
  minSharpness: 40,
  minBrightness: 30,
  maxYaw: 20,
  maxPitch: 20,
  maxRoll: 15,
  outputSize: 512,
  cropPaddingRatio: 2.2,
};

function okFaceResponse(overrides: Record<string, unknown> = {}) {
  return {
    FaceDetails: [
      {
        BoundingBox: { Left: 0.2, Top: 0.1, Width: 0.4, Height: 0.6 },
        Quality: { Sharpness: 90, Brightness: 80 },
        Pose: { Yaw: 5, Pitch: 3, Roll: 2 },
        FaceOccluded: { Value: false },
        ...overrides,
      },
    ],
  };
}

function makeService(rekognitionResponse: unknown) {
  return new ProfileFaceService({
    rekognition: { send: async () => rekognitionResponse } as any,
    thresholds: DEFAULT_THRESHOLDS,
  });
}

// Dummy buffer — fine for rejection tests where sharp is never reached
const DUMMY = Buffer.alloc(1);

test("validateAndCropPhoto — accepted: produces a non-empty JPEG buffer", async () => {
  // Need a real image here because sharp runs the actual crop
  const buf = await sharp({
    create: { width: 10, height: 10, channels: 3, background: { r: 255, g: 255, b: 255 } },
  })
    .jpeg()
    .toBuffer();
  const service = makeService(okFaceResponse());
  const result = await service.validateAndCropPhoto(buf, "image/jpeg");
  assert.ok(result.ok, `Expected ok but got: ${!result.ok && result.userMessage}`);
  assert.equal(result.mimeType, "image/jpeg");
  assert.ok(result.croppedBuffer.length > 0);
});

test("validateAndCropPhoto — occluded: rejected with occluded", async () => {
  const service = makeService(okFaceResponse({ FaceOccluded: { Value: true } }));
  const result = await service.validateAndCropPhoto(DUMMY, "image/jpeg");
  assert.ok(!result.ok);
  assert.equal(result.rejectionCode, "occluded");
});

test("validateAndCropPhoto — no face detected: rejected with no_face", async () => {
  const service = makeService({ FaceDetails: [] });
  const result = await service.validateAndCropPhoto(DUMMY, "image/jpeg");
  assert.ok(!result.ok);
  assert.equal(result.rejectionCode, "no_face");
});

test("validateAndCropPhoto — multiple faces: rejected with multiple_faces", async () => {
  const service = makeService({
    FaceDetails: [okFaceResponse().FaceDetails[0], okFaceResponse().FaceDetails[0]],
  });
  const result = await service.validateAndCropPhoto(DUMMY, "image/jpeg");
  assert.ok(!result.ok);
  assert.equal(result.rejectionCode, "multiple_faces");
});

test("validateAndCropPhoto — too blurry: rejected with too_blurry", async () => {
  const service = makeService(okFaceResponse({ Quality: { Sharpness: 10, Brightness: 80 } }));
  const result = await service.validateAndCropPhoto(DUMMY, "image/jpeg");
  assert.ok(!result.ok);
  assert.equal(result.rejectionCode, "too_blurry");
});

test("validateAndCropPhoto — too dark: rejected with too_dark", async () => {
  const service = makeService(okFaceResponse({ Quality: { Sharpness: 90, Brightness: 5 } }));
  const result = await service.validateAndCropPhoto(DUMMY, "image/jpeg");
  assert.ok(!result.ok);
  assert.equal(result.rejectionCode, "too_dark");
});

test("validateAndCropPhoto — bad pose (high yaw): rejected with bad_pose", async () => {
  const service = makeService(okFaceResponse({ Pose: { Yaw: 45, Pitch: 0, Roll: 0 } }));
  const result = await service.validateAndCropPhoto(DUMMY, "image/jpeg");
  assert.ok(!result.ok);
  assert.equal(result.rejectionCode, "bad_pose");
});

test("validateAndCropPhoto — Rekognition failure: rejected with detect_failed", async () => {
  const service = new ProfileFaceService({
    rekognition: {
      send: async () => {
        throw new Error("network error");
      },
    } as any,
    thresholds: DEFAULT_THRESHOLDS,
  });
  const result = await service.validateAndCropPhoto(DUMMY, "image/jpeg");
  assert.ok(!result.ok);
  assert.equal(result.rejectionCode, "detect_failed");
});
