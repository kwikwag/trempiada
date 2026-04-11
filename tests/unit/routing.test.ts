import assert from "node:assert/strict";
import test from "node:test";
import { RoutingService } from "../../src/services/routing";
import { withFetch } from "../helpers/fetch-mock";

const ORIGIN = { lat: 32.08, lng: 34.78 };
const DEST   = { lat: 31.77, lng: 35.21 };

// ---------------------------------------------------------------------------
// Response builders
// ---------------------------------------------------------------------------

function osrmRouteOk(distance = 80_000, duration = 3600, geometry = "abc123") {
  return { code: "Ok", routes: [{ distance, duration, geometry }] };
}

function osrmNearestOk(lng = 34.78, lat = 32.08) {
  return { code: "Ok", waypoints: [{ location: [lng, lat] }] };
}

// ---------------------------------------------------------------------------
// getRoute
// ---------------------------------------------------------------------------

test("getRoute returns RouteResult on valid OSRM response", async () => {
  const service = new RoutingService("http://osrm.test");

  const result = await withFetch({ "osrm.test": () => osrmRouteOk(80_000, 3600, "poly") }, () =>
    service.getRoute(ORIGIN, DEST)
  );

  assert.ok(result);
  assert.equal(result.distanceMeters, 80_000);
  assert.equal(result.durationSeconds, 3600);
  assert.equal(result.geometry, "poly");
});

test("getRoute returns null when OSRM code is not Ok", async () => {
  const service = new RoutingService("http://osrm.test");

  const result = await withFetch({ "osrm.test": () => ({ code: "NoRoute", routes: [] }) }, () =>
    service.getRoute(ORIGIN, DEST)
  );

  assert.equal(result, null);
});

test("getRoute returns null when routes array is empty", async () => {
  const service = new RoutingService("http://osrm.test");

  const result = await withFetch({ "osrm.test": () => ({ code: "Ok", routes: [] }) }, () =>
    service.getRoute(ORIGIN, DEST)
  );

  assert.equal(result, null);
});

test("getRoute returns null when response fails schema validation", async () => {
  const service = new RoutingService("http://osrm.test");
  // `code` must be a string
  const invalid = { code: 200, routes: [] };

  const result = await withFetch({ "osrm.test": () => invalid }, () =>
    service.getRoute(ORIGIN, DEST)
  );

  assert.equal(result, null);
});

test("getRoute returns null when a route entry is missing required fields", async () => {
  const service = new RoutingService("http://osrm.test");
  // `duration` is required on each route object
  const invalid = { code: "Ok", routes: [{ distance: 1000 }] };

  const result = await withFetch({ "osrm.test": () => invalid }, () =>
    service.getRoute(ORIGIN, DEST)
  );

  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// calculateDetour
// ---------------------------------------------------------------------------

const PICKUP  = { lat: 32.06, lng: 34.76 };
const DROPOFF = { lat: 31.90, lng: 35.00 };

test("calculateDetour returns DetourResult on valid OSRM responses", async () => {
  const service = new RoutingService("http://osrm.test");
  let callCount = 0;

  const result = await withFetch({
    "osrm.test": () => {
      // First call: direct route. Second call: detour route.
      callCount++;
      return callCount === 1
        ? osrmRouteOk(80_000, 3600, "poly")
        : { code: "Ok", routes: [{ distance: 95_000, duration: 4200 }] };
    },
  }, () => service.calculateDetour(ORIGIN, DEST, PICKUP, DROPOFF));

  assert.ok(result);
  assert.equal(result.originalDuration, 3600);
  assert.equal(result.detourDuration, 4200);
  assert.equal(result.addedSeconds, 600);
});

test("calculateDetour returns null when detour response fails schema validation", async () => {
  const service = new RoutingService("http://osrm.test");
  let callCount = 0;

  const result = await withFetch({
    "osrm.test": () => {
      callCount++;
      // First call (direct) succeeds; second call (detour) has invalid schema
      return callCount === 1
        ? osrmRouteOk(80_000, 3600, "poly")
        : { code: 999, routes: [] };
    },
  }, () => service.calculateDetour(ORIGIN, DEST, PICKUP, DROPOFF));

  assert.equal(result, null);
});

// ---------------------------------------------------------------------------
// findNearest
// ---------------------------------------------------------------------------

test("findNearest returns GeoPoint on valid OSRM response", async () => {
  const service = new RoutingService("http://osrm.test");

  const result = await withFetch({ "osrm.test": () => osrmNearestOk(34.79, 32.09) }, () =>
    service.findNearest(ORIGIN)
  );

  assert.ok(result);
  assert.equal(result.lng, 34.79);
  assert.equal(result.lat, 32.09);
});

test("findNearest returns null when OSRM code is not Ok", async () => {
  const service = new RoutingService("http://osrm.test");

  const result = await withFetch({ "osrm.test": () => ({ code: "NoSegment", waypoints: [] }) }, () =>
    service.findNearest(ORIGIN)
  );

  assert.equal(result, null);
});

test("findNearest returns null when response fails schema validation", async () => {
  const service = new RoutingService("http://osrm.test");
  // `location` must be a [number, number] tuple
  const invalid = { code: "Ok", waypoints: [{ location: "34.78,32.08" }] };

  const result = await withFetch({ "osrm.test": () => invalid }, () =>
    service.findNearest(ORIGIN)
  );

  assert.equal(result, null);
});
