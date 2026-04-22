import assert from "node:assert/strict";
import test from "node:test";
import { extractWazeDriveUrl, extractWazeSdToken, WazeService } from "../../src/services/waze";

const wazeResponse = {
  mood: 1,
  lonlatTimestamp: 1700000000000,
  lon: 34.7812641,
  lat: 32.0140468,
  calculatedLocation: {
    city: "Jerusalem",
    street: "Ha-Sifriya Ha-Leumit",
    latitude: 31.7718109,
    venueId: "waze.street-test.1",
    longitude: 35.2040591,
  },
  eta: 3600,
  status: "ok",
};

test("extractWazeDriveUrl finds a Waze drive URL inside text", () => {
  const text = "Leaving now: https://waze.com/ul?sd=test-drive-token&utm=share.";

  assert.equal(extractWazeDriveUrl(text), "https://waze.com/ul?sd=test-drive-token&utm=share");
});

test("extractWazeSdToken returns sd only for Waze /ul URLs", () => {
  assert.equal(extractWazeSdToken("https://waze.com/ul?sd=abc-123"), "abc-123");
  assert.equal(extractWazeSdToken("https://www.waze.com/ul?foo=bar&sd=abc-123"), null);
  assert.equal(extractWazeSdToken("https://example.com/ul?sd=abc-123"), null);
  assert.equal(extractWazeSdToken("https://waze.com/live-map?sd=abc-123"), null);
  assert.equal(extractWazeSdToken("not a url"), null);
});

test("WazeService fetches driver info and maps it to drive info", async () => {
  const service = new WazeService({ baseUrl: "https://waze.local/il-rtserver/web" });
  const savedFetch = global.fetch;
  const savedNow = Date.now;
  let requestedUrl = "";

  Date.now = () => 1700000001000;
  global.fetch = (async (input: Parameters<typeof global.fetch>[0]) => {
    requestedUrl = input.toString();
    return {
      ok: true,
      json: async () => wazeResponse,
    } as unknown as Response;
  }) as typeof global.fetch;

  try {
    const result = await service.getDriveInfo("https://waze.com/ul?sd=test-drive-token");

    assert.equal(
      requestedUrl,
      "https://waze.local/il-rtserver/web/PickUpGetDriverInfo?token=test-drive-token&getUserInfo=true&_=1700000001000",
    );
    assert.deepEqual(result, {
      originLat: 32.0140468,
      originLng: 34.7812641,
      originLabel: "Waze location",
      destLat: 31.7718109,
      destLng: 35.2040591,
      destLabel: "Ha-Sifriya Ha-Leumit, Jerusalem",
      etaSeconds: 3600,
    });
  } finally {
    global.fetch = savedFetch;
    Date.now = savedNow;
  }
});

test("WazeService returns null for invalid responses", async () => {
  const service = new WazeService({ baseUrl: "https://waze.local" });
  const savedFetch = global.fetch;

  global.fetch = (async () =>
    ({
      ok: true,
      json: async () => ({ status: "ok", lon: 34.7 }),
    }) as unknown as Response) as typeof global.fetch;

  try {
    assert.equal(await service.getDriveInfo("https://waze.com/ul?sd=bad"), null);
  } finally {
    global.fetch = savedFetch;
  }
});
