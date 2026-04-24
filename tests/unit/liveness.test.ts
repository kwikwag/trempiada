import assert from "node:assert/strict";
import test from "node:test";
import { FaceLivenessService } from "../../src/services/identity/liveness";

function createService({
  rekognitionResponses = [],
  stsCredentials = {
    Credentials: {
      AccessKeyId: "AKIA...",
      SecretAccessKey: "secret",
      SessionToken: "token",
    },
  },
}: {
  rekognitionResponses?: any[];
  stsCredentials?: any;
}) {
  const puts: any[] = [];
  let rekognitionIndex = 0;
  const service = new FaceLivenessService({
    rekognition: {
      send: async () => rekognitionResponses[rekognitionIndex++],
    } as any,
    sts: {
      send: async () => stsCredentials,
    } as any,
    dynamo: {
      send: async (command: any) => {
        puts.push(command.input);
        return {};
      },
    } as any,
    config: {
      region: "eu-west-1",
      livenessRoleArn: "arn:aws:iam::123456789012:role/trempiada-liveness",
      livenessBootstrapTable: "bootstrap-table",
      livenessRoleSessionName: "trempiada-liveness",
      livenessPagesUrl: "https://example.com/liveness",
      livenessTokenTtlSeconds: 180,
      livenessPollIntervalSeconds: 0,
      livenessMaxPollSeconds: 180,
      livenessConfidenceThreshold: 90,
      faceSimilarityThreshold: 90,
    },
  });

  return { service, puts };
}

test("createAttempt stores one bootstrap payload and returns a tokenized URL", async () => {
  const { service, puts } = createService({
    rekognitionResponses: [{ SessionId: "session-123" }],
  });

  const attempt = await service.createAttempt({
    userId: 7,
    profilePhotoFileId: "photo-file-id",
  });

  assert.equal(attempt.sessionId, "session-123");
  assert.match(attempt.url, /\?token=/);
  assert.equal(puts.length, 1);
  assert.equal(puts[0].TableName, "bootstrap-table");
  assert.equal(puts[0].Item.sessionId, "session-123");
  assert.equal(puts[0].Item.userId, 7);
});

test("pollForResult returns photo_changed when the user's photo changed mid-check", async () => {
  const { service } = createService({
    rekognitionResponses: [
      { Status: "SUCCEEDED", Confidence: 99, ReferenceImage: { Bytes: new Uint8Array([1]) } },
    ],
  });

  const result = await service.pollForResult({
    sessionId: "session-123",
    expectedProfilePhotoFileId: "old-photo",
    currentProfilePhotoFileId: "new-photo",
    profilePhotoBuffer: Buffer.from([1]),
  });

  assert.equal(result.status, "photo_changed");
});

test("pollForResult reports failed when similarity is below threshold", async () => {
  const { service } = createService({
    rekognitionResponses: [
      { Status: "SUCCEEDED", Confidence: 95, ReferenceImage: { Bytes: new Uint8Array([1]) } },
      { FaceMatches: [{ Similarity: 52 }] },
    ],
  });

  const result = await service.pollForResult({
    sessionId: "session-123",
    expectedProfilePhotoFileId: "same-photo",
    currentProfilePhotoFileId: "same-photo",
    profilePhotoBuffer: Buffer.from([1]),
  });

  assert.equal(result.status, "failed");
  assert.match(result.userMessage, /didn't match your profile photo/i);
});
