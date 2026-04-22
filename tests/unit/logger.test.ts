import assert from "node:assert/strict";
import test from "node:test";
import { createLogger } from "../../src/logger";

test("createLogger writes structured JSON for enabled levels", () => {
  let stdout = "";
  const originalWrite = process.stdout.write;
  (process.stdout.write as any) = (chunk: string) => {
    stdout += chunk;
    return true;
  };

  try {
    const logger = createLogger("info");
    logger.info("test_event", { userId: 123, nested: { ok: true } });
  } finally {
    process.stdout.write = originalWrite;
  }

  const parsed = JSON.parse(stdout.trim());
  assert.equal(parsed.level, "info");
  assert.equal(parsed.message, "test_event");
  assert.equal(parsed.userId, 123);
  assert.deepEqual(parsed.nested, { ok: true });
  assert.match(parsed.timestamp, /^\d{4}-\d{2}-\d{2}T/);
});

test("createLogger suppresses logs below the configured level", () => {
  let stdout = "";
  const originalWrite = process.stdout.write;
  (process.stdout.write as any) = (chunk: string) => {
    stdout += chunk;
    return true;
  };

  try {
    const logger = createLogger("warn");
    logger.info("hidden_event");
  } finally {
    process.stdout.write = originalWrite;
  }

  assert.equal(stdout, "");
});

test("createLogger serializes Error objects to stderr", () => {
  let stderr = "";
  const originalWrite = process.stderr.write;
  (process.stderr.write as any) = (chunk: string) => {
    stderr += chunk;
    return true;
  };

  try {
    const logger = createLogger("debug");
    logger.error("failed_event", { err: new Error("boom") });
  } finally {
    process.stderr.write = originalWrite;
  }

  const parsed = JSON.parse(stderr.trim());
  assert.equal(parsed.level, "error");
  assert.equal(parsed.message, "failed_event");
  assert.equal(parsed.err.name, "Error");
  assert.equal(parsed.err.message, "boom");
  assert.ok(parsed.err.stack.includes("Error: boom"));
});

test("createLogger masks local paths in Error objects", () => {
  let stderr = "";
  const originalWrite = process.stderr.write;
  (process.stderr.write as any) = (chunk: string) => {
    stderr += chunk;
    return true;
  };

  try {
    const logger = createLogger("debug");
    const err = new Error(`failed at ${process.cwd()}/src/index.ts`);
    err.stack = `Error: failed\n    at main (${process.cwd()}/src/index.ts:1:1)`;
    logger.error("failed_event", { err });
  } finally {
    process.stderr.write = originalWrite;
  }

  const parsed = JSON.parse(stderr.trim());
  assert.equal(parsed.err.message, "failed at [APP_ROOT]/src/index.ts");
  assert.equal(parsed.err.stack.includes(process.cwd()), false);
  assert.ok(parsed.err.stack.includes("[APP_ROOT]/src/index.ts"));
});
