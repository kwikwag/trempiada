import assert from "node:assert/strict";
import test from "node:test";
import { DeleteItemCommand, DynamoDBClient, GetItemCommand } from "@aws-sdk/client-dynamodb";

const originalSend = DynamoDBClient.prototype.send;
const { handler } = await import("../src/lambda/bootstrap/index.mjs");

function makeEvent({ method = "POST", body, origin = "https://kwikwag.github.io" } = {}) {
  return {
    headers: {
      origin,
    },
    requestContext: {
      http: {
        method,
      },
    },
    body,
  };
}

function installMockSend(impl) {
  DynamoDBClient.prototype.send = impl;
  return () => {
    DynamoDBClient.prototype.send = originalSend;
  };
}

test(
  "bootstrap returns credentials once and consumes the token",
  { concurrency: false },
  async () => {
    process.env.TOKEN_TABLE_NAME = "bootstrap-table";
    process.env.CORS_ALLOW_ORIGINS = "https://kwikwag.github.io";

    const commands = [];
    const restore = installMockSend(async (command) => {
      commands.push(command);
      if (command instanceof GetItemCommand) {
        return {
          Item: {
            token: { S: "token-123" },
            sessionId: { S: "session-123" },
            region: { S: "eu-west-1" },
            stsAccessKeyId: { S: "AKIA..." },
            stsSecretAccessKey: { S: "secret" },
            stsSessionToken: { S: "session-token" },
            ttl: { N: String(Math.floor(Date.now() / 1000) + 60) },
            returnToTelegramUrl: { S: "https://t.me/trempiadabot" },
          },
        };
      }

      if (command instanceof DeleteItemCommand) {
        return {};
      }

      throw new Error(`Unexpected command: ${command.constructor.name}`);
    });

    try {
      const response = await handler(
        makeEvent({
          body: JSON.stringify({ token: "token-123" }),
        }),
      );

      assert.equal(response.statusCode, 200);
      assert.equal(commands.length, 2);
      assert.ok(commands[0] instanceof GetItemCommand);
      assert.ok(commands[1] instanceof DeleteItemCommand);

      const payload = JSON.parse(response.body);
      assert.equal(payload.sessionId, "session-123");
      assert.equal(payload.region, "eu-west-1");
      assert.equal(payload.credentials.accessKeyId, "AKIA...");
      assert.equal(payload.returnToTelegramUrl, "https://t.me/trempiadabot");
    } finally {
      restore();
    }
  },
);

test("bootstrap deletes expired tokens and rejects them", { concurrency: false }, async () => {
  process.env.TOKEN_TABLE_NAME = "bootstrap-table";
  process.env.CORS_ALLOW_ORIGINS = "https://kwikwag.github.io";

  const commands = [];
  const restore = installMockSend(async (command) => {
    commands.push(command);
    if (command instanceof GetItemCommand) {
      return {
        Item: {
          token: { S: "expired-token" },
          ttl: { N: String(Math.floor(Date.now() / 1000) - 1) },
        },
      };
    }

    if (command instanceof DeleteItemCommand) {
      return {};
    }

    throw new Error(`Unexpected command: ${command.constructor.name}`);
  });

  try {
    const response = await handler(
      makeEvent({
        body: JSON.stringify({ token: "expired-token" }),
      }),
    );

    assert.equal(response.statusCode, 410);
    assert.equal(commands.length, 2);
    assert.ok(commands[0] instanceof GetItemCommand);
    assert.ok(commands[1] instanceof DeleteItemCommand);
    assert.equal(JSON.parse(response.body).error, "token_expired");
  } finally {
    restore();
  }
});

test("bootstrap rejects incomplete records", { concurrency: false }, async () => {
  process.env.TOKEN_TABLE_NAME = "bootstrap-table";
  process.env.CORS_ALLOW_ORIGINS = "https://kwikwag.github.io";

  const commands = [];
  const restore = installMockSend(async (command) => {
    commands.push(command);
    if (command instanceof GetItemCommand) {
      return {
        Item: {
          token: { S: "token-123" },
          sessionId: { S: "session-123" },
          region: { S: "eu-west-1" },
          stsAccessKeyId: { S: "AKIA..." },
          ttl: { N: String(Math.floor(Date.now() / 1000) + 60) },
        },
      };
    }

    throw new Error(`Unexpected command: ${command.constructor.name}`);
  });

  try {
    const response = await handler(
      makeEvent({
        body: JSON.stringify({ token: "token-123" }),
      }),
    );

    assert.equal(response.statusCode, 500);
    assert.equal(commands.length, 1);
    assert.ok(commands[0] instanceof GetItemCommand);
    assert.equal(JSON.parse(response.body).error, "bootstrap_record_incomplete");
  } finally {
    restore();
  }
});

test("bootstrap handles OPTIONS and rejects non-POST methods", { concurrency: false }, async () => {
  process.env.TOKEN_TABLE_NAME = "bootstrap-table";
  process.env.CORS_ALLOW_ORIGINS = "https://kwikwag.github.io";

  const restore = installMockSend(async () => {
    throw new Error("DynamoDB should not be called for these methods");
  });

  try {
    const optionsResponse = await handler(makeEvent({ method: "OPTIONS" }));
    assert.equal(optionsResponse.statusCode, 204);

    const getResponse = await handler(makeEvent({ method: "GET" }));
    assert.equal(getResponse.statusCode, 405);
    assert.equal(JSON.parse(getResponse.body).error, "method_not_allowed");
  } finally {
    restore();
  }
});
