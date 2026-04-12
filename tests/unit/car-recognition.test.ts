import assert from "node:assert/strict";
import test from "node:test";
import { CarRecognitionService } from "../../src/services/car-recognition";
import { LicenseLookupService } from "../../src/services/license-lookup";
import { DEFAULTS } from "../../src/types";
import { createTempLicenseDb } from "../helpers/license-db";
import { withFetch } from "../helpers/fetch-mock";

type FetchInput = Parameters<typeof global.fetch>[0];

// 457-11-302 stripped to digits
const TEST_PLATE_NO = 45711302;

// ---------------------------------------------------------------------------
// Fetch mock helpers
// ---------------------------------------------------------------------------

/** Build the JSON response shape the Gemini REST API returns. */
function geminiResponse(text: string) {
  return { candidates: [{ content: { parts: [{ text }] } }] };
}

/** Build a fake Telegram getFile response. */
function telegramFileResponse(filePath: string) {
  return { ok: true, result: { file_path: filePath } };
}

// ---------------------------------------------------------------------------
// Gemini vision response handling
// ---------------------------------------------------------------------------

test("analyzeCarImage returns CarDetails when Gemini responds correctly", async () => {
  const service = new CarRecognitionService("fake-key", "fake-token");
  const payload = geminiResponse(
    JSON.stringify({
      plateNumber: "457-11-302",
      make: "Audi",
      model: "Mexico",
      color: "Black",
      year: 2021,
    }),
  );

  const result = await withFetch({ "generativelanguage.googleapis.com": () => payload }, () =>
    service.analyzeCarImage(Buffer.from("fake")),
  );

  assert.ok(result, "expected a result");
  assert.equal(result.plateNumber, "45711302");
  assert.equal(result.make, "Audi");
  assert.equal(result.model, "Mexico");
  assert.equal(result.color, "Black");
  assert.equal(result.year, 2021);
  assert.equal(result.seatCount, DEFAULTS.DEFAULT_SEAT_COUNT);
});

test("analyzeCarImage returns null when Gemini signals not_a_car", async () => {
  const service = new CarRecognitionService("fake-key", "fake-token");
  const payload = geminiResponse(JSON.stringify({ error: "not_a_car" }));

  const result = await withFetch({ "generativelanguage.googleapis.com": () => payload }, () =>
    service.analyzeCarImage(Buffer.from("fake")),
  );

  assert.equal(result, null);
});

test("analyzeCarImage returns null when Gemini response has no candidates", async () => {
  const service = new CarRecognitionService("fake-key", "fake-token");

  const result = await withFetch(
    { "generativelanguage.googleapis.com": () => ({ candidates: [] }) },
    () => service.analyzeCarImage(Buffer.from("fake")),
  );

  assert.equal(result, null);
});

test("analyzeCarImage returns null when Gemini response fails schema validation", async () => {
  const service = new CarRecognitionService("fake-key", "fake-token");
  // `candidates` must be an array — a string fails the schema
  const invalid = { candidates: "not-an-array" };

  const result = await withFetch({ "generativelanguage.googleapis.com": () => invalid }, () =>
    service.analyzeCarImage(Buffer.from("fake")),
  );

  assert.equal(result, null);
});

test("analyzeCarImage returns null when Gemini candidate is missing content.parts", async () => {
  const service = new CarRecognitionService("fake-key", "fake-token");
  // `parts` must be an array — an object fails the schema
  const invalid = { candidates: [{ content: { parts: "not-an-array" } }] };

  const result = await withFetch({ "generativelanguage.googleapis.com": () => invalid }, () =>
    service.analyzeCarImage(Buffer.from("fake")),
  );

  assert.equal(result, null);
});

