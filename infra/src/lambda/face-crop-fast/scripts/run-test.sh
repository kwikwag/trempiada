#!/bin/bash
INFRA_DIR=$(readlink -f $(dirname "$0")/../../../..)

pushd "${INFRA_DIR}"

echo -n "Loading Pulumi vars.."
LAMBDA="$(pulumi stack output faceCropLambdaName)"
echo -n "."
BUCKET="$(pulumi stack output faceCropWatermarkBucket)"
echo -n "."
KEY="$(pulumi stack output faceCropWatermarkKey)"
echo -n "."
REGION="$(pulumi stack output awsRegion)"
echo "done."

# Build the test payload (note: env vars must come BEFORE node, not after)
BUCKET="$BUCKET" KEY="$KEY" node -e '
  const fs = require("fs");
  const image = fs.readFileSync("../tests/assets/ok-face.jpg").toString("base64");
  fs.writeFileSync("/tmp/face-crop-event.json", JSON.stringify({
    image_base64: image,
    watermark_s3: { bucket: process.env.BUCKET, key: process.env.KEY }
  }));
'

# Invoke
time aws --region "$REGION" lambda invoke \
  --function-name "$LAMBDA" \
  --cli-binary-format raw-in-base64-out \
  --payload file:///tmp/face-crop-event.json \
  /tmp/face-crop-response.json

node -e '
  const fs = require("fs");
  const r = JSON.parse(fs.readFileSync("/tmp/face-crop-response.json"));
  for (const [key, value] of Object.entries(r)) {
    if (!(key.includes("base64") || key.includes("image"))) {
      console.log({key, value});
      continue;
    }
    console.log("Decoding " + key);
    fs.writeFileSync("/tmp/face-crop-result.jpg", Buffer.from(r[key], "base64"));
  }
'
rm -f /tmp/face-crop-event.json /tmp/face-crop-response.json

popd

mv /tmp/face-crop-result.jpg ./face-crop-result.jpg
