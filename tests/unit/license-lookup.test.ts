import assert from "node:assert/strict";
import test from "node:test";
import { LicenseLookupService } from "../../src/services/license-lookup";
import { createTempLicenseDb } from "../helpers/license-db";

test("LicenseLookupService returns car details by license plate", () => {
  const { dbPath, cleanup } = createTempLicenseDb(12345678, "Toyota", "Corolla", "White", 2021, 5);
  const service = new LicenseLookupService(dbPath);

  try {
    assert.deepEqual(service.getByLicensePlateNumber(12345678), {
      licensePlateNo: 12345678,
      make: "Toyota",
      model: "Corolla",
      color: "White",
      year: 2021,
      seats: 5,
    });
  } finally {
    service.close();
    cleanup();
  }
});

test("LicenseLookupService normalizes formatted plate strings", () => {
  const { dbPath, cleanup } = createTempLicenseDb(12345678, "Toyota", "Corolla", "White", 2021, 5);
  const service = new LicenseLookupService(dbPath);

  try {
    assert.equal(service.getByLicensePlateNumber("12-345-678")?.licensePlateNo, 12345678);
  } finally {
    service.close();
    cleanup();
  }
});

test("LicenseLookupService returns null when plate is not found", () => {
  const { dbPath, cleanup } = createTempLicenseDb(12345678, "Toyota", "Corolla", "White", 2021, 5);
  const service = new LicenseLookupService(dbPath);

  try {
    assert.equal(service.getByLicensePlateNumber(87654321), null);
  } finally {
    service.close();
    cleanup();
  }
});

test("LicenseLookupService rejects invalid plate numbers", () => {
  const { dbPath, cleanup } = createTempLicenseDb(12345678, "Toyota", "Corolla", "White", 2021, 5);
  const service = new LicenseLookupService(dbPath);

  try {
    assert.throws(() => service.getByLicensePlateNumber("123456"), /Expected 7 or 8 digits/);
  } finally {
    service.close();
    cleanup();
  }
});
