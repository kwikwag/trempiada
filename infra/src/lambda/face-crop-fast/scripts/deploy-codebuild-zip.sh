#!/usr/bin/env bash
set -euo pipefail

arch="${1:-x86_64}"
case "$arch" in
  x86_64|arm64) ;;
  *)
    echo "usage: $0 [x86_64|arm64]" >&2
    exit 2
    ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate_dir="$(cd "$script_dir/.." && pwd)"
infra_dir="$(cd "$crate_dir/../../.." && pwd)"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
source_key="sources/face-crop-fast-$arch-$stamp.tgz"
output_key="artifacts/face-crop-fast-$arch-$stamp.zip"
source_archive="/tmp/face-crop-fast-$arch-$stamp.tgz"

export PATH="$HOME/.pulumi/bin:$PATH"

cd "$infra_dir"

pulumi config set faceCropArchitecture "$arch"
pulumi up --yes --non-interactive

bucket="$(pulumi stack output faceCropBuildBucket)"
project="$(pulumi stack output faceCropBuildProjectName)"
region="$(pulumi stack output awsRegion)"

export AWS_REGION="${AWS_REGION:-$region}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$region}"

tar \
  --exclude='./target' \
  --exclude='./dist' \
  --exclude='./build*.log' \
  -czf "$source_archive" \
  -C "$crate_dir" \
  .

aws s3 cp "$source_archive" "s3://$bucket/$source_key"

build_id="$(
  aws codebuild start-build \
    --project-name "$project" \
    --environment-variables-override \
      name=SOURCE_BUCKET,value="$bucket",type=PLAINTEXT \
      name=SOURCE_KEY,value="$source_key",type=PLAINTEXT \
      name=OUTPUT_BUCKET,value="$bucket",type=PLAINTEXT \
      name=OUTPUT_KEY,value="$output_key",type=PLAINTEXT \
      name=FACE_CROP_ARCH,value="$arch",type=PLAINTEXT \
    --query 'build.id' \
    --output text
)"

echo "Started CodeBuild build: $build_id"
logs_url="$(aws codebuild batch-get-builds --ids "$build_id" --query 'builds[0].logs.deepLink' --output text)"
echo "Logs: $logs_url" >&2

while true; do
  status="$(aws codebuild batch-get-builds --ids "$build_id" --query 'builds[0].buildStatus' --output text)"
  case "$status" in
    SUCCEEDED)
      break
      ;;
    FAILED|FAULT|STOPPED|TIMED_OUT)
      echo "CodeBuild failed with status $status" >&2
      exit 1
      ;;
    IN_PROGRESS)
      echo "CodeBuild status: $status"
      sleep 20
      ;;
  esac
done

pulumi config set faceCropCodeS3Bucket "$bucket"
pulumi config set faceCropCodeS3Key "$output_key"
pulumi up --yes --non-interactive

echo "Deployed face-crop Lambda artifact: s3://$bucket/$output_key"
