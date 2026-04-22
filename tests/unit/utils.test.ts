import assert from "node:assert/strict";
import test from "node:test";
import { haversineKm } from "../../src/utils";

test("haversineKm returns zero for the same point", () => {
  const telAviv = { lat: 32.0853, lng: 34.7818 };

  assert.equal(haversineKm({ from: telAviv, to: telAviv }), 0);
});

test("haversineKm measures distance between named coordinate endpoints", () => {
  const telAviv = { lat: 32.0853, lng: 34.7818 };
  const jerusalem = { lat: 31.7683, lng: 35.2137 };

  const distance = haversineKm({ from: telAviv, to: jerusalem });

  assert.ok(distance > 53);
  assert.ok(distance < 55);
});
