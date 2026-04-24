import { DynamoDBClient, DeleteItemCommand, GetItemCommand } from "@aws-sdk/client-dynamodb";

const dynamodb = new DynamoDBClient({});

function resolveOrigin(event) {
  const configuredOrigins = (process.env.CORS_ALLOW_ORIGINS ?? "*")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const requestOrigin = event.headers?.origin ?? event.headers?.Origin;

  if (configuredOrigins.includes("*")) {
    return "*";
  }

  if (requestOrigin && configuredOrigins.includes(requestOrigin)) {
    return requestOrigin;
  }

  return configuredOrigins[0] ?? "*";
}

function json(statusCode, body, origin) {
  return {
    statusCode,
    headers: {
      "access-control-allow-origin": origin,
      "access-control-allow-methods": "OPTIONS,POST",
      "access-control-allow-headers": "content-type",
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

export const handler = async (event) => {
  const origin = resolveOrigin(event);

  if (event.requestContext?.http?.method === "OPTIONS") {
    return {
      statusCode: 204,
      headers: {
        "access-control-allow-origin": origin,
        "access-control-allow-methods": "OPTIONS,POST",
        "access-control-allow-headers": "content-type",
      },
    };
  }

  if (event.requestContext?.http?.method !== "POST") {
    return json(405, { error: "method_not_allowed" }, origin);
  }

  const tokenTableName = process.env.TOKEN_TABLE_NAME;

  if (!tokenTableName) {
    return json(500, { error: "bootstrap_not_configured" }, origin);
  }

  let payload;

  try {
    payload = event.body ? JSON.parse(event.body) : {};
  } catch {
    return json(400, { error: "invalid_json_body" }, origin);
  }

  const token = typeof payload.token === "string" ? payload.token.trim() : "";

  if (!token) {
    return json(400, { error: "token_required" }, origin);
  }

  const result = await dynamodb.send(
    new GetItemCommand({
      TableName: tokenTableName,
      Key: {
        token: { S: token },
      },
    }),
  );

  if (!result.Item) {
    return json(404, { error: "token_not_found" }, origin);
  }

  const ttl = Number.parseInt(result.Item.ttl?.N ?? result.Item.expiresAt?.N ?? "0", 10);
  if (ttl > 0 && ttl <= Math.floor(Date.now() / 1000)) {
    await dynamodb.send(
      new DeleteItemCommand({
        TableName: tokenTableName,
        Key: {
          token: { S: token },
        },
      }),
    );
    return json(410, { error: "token_expired" }, origin);
  }

  const sessionId = result.Item.sessionId?.S;
  const region = result.Item.region?.S;
  const accessKeyId = result.Item.stsAccessKeyId?.S;
  const secretAccessKey = result.Item.stsSecretAccessKey?.S;
  const sessionToken = result.Item.stsSessionToken?.S;

  if (!sessionId || !region || !accessKeyId || !secretAccessKey || !sessionToken) {
    return json(500, { error: "bootstrap_record_incomplete" }, origin);
  }

  await dynamodb.send(
    new DeleteItemCommand({
      TableName: tokenTableName,
      Key: {
        token: { S: token },
      },
    }),
  );

  return json(
    200,
    {
      sessionId,
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
        sessionToken,
      },
      returnToTelegramUrl: result.Item.returnToTelegramUrl?.S,
    },
    origin,
  );
};
