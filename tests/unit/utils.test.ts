import assert from "node:assert/strict";
import test from "node:test";
import { formatCarInfo, formatRideSummary, haversineKm } from "../../src/utils";
import type { Car } from "../../src/types";

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

test("formatCarInfo returns car details on one line", () => {
  const car: Car = {
    id: 1,
    userId: 1,
    plateNumber: "12-345-67",
    make: "Toyota",
    model: "Corolla",
    color: "white",
    year: 2020,
    seatCount: 4,
    photoFileId: null,
    isActive: true,
    createdAt: new Date().toISOString(),
  };

  assert.equal(formatCarInfo(car), "🚗 Toyota Corolla, white, 2020 🔢 Plate: 12-345-67");
});

test("formatRideSummary lists car details separately from seats", () => {
  const summary = formatRideSummary({
    originLabel: "Tel Aviv",
    destLabel: "Jerusalem",
    durationSeconds: 3600,
    departureTime: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    carInfo: "🚗 Toyota Corolla, white 🔢 Plate: 12-345-67",
    seats: 3,
    maxDetour: 10,
  });

  assert.match(summary, /🚗 Toyota Corolla, white 🔢 Plate: 12-345-67/);
  assert.match(summary, /👥 3 seats available/);
});
