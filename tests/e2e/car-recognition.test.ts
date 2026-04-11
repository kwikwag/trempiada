/**
 * E2E tests for CarRecognitionService — hit the real Gemini API.
 *
 * Requires GEMINI_API_KEY (loaded from .env if present).
 * Uses the real data/licenses.db and tests/e2e/fixtures/test.jpg.
 *
 * Car in test.jpg: plate 457-11-302, 2021 black Audi Mexico, 5 seats.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { config as loadEnv } from "dotenv";
import { CarRecognitionService } from "../../src/services/car-recognition";
import { LicenseLookupService } from "../../src/services/license-lookup";

loadEnv({ path: join(__dirname, "../../.env") });

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const LICENSE_DB_PATH = join(__dirname, "../../data/licenses.db");
const FIXTURE_IMAGE   = join(__dirname, "fixtures/test.jpg");
const TEST_PLATE_NO   = 45711302; // 457-11-302

const skip = !GEMINI_API_KEY ? "GEMINI_API_KEY not set" : false;

test("e2e: identifies plate digits from test image", { skip }, async () => {
  const service = new CarRecognitionService(GEMINI_API_KEY!, "fake-token");

  const result = await service.analyzeCarImage(readFileSync(FIXTURE_IMAGE));
  console.log("Gemini response:", JSON.stringify(result, null, 2));

  assert.ok(result, "expected car details");
  assert.match(result.plateNumber, /^\d+$/, "plateNumber should contain only digits");
  assert.equal(result.plateNumber, String(TEST_PLATE_NO));
});

test("e2e: enriches Gemini output with real license DB", { skip }, async () => {
  const lookup = new LicenseLookupService(LICENSE_DB_PATH);
  const service = new CarRecognitionService(GEMINI_API_KEY!, "fake-token", lookup);

  try {
    const result = await service.analyzeCarImage(readFileSync(FIXTURE_IMAGE));
    console.log("Gemini response:", JSON.stringify(result, null, 2));

    assert.ok(result, "expected car details");
    assert.equal(result.plateNumber, String(TEST_PLATE_NO));
    // DB values (Hebrew strings from Israeli vehicle registry)
    assert.equal(result.make,      "אודי מכסיקו");
    assert.equal(result.color,     "שחור");
    assert.equal(result.year,      2021);
    assert.equal(result.seatCount, 5);
  } finally {
    lookup.close();
  }
});
