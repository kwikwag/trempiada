#!/usr/bin/env bash
# Deploy the face-crop-fast Lambda via CodeBuild (default) or a local Docker build.
#
# Usage:
#   deploy-codebuild-zip.sh [--arch x86_64|arm64] [--backend ort|tract] [--local-docker] [--local-static]
#
# Options:
#   --arch          Target architecture. Defaults to the value stored in Pulumi config
#                   (faceCropArchitecture). Does NOT write the value back to Pulumi config;
#                   set it once with `pulumi config set faceCropArchitecture <arch>`.
#   --backend       Inference backend. Defaults to ort for x86_64 and tract for arm64.
#   --local-docker  Build inside a local Docker container (Amazon Linux 2023 image) instead
#                   of CodeBuild. The host architecture must match the target; cross-
#                   compilation is not supported for local builds — use CodeBuild instead.
#   --local-static  Build a fully static (musl) binary directly on the host (no Docker, no
#                   CodeBuild). Only works for tract-only (arm64) builds; not compatible with
#                   the ORT backend. Same arch restriction as --local-docker.
set -euo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate_dir="$(cd "$script_dir/.." && pwd)"
infra_dir="$(cd "$crate_dir/../../.." && pwd)"

ARCH=""
BACKEND=""
LOCAL_DOCKER=false
LOCAL_STATIC=false

while [[ $# -gt 0 ]]; do
  case "$1" in
    --arch)       ARCH="$2"; shift 2 ;;
    --backend)    BACKEND="$2"; shift 2 ;;
    --local-docker) LOCAL_DOCKER=true; shift ;;
    --local-static) LOCAL_STATIC=true; shift ;;
    x86_64|arm64) ARCH="$1"; shift ;;   # back-compat positional arg
    *) echo "usage: $0 [--arch x86_64|arm64] [--backend ort|tract] [--local-docker] [--local-static]" >&2; exit 2 ;;
  esac
done

cd "$infra_dir"

echo -n "Determining architecture: "

# Read arch from Pulumi config if not supplied on the CLI.
if [[ -z "$ARCH" ]]; then
  ARCH="$(pulumi config get faceCropArchitecture 2>/dev/null || echo "x86_64")"
fi
echo "$ARCH"

# Validate arch
case "$ARCH" in
  x86_64|arm64) ;;
  *) echo "error: --arch must be x86_64 or arm64" >&2; exit 1 ;;
esac
if [[ -z "$BACKEND" ]]; then
  case "$ARCH" in
    x86_64) BACKEND="ort" ;;
    arm64) BACKEND="tract" ;;
  esac
fi
case "$BACKEND" in
  ort|tract) ;;
  *) echo "error: --backend must be ort or tract" >&2; exit 1 ;;
esac

# Check that the required infrastructure stack outputs exist (infra must be deployed first).
check_infra() {
  local missing=false
  for key in faceCropBuildBucket awsRegion; do
    if ! pulumi stack output "$key" >/dev/null 2>&1; then
      echo "error: stack output '$key' not found." >&2
      missing=true
    fi
  done
  if [[ "$missing" == true ]]; then
    echo "" >&2
    echo "Infrastructure is not deployed. Run the following first:" >&2
    echo "  cd $infra_dir && pulumi up" >&2
    exit 1
  fi
}

echo -n "Determining AWS target region and bucket: "
bucket="$(pulumi stack output faceCropBuildBucket 2>/dev/null || true)"
echo -n "$bucket"
region="$(pulumi stack output awsRegion 2>/dev/null || true)"
echo "@$region"

if [[ -z "$bucket" || -z "$region" ]]; then
  check_infra
fi

export AWS_REGION="${AWS_REGION:-$region}"
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-$region}"

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
output_key="artifacts/face-crop-fast-$ARCH-$stamp.zip"

# ── Local arch guard ─────────────────────────────────────────────────────────
check_local_arch() {
  local host_arch; host_arch="$(uname -m)"
  local expected
  case "$ARCH" in
    x86_64) expected="x86_64" ;;
    arm64)  expected="aarch64" ;;
  esac
  if [[ "$host_arch" != "$expected" ]]; then
    echo "error: local builds require the host architecture to match the target." >&2
    echo "       Host is $host_arch but target is $ARCH." >&2
    echo "       Cross-compilation is not supported for local builds — use CodeBuild instead." >&2
    exit 1
  fi
}

