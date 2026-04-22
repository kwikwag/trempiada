import assert from "node:assert/strict";
import test from "node:test";
import { SessionManager } from "../../src/bot/session";
import type { LogContext, Logger } from "../../src/logger";

interface CapturedLog {
  level: "debug" | "info" | "warn" | "error";
  message: string;
  context?: LogContext;
}

function captureLogger(): { logger: Logger; logs: CapturedLog[] } {
  const logs: CapturedLog[] = [];
  const push = ({
    level,
    message,
    context,
  }: {
    level: CapturedLog["level"];
    message: string;
    context?: LogContext;
  }) => {
    logs.push({ level, message, context });
  };
  return {
    logs,
    logger: {
      debug: (message, context) => push({ level: "debug", message, context }),
      info: (message, context) => push({ level: "info", message, context }),
      warn: (message, context) => push({ level: "warn", message, context }),
      error: (message, context) => push({ level: "error", message, context }),
    },
  };
}

test("get creates an idle anonymous session", () => {
  const { logger, logs } = captureLogger();
  const sessions = new SessionManager(logger);

  const session = sessions.get(123);

  assert.equal(session.scene, "idle");
  assert.equal(session.userId, null);
  assert.deepEqual(session.data, {});
  assert.deepEqual(
    logs.map((log) => log.message),
    ["session_created"],
  );
});

test("setScene replaces data only when explicit data is provided", () => {
  const { logger, logs } = captureLogger();
  const sessions = new SessionManager(logger);

  sessions.updateData(123, { originLat: 32.08 });
  sessions.setScene({ telegramId: 123, scene: "ride_destination" });
  assert.deepEqual(sessions.get(123).data, { originLat: 32.08 });

  sessions.setScene({ telegramId: 123, scene: "ride_origin", data: { carId: 9 } });
  assert.deepEqual(sessions.get(123).data, { carId: 9 });

  const sceneLogs = logs.filter((log) => log.message === "session_scene_changed");
  assert.equal(sceneLogs.length, 2);
  assert.equal(sceneLogs[0].context?.previousScene, "idle");
  assert.equal(sceneLogs[0].context?.scene, "ride_destination");
  assert.deepEqual(sceneLogs[1].context?.dataKeys, ["carId"]);
});

test("updateData merges updates and logs only keys", () => {
  const { logger, logs } = captureLogger();
  const sessions = new SessionManager(logger);

  sessions.updateData(123, { firstName: "Sensitive", pickupLabel: "Private address" });
  sessions.updateData(123, { seats: 2 });

  assert.deepEqual(sessions.get(123).data, {
    firstName: "Sensitive",
    pickupLabel: "Private address",
    seats: 2,
  });

  const dataLogs = logs.filter((log) => log.message === "session_data_updated");
  assert.deepEqual(dataLogs[0].context?.updateKeys, ["firstName", "pickupLabel"]);
  assert.deepEqual(dataLogs[0].context?.dataKeys, ["firstName", "pickupLabel"]);
  assert.deepEqual(dataLogs[1].context?.updateKeys, ["seats"]);
  assert.equal(JSON.stringify(dataLogs).includes("Private address"), false);
});

test("setUserId binds the DB user ID", () => {
  const { logger, logs } = captureLogger();
  const sessions = new SessionManager(logger);

  sessions.setUserId(123, 77);

  assert.equal(sessions.get(123).userId, 77);
  const bindLog = logs.find((log) => log.message === "session_user_bound");
  assert.equal(bindLog?.context?.telegramId, 123);
  assert.equal(bindLog?.context?.userId, 77);
});

test("reset returns to idle and preserves user binding", () => {
  const { logger, logs } = captureLogger();
  const sessions = new SessionManager(logger);

  sessions.setUserId(123, 77);
  sessions.setScene({ telegramId: 123, scene: "in_ride_relay", data: { matchId: 5 } });
  sessions.reset(123);

  const session = sessions.get(123);
  assert.equal(session.scene, "idle");
  assert.equal(session.userId, 77);
  assert.deepEqual(session.data, {});

  const resetLog = logs.find((log) => log.message === "session_reset");
  assert.equal(resetLog?.context?.previousScene, "in_ride_relay");
  assert.equal(resetLog?.context?.userId, 77);
});

test("isInRelay reflects the current scene", () => {
  const sessions = new SessionManager();

  assert.equal(sessions.isInRelay(123), false);
  sessions.setScene({ telegramId: 123, scene: "in_ride_relay" });
  assert.equal(sessions.isInRelay(123), true);
});