test("extractFromTelegramPhoto returns null when getFile response fails schema validation", async () => {
  const service = new CarRecognitionService("fake-key", "fake-token");
  // `ok` must be a boolean — a string fails the schema
  const invalid = { status: "ok" };

  const result = await withFetch({ "api.telegram.org": () => invalid }, () =>
    service.extractFromTelegramPhoto("file-id"),
  );

  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// LicenseLookup integration
// ---------------------------------------------------------------------------

test("analyzeCarImage enriches details from license DB when plate matches", async () => {
  const { dbPath, cleanup } = createTempLicenseDb(
    TEST_PLATE_NO,
    "Audi",
    "Mexico",
    "Black",
    2021,
    5,
  );
  const lookup = new LicenseLookupService(dbPath);
  const service = new CarRecognitionService("fake-key", "fake-token", lookup);

  // Gemini returns a slightly different model name; DB should win
  const payload = geminiResponse(
    JSON.stringify({
      plateNumber: "457-11-302",
      make: "Audi",
      model: "A3",
      color: "Dark",
      year: 2019,
    }),
  );

  try {
    const result = await withFetch({ "generativelanguage.googleapis.com": () => payload }, () =>
      service.analyzeCarImage(Buffer.from("fake")),
    );

    assert.ok(result);
    assert.equal(result.plateNumber, String(TEST_PLATE_NO));
    assert.equal(result.model, "Mexico"); // from DB
    assert.equal(result.color, "Black"); // from DB
    assert.equal(result.year, 2021); // from DB
    assert.equal(result.seatCount, 5); // from DB
  } finally {
    lookup.close();
    cleanup();
  }
});

test("analyzeCarImage falls back to Gemini data when plate is not in DB", async () => {
  const { dbPath, cleanup } = createTempLicenseDb(99999999, "Honda", "Civic", "Red", 2020, 5);
  const lookup = new LicenseLookupService(dbPath);
  const service = new CarRecognitionService("fake-key", "fake-token", lookup);

  const payload = geminiResponse(
    JSON.stringify({
      plateNumber: "457-11-302",
      make: "Audi",
      model: "Mexico",
      color: "Black",
      year: 2021,
    }),
  );

  try {
    const result = await withFetch({ "generativelanguage.googleapis.com": () => payload }, () =>
      service.analyzeCarImage(Buffer.from("fake")),
    );

    assert.ok(result);
    assert.equal(result.make, "Audi");
    assert.equal(result.model, "Mexico");
    assert.equal(result.seatCount, DEFAULTS.DEFAULT_SEAT_COUNT);
  } finally {
    lookup.close();
    cleanup();
  }
});

// ---------------------------------------------------------------------------
// Telegram fetch flow
// ---------------------------------------------------------------------------

test("extractFromTelegramPhoto returns null when getFile fails", async () => {
  const service = new CarRecognitionService("fake-key", "fake-token");

  const result = await withFetch({ "api.telegram.org": () => ({ ok: false }) }, () =>
    service.extractFromTelegramPhoto("bad-file-id"),
  );

  assert.equal(result, null);
});

test("extractFromTelegramPhoto returns null when download fails", async () => {
  const service = new CarRecognitionService("fake-key", "fake-token");
  let callCount = 0;

  const saved = global.fetch;
  global.fetch = (async (_input: FetchInput) => {
    callCount++;
    if (callCount === 1) {
      return {
        ok: true,
        json: async () => telegramFileResponse("photos/file.jpg"),
      } as unknown as Response;
    }
    throw new Error("network error");
  }) as typeof global.fetch;

  try {
    assert.equal(await service.extractFromTelegramPhoto("some-file-id"), null);
  } finally {
    global.fetch = saved;
  }
});

test("extractFromTelegramPhoto chains Telegram download into analyzeCarImage", async () => {
  const service = new CarRecognitionService("fake-key", "fake-token");
  const jpegHeader = Buffer.from([0xff, 0xd8, ...Array(10).fill(0)]);
  const payload = geminiResponse(
    JSON.stringify({
      plateNumber: "457-11-302",
      make: "Audi",
      model: "Mexico",
      color: "Black",
      year: 2021,
    }),
  );

  const saved = global.fetch;
  global.fetch = (async (input: FetchInput) => {
    const url = input.toString();
    if (url.includes("getFile"))
      return {
        ok: true,
        json: async () => telegramFileResponse("photos/file.jpg"),
      } as unknown as Response;
    if (url.includes("file/bot"))
      return { ok: true, arrayBuffer: async () => jpegHeader.buffer } as unknown as Response;
    if (url.includes("generativelanguage"))
      return { ok: true, json: async () => payload } as unknown as Response;
    throw new Error(`Unexpected: ${url}`);
  }) as typeof global.fetch;

  try {
    const result = await service.extractFromTelegramPhoto("file-id-123");
    assert.ok(result);
    assert.equal(result.make, "Audi");
  } finally {
    global.fetch = saved;
  }
});

// ---------------------------------------------------------------------------
// detectImageType
// ---------------------------------------------------------------------------

test("detectImageType detects JPEG by magic bytes", () => {
  const service = new CarRecognitionService("k", "t");
  assert.equal(service.detectImageType(Buffer.from([0xff, 0xd8, 0x00])), "image/jpeg");
});

test("detectImageType detects PNG by magic bytes", () => {
  const service = new CarRecognitionService("k", "t");
  assert.equal(service.detectImageType(Buffer.from([0x89, 0x50, 0x00])), "image/png");
});

test("detectImageType detects WebP by magic bytes", () => {
  const service = new CarRecognitionService("k", "t");
  assert.equal(service.detectImageType(Buffer.from([0x52, 0x49, 0x00])), "image/webp");
});

test("detectImageType defaults to JPEG for unknown format", () => {
  const service = new CarRecognitionService("k", "t");
  assert.equal(service.detectImageType(Buffer.from([0x00, 0x00, 0x00])), "image/jpeg");
});

// ---------------------------------------------------------------------------
// thinkingConfig — model generation routing
// ---------------------------------------------------------------------------

test("thinkingConfig returns thinkingBudget:0 for gemini-2 models", () => {
  for (const model of ["gemini-2.5-flash", "gemini-2.5-flash-lite", "gemini-2.0-flash"]) {
    const cfg = new CarRecognitionService("k", "t", undefined, model).thinkingConfig();
    assert.deepEqual(cfg, { thinkingBudget: 0 }, `expected gemini-2 config for ${model}`);
  }
});

test("thinkingConfig returns thinkingLevel:minimal for gemini-3 models", () => {
  for (const model of ["gemini-3.1-flash-lite-preview", "gemini-3.0-flash"]) {
    const cfg = new CarRecognitionService("k", "t", undefined, model).thinkingConfig();
    assert.deepEqual(cfg, { thinkingLevel: "minimal" }, `expected gemini-3 config for ${model}`);
  }
});

test("thinkingConfig returns empty object for unknown model families", () => {
  const cfg = new CarRecognitionService("k", "t", undefined, "some-other-model").thinkingConfig();
  assert.deepEqual(cfg, {});
});
