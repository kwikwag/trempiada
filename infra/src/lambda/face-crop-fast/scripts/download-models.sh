#!/usr/bin/env bash
# Downloads the ONNX models required by face-crop-fast.
#
# Usage:
#   download-models.sh [--non-interactive] [--human-seg]
#                      [--cache-bucket BUCKET] [--cache-prefix PREFIX]
#
# Options:
#   --non-interactive   Skip the interactive u2net_human_seg prompt (do not download it).
#   --human-seg         Download u2net_human_seg.onnx (implies non-interactive).
#   --cache-bucket      S3 bucket for caching downloaded models.
#                       Models are fetched from S3 first; on a cache miss they are
#                       downloaded from the upstream URL and then uploaded to S3.
#   --cache-prefix      S3 key prefix for the model cache (default: model-cache).
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="${ROOT_DIR}/models"

ULTRAFACE_URL="https://raw.githubusercontent.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/master/models/onnx/version-RFB-320_simplified.onnx"
U2NETP_URL="https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx"
U2NET_HUMAN_SEG_URL="https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx"

CACHE_BUCKET=""
CACHE_PREFIX="model-cache"
NON_INTERACTIVE=false
INCLUDE_HUMAN_SEG=false

usage() {
  echo "usage: $0 [--non-interactive] [--human-seg] [--cache-bucket BUCKET] [--cache-prefix PREFIX]" >&2
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --cache-bucket)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      CACHE_BUCKET="$2"
      shift 2
      ;;
    --cache-prefix)
      [[ $# -ge 2 ]] || { usage; exit 2; }
      CACHE_PREFIX="${2%/}"
      shift 2
      ;;
    --non-interactive)  NON_INTERACTIVE=true; shift ;;
    --human-seg)        INCLUDE_HUMAN_SEG=true; NON_INTERACTIVE=true; shift ;;
    *) usage; exit 2 ;;
  esac
done

mkdir -p "${MODELS_DIR}"

validate_model() {
  local filename="$1"
  local path="$2"
  local min_bytes="$3"
  local size

  if [[ ! -f "${path}" ]]; then
    echo "Model ${filename} is missing at ${path}" >&2
    return 1
  fi

  size="$(wc -c <"${path}")"
  if [[ "${size}" -lt "${min_bytes}" ]]; then
    echo "Model ${filename} is too small (${size} bytes, expected at least ${min_bytes})" >&2
    return 1
  fi
}

# Download a model, using S3 as a look-aside cache when --cache-bucket is set.
download_model() {
  local filename="$1"
  local url="$2"
  local min_bytes="$3"
  local dest="${MODELS_DIR}/${filename}"
  local tmp="${dest}.tmp"

  if [[ -f "${dest}" ]]; then
    validate_model "${filename}" "${dest}" "${min_bytes}"
    echo "Skipping ${filename} (already present)"
    return
  fi

  if [[ -n "${CACHE_BUCKET}" ]]; then
    local s3_key="${CACHE_PREFIX}/${filename}"
    rm -f "${tmp}"
    if aws s3 cp "s3://${CACHE_BUCKET}/${s3_key}" "${tmp}" 2>/dev/null; then
      validate_model "${filename}" "${tmp}" "${min_bytes}"
      mv "${tmp}" "${dest}"
      echo "Fetched ${filename} from S3 cache"
      return
    fi
    rm -f "${tmp}"
    echo "${filename} not in S3 cache — downloading from upstream..."
  else
    echo "Downloading ${filename}..."
  fi

  rm -f "${tmp}"
  curl --location --fail --retry 5 --retry-all-errors --connect-timeout 15 --max-time 600 \
    --progress-bar "${url}" -o "${tmp}"
  validate_model "${filename}" "${tmp}" "${min_bytes}"
  mv "${tmp}" "${dest}"

  if [[ -n "${CACHE_BUCKET}" ]]; then
    echo "Storing ${filename} in S3 cache..."
    aws s3 cp "${dest}" "s3://${CACHE_BUCKET}/${CACHE_PREFIX}/${filename}"
  fi
}

download_model "ultraface-rfb-320.onnx" "${ULTRAFACE_URL}" 1000000
download_model "u2netp.onnx" "${U2NETP_URL}" 4000000

if [[ "${NON_INTERACTIVE}" == false ]]; then
  read -r -p "Download u2net_human_seg.onnx too? [y/N] " reply || reply=""
  reply="$(printf '%s' "${reply}" | tr '[:upper:]' '[:lower:]')"
  if [[ "${reply}" == "y" || "${reply}" == "yes" ]]; then
    INCLUDE_HUMAN_SEG=true
  fi
fi

if [[ "${INCLUDE_HUMAN_SEG}" == true ]]; then
  download_model "u2net_human_seg.onnx" "${U2NET_HUMAN_SEG_URL}" 150000000
fi
