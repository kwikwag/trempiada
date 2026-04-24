import "dotenv/config";
import { RekognitionClient } from "@aws-sdk/client-rekognition";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";
import { FaceLivenessService, createAwsClients } from "../src/services/identity/liveness";

type CliOptions = {
  origin: string;
  userId: number;
  profilePhotoFileId: string;
};

function parseArgs(argv: string[]): CliOptions {
  let origin = "http://localhost:5173/";
  let userId = 0;
  let profilePhotoFileId = "local-dev-photo";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];

    if ((arg === "--origin" || arg === "-o") && next) {
      origin = next;
      index += 1;
      continue;
    }

    if ((arg === "--user-id" || arg === "-u") && next) {
      userId = Number.parseInt(next, 10);
      index += 1;
      continue;
    }

    if ((arg === "--photo-file-id" || arg === "-p") && next) {
      profilePhotoFileId = next;
      index += 1;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      printHelpAndExit(0);
    }
  }

  return {
    origin,
    userId,
    profilePhotoFileId,
  };
}

function printHelpAndExit(code: number): never {
  console.log(`Create a real liveness token for local Vite development.

Usage:
  npm run liveness:local-link -- [--origin http://localhost:5173/] [--user-id 123] [--photo-file-id photo-file-id]

Defaults:
  --origin         http://localhost:5173/
  --user-id        0
  --photo-file-id  local-dev-photo
`);
  process.exit(code);
}

function buildLocalUrl(origin: string, token: string): string {
  const base = new URL(origin);
  base.searchParams.set("token", token);
  return base.toString();
}

async function main() {
  const { origin, userId, profilePhotoFileId } = parseArgs(process.argv.slice(2));
  const config = loadConfig();
  const logger = createLogger(config.logLevel);
  const rekognition = new RekognitionClient({ region: config.aws.region });
  const { dynamo, sts } = createAwsClients(config.aws.region);
  const faceLiveness = new FaceLivenessService({
    rekognition,
    sts,
    dynamo,
    logger,
    config: config.aws,
  });

  const attempt = await faceLiveness.createAttempt({
    userId,
    profilePhotoFileId,
  });

  const localUrl = buildLocalUrl(origin, attempt.token);
  const expiresAtIso = new Date(attempt.expiresAt * 1000).toISOString();

  console.log(
    JSON.stringify(
      {
        sessionId: attempt.sessionId,
        token: attempt.token,
        expiresAt: attempt.expiresAt,
        expiresAtIso,
        localUrl,
        pagesUrl: attempt.url,
      },
      null,
      2,
    ),
  );
}

void main().catch((error) => {
  console.error(error);
  process.exit(1);
});