# ── Local Docker build ───────────────────────────────────────────────────────
if [[ "$LOCAL_DOCKER" == true ]]; then
  echo "Mode: Local Docker build."
  check_local_arch
  echo "Building Lambda ZIP with Docker (Amazon Linux 2023)..."
  DOCKER_BUILDKIT=1 docker build \
    -f "$crate_dir/Dockerfile.lambda" \
    --target dist \
    --build-arg ARCH="$ARCH" \
    --build-arg BACKEND="$BACKEND" \
    --output "type=local,dest=$crate_dir/dist" \
    "$crate_dir"
  output_zip="$crate_dir/dist/face-crop-fast-$ARCH.zip"
  aws s3 cp "$output_zip" "s3://$bucket/$output_key"

# ── Local static build (musl, tract-only) ───────────────────────────────────
elif [[ "$LOCAL_STATIC" == true ]]; then
  echo "Mode: Local static build."
  check_local_arch
  case "$ARCH" in
    x86_64) musl_target="x86_64-unknown-linux-musl" ;;
    arm64)  musl_target="aarch64-unknown-linux-musl" ;;
  esac
  if ! rustup target list --installed | grep -q "$musl_target"; then
    echo "Installing musl target $musl_target..."
    rustup target add "$musl_target"
  fi
  echo "Building static Lambda ZIP (musl, tract-only)..."
  if [[ "$BACKEND" != "tract" ]]; then
    echo "error: --local-static only supports --backend tract" >&2
    exit 1
  fi
  pushd "$crate_dir" >/dev/null
  CARGO_TARGET_DIR="target" \
    cargo build --release --bin lambda --target "$musl_target" --no-default-features --features backend-tract
  dist_dir="$crate_dir/dist"
  staging_dir="$crate_dir/target/lambda-zip-$ARCH-static"
  rm -rf "$staging_dir"
  mkdir -p "$staging_dir/models" "$dist_dir"
  cp "target/$musl_target/release/lambda" "$staging_dir/bootstrap"
  chmod +x "$staging_dir/bootstrap"
  cp models/ultraface-rfb-320.onnx "$staging_dir/models/"
  cp models/u2netp.onnx "$staging_dir/models/"
  (cd "$staging_dir" && zip -qr "$dist_dir/face-crop-fast-$ARCH.zip" .)
  popd >/dev/null
  aws s3 cp "$crate_dir/dist/face-crop-fast-$ARCH.zip" "s3://$bucket/$output_key"

