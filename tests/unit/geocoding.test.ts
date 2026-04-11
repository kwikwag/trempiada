import assert from "node:assert/strict";
import test from "node:test";
import { GeocodingService } from "../../src/services/geocoding";
import { withFetch, httpError } from "../helpers/fetch-mock";

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

function nominatimResult(lat = "32.0853", lon = "34.7818", display_name = "Dizengoff Street, Tel Aviv-Yafo, Israel") {
  return { lat, lon, display_name };
}

// ---------------------------------------------------------------------------
// geocode
// ---------------------------------------------------------------------------

test("geocode returns GeocodeResult on valid Nominatim response", async () => {
  const service = new GeocodingService("http://nominatim.test");

  const result = await withFetch({ "nominatim.test": () => [nominatimResult()] }, () =>
    service.geocode("Dizengoff Street, Tel Aviv")
  );

  assert.ok(result);
  assert.equal(result.lat, 32.0853);
  assert.equal(result.lng, 34.7818);
  assert.equal(result.label, "Dizengoff Street, Tel Aviv-Yafo, Israel");
});

test("geocode truncates label to 3 parts", async () => {
  const service = new GeocodingService("http://nominatim.test");
  const longName = "Street, City, District, Country, Extra";

  const result = await withFetch({ "nominatim.test": () => [nominatimResult("32.0", "34.7", longName)] }, () =>
    service.geocode("query")
  );

  assert.equal(result?.label, "Street, City, District");
});

test("geocode returns null when result array is empty", async () => {
  const service = new GeocodingService("http://nominatim.test");

  const result = await withFetch({ "nominatim.test": () => [] }, () =>
    service.geocode("unknown place")
  );

  assert.equal(result, null);
});

test("geocode returns null when response fails schema validation", async () => {
  const service = new GeocodingService("http://nominatim.test");
  // Each entry must have `lat`, `lon`, `display_name` — `coordinates` is not valid
  const invalid = [{ coordinates: [32.08, 34.78] }];

  const result = await withFetch({ "nominatim.test": () => invalid }, () =>
    service.geocode("Tel Aviv")
  );

  assert.equal(result, null);
});

test("geocode returns null when response is not an array", async () => {
  const service = new GeocodingService("http://nominatim.test");

  const result = await withFetch({ "nominatim.test": () => ({ error: "No results" }) }, () =>
    service.geocode("bogus")
  );

  assert.equal(result, null);
});

test("geocode returns null on HTTP error", async () => {
  const service = new GeocodingService("http://nominatim.test");
  const saved = global.fetch;
  global.fetch = (() => Promise.resolve(httpError(503)())) as typeof global.fetch;

  try {
    assert.equal(await service.geocode("Tel Aviv"), null);
  } finally {
    global.fetch = saved;
  }
});

// ---------------------------------------------------------------------------
// reverseGeocode
// ---------------------------------------------------------------------------

test("reverseGeocode returns label on valid Nominatim response", async () => {
  const service = new GeocodingService("http://nominatim.test");

  const result = await withFetch({ "nominatim.test": () => nominatimResult() }, () =>
    service.reverseGeocode(32.0853, 34.7818)
  );

  assert.equal(result, "Dizengoff Street, Tel Aviv-Yafo, Israel");
});

test("reverseGeocode returns null when response fails schema validation", async () => {
  const service = new GeocodingService("http://nominatim.test");
  // `lon` is required — missing it fails the schema
  const invalid = { lat: "32.08", display_name: "Tel Aviv" };

  const result = await withFetch({ "nominatim.test": () => invalid }, () =>
    service.reverseGeocode(32.08, 34.78)
  );

  assert.equal(result, null);
});

test("reverseGeocode returns null on HTTP error", async () => {
  const service = new GeocodingService("http://nominatim.test");
  const saved = global.fetch;
  global.fetch = (() => Promise.resolve(httpError(404)())) as typeof global.fetch;

  try {
    assert.equal(await service.reverseGeocode(0, 0), null);
  } finally {
    global.fetch = saved;
  }
});
