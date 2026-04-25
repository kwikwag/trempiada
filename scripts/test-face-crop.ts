#!/usr/bin/env ts-node
/**
 * Submit a local image through the profile face crop pipeline and save the output.
 *
 * Usage:
 *   npx ts-node scripts/test-face-crop.ts <input-image> [output-image]
 *
 * If <input-image>.json exists, it is used as cached Rekognition output (skips AWS call).
 * Otherwise, the Rekognition response is saved to <input-image>.json for reuse.
 *
 * Requires AWS credentials and AWS_REGION (default: eu-west-1).
 */
import "dotenv/config";
import * as fs from "fs";
import * as path from "path";
import type { FaceDetail } from "@aws-sdk/client-rekognition";
import { RekognitionClient } from "@aws-sdk/client-rekognition";
import sharp from "sharp";
import { loadConfig } from "../src/config";
import { createLogger } from "../src/logger";
import { ProfileFaceService } from "../src/services/identity/profile-face";

async function main() {
  const [, , inputArg, outputArg] = process.argv;
  if (!inputArg) {
    console.error("Usage: npx ts-node scripts/test-face-crop.ts <input-image> [output-image]");
    process.exit(1);
  }

  const inputPath = path.resolve(inputArg);
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  const config = loadConfig();
  const logger = createLogger(config.logLevel ?? "info");
  const rekognition = new RekognitionClient({ region: config.aws.region });
  const service = new ProfileFaceService({ rekognition, logger, thresholds: config.aws.face });

  const imageBuffer = fs.readFileSync(inputPath);
  const ext = path.extname(inputPath).toLowerCase();
  const mimeType = ext === ".png" ? "image/png" : "image/jpeg";

  const { width, height } = await sharp(imageBuffer, { failOn: "none" }).metadata();
  console.log(`Processing: ${inputPath} (${width}x${height})`);

  const jsonPath = inputPath.replace(/(\.[^.]+)$/, ".json");
  let cachedFaces: FaceDetail[] | undefined;
  if (fs.existsSync(jsonPath)) {
    console.log(`Loading cached Rekognition output from: ${jsonPath}`);
    cachedFaces = JSON.parse(fs.readFileSync(jsonPath, "utf8")) as FaceDetail[];
  }

  const result = await service.validateAndCropPhoto(imageBuffer, mimeType, cachedFaces);

  if (!cachedFaces && result.ok) {
    fs.writeFileSync(jsonPath, JSON.stringify([result.face], null, 2));
    console.log(`Rekognition output saved to: ${jsonPath}`);
  }

  if (!result.ok) {
    console.error(`Rejected [${result.rejectionCode}]: ${result.userMessage}`);
    process.exit(2);
  }

  const { cropRegion } = result;
  console.log("cropRegion:", cropRegion);

  const outputPath = outputArg
    ? path.resolve(outputArg)
    : inputPath.replace(/(\.[^.]+)$/, "-cropped.jpg");
  fs.writeFileSync(outputPath, result.croppedBuffer);
  console.log("saved:", outputPath);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