# ── CodeBuild ────────────────────────────────────────────────────────────────
else
  echo "Mode: CodeBuild build."
  echo -n "Reading Pulumi stack.."
  project="$(pulumi stack output faceCropBuildProjectName 2>/dev/null || true)"
  if [[ -z "$project" ]]; then
    echo "error: stack output 'faceCropBuildProjectName' not found." >&2
    echo "  cd $infra_dir && pulumi up" >&2
    exit 1
  fi
  echo ". Done."

  local_buildspec="$crate_dir/buildspec.yml"
  if [[ ! -f "$local_buildspec" ]]; then
    echo "error: local buildspec not found at $local_buildspec" >&2
    exit 1
  fi

  echo "Validating buildspec.yml has not changed against target."
  remote_buildspec="$(
    aws codebuild batch-get-projects \
      --names "$project" \
      --output json \
      | python3 -c 'import json, sys; data = json.load(sys.stdin); projects = data.get("projects", []); print(projects[0].get("source", {}).get("buildspec", "") if projects else "", end="")'
  )"

  normalize_buildspec() {
    python3 -c 'import sys; sys.stdout.write(sys.stdin.read().rstrip("\n"))'
  }

  if ! cmp -s <(printf '%s' "$remote_buildspec" | normalize_buildspec) <(normalize_buildspec <"$local_buildspec"); then
    echo "error: CodeBuild project '$project' is not using the local buildspec.yml." >&2
    echo "       Run this first so Pulumi updates the inline CodeBuild buildspec:" >&2
    echo "         cd $infra_dir && pulumi up" >&2
    echo "" >&2
    echo "Diff between deployed CodeBuild buildspec and local buildspec:" >&2
    diff -u \
      --label "deployed:$project" <(printf '%s' "$remote_buildspec" | normalize_buildspec) \
      --label "$local_buildspec" <(normalize_buildspec <"$local_buildspec") >&2 || true
    exit 1
  fi

  source_key="sources/face-crop-fast-$ARCH-$stamp.tgz"
  source_archive="/tmp/face-crop-fast-$ARCH-$stamp.tgz"

  echo "Delivering source code to CodeBuild."
  tar \
    --exclude-vcs-ignores \
    --exclude='./target' \
    --exclude='./dist' \
    --exclude='./tmp' \
    --exclude='./out' \
    --exclude='./samples' \
    --exclude='./.codex' \
    --exclude='*.log' \
    -czf "$source_archive" \
    -C "$crate_dir" .

  aws s3 cp "$source_archive" "s3://$bucket/$source_key"

  echo "Starting CodeBuild build."
  build_id="$(aws codebuild start-build \
    --project-name "$project" \
    --environment-variables-override \
      name=SOURCE_BUCKET,value="$bucket",type=PLAINTEXT \
      name=SOURCE_KEY,value="$source_key",type=PLAINTEXT \
      name=OUTPUT_BUCKET,value="$bucket",type=PLAINTEXT \
      name=OUTPUT_KEY,value="$output_key",type=PLAINTEXT \
      name=FACE_CROP_ARCH,value="$ARCH",type=PLAINTEXT \
      name=FACE_CROP_BACKEND,value="$BACKEND",type=PLAINTEXT \
    --query 'build.id' --output text)"

  log_stream="${build_id#*:}"
  log_group="/aws/codebuild/$project"
  echo "Started CodeBuild build: $build_id"
  echo "Logs: https://console.aws.amazon.com/cloudwatch/home?region=$region#logsV2:log-groups/log-group/$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1],safe='')); " "$log_group")/log-events/$(python3 -c "import urllib.parse,sys; print(urllib.parse.quote(sys.argv[1],safe='')); " "$log_stream")"

  # Stream CloudWatch logs while waiting.
  aws --region "$region" logs tail "$log_group" \
    --log-stream-names "$log_stream" \
    --follow --format short 2>/dev/null &
  LOG_TAIL_PID=$!
  cleanup_tail() { kill "$LOG_TAIL_PID" 2>/dev/null || true; }
  trap cleanup_tail EXIT INT TERM

  while true; do
    status="$(aws codebuild batch-get-builds --ids "$build_id" \
      --query 'builds[0].buildStatus' --output text)"
    case "$status" in
      SUCCEEDED)
        cleanup_tail; trap - EXIT INT TERM
        break ;;
      FAILED|FAULT|STOPPED|TIMED_OUT)
        cleanup_tail; trap - EXIT INT TERM
        echo "CodeBuild failed with status $status" >&2
        exit 1 ;;
      *) sleep 20 ;;
    esac
  done

  # Clean up: keep only the most recent source tarball (for build provenance).
  echo "Pruning old source tarballs (keeping last 1)..."
  old_sources="$(aws s3api list-objects-v2 --bucket "$bucket" --prefix "sources/face-crop-fast-$ARCH-" \
    --query 'sort_by(Contents, &LastModified)[*].Key' --output text 2>/dev/null \
    | tr '\t' '\n' | grep -v '^$' || true)"
  source_count="$(echo "$old_sources" | grep -c . || true)"
  if [[ "$source_count" -gt 1 ]]; then
    echo "$old_sources" | head -n "$((source_count - 1))" | while read -r key; do
      aws s3 rm "s3://$bucket/$key"
    done
  fi

  # Clean up: keep only the two most recent artifact ZIPs per arch.
  echo "Pruning old artifacts (keeping last 2)..."
  old_artifacts="$(aws s3api list-objects-v2 \
    --bucket "$bucket" \
    --prefix "artifacts/face-crop-fast-$ARCH-" \
    --query 'sort_by(Contents, &LastModified)[*].Key' \
    --output text 2>/dev/null \
    | tr '\t' '\n' | grep -v '^$' || true)"
  artifact_count="$(echo "$old_artifacts" | grep -c . || true)"
  if [[ "$artifact_count" -gt 2 ]]; then
    echo "$old_artifacts" | head -n "$((artifact_count - 2))" | while read -r key; do
      aws s3 rm "s3://$bucket/$key"
    done
  fi
fi

# ── Record the new artifact in Pulumi config ─────────────────────────────────
pulumi config set faceCropCodeS3Bucket "$bucket"
pulumi config set faceCropCodeS3Key "$output_key"

echo ""
echo "Artifact ready: s3://$bucket/$output_key"
echo ""
echo "Lambda code config updated. To deploy, run:"
echo "  cd $infra_dir && pulumi up"
