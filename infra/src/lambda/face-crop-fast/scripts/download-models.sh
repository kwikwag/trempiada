#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MODELS_DIR="${ROOT_DIR}/models"

ULTRAFACE_URL="https://raw.githubusercontent.com/Linzaer/Ultra-Light-Fast-Generic-Face-Detector-1MB/master/models/onnx/version-RFB-320_simplified.onnx"
U2NETP_URL="https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx"
U2NET_HUMAN_SEG_URL="https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2net_human_seg.onnx"

mkdir -p "${MODELS_DIR}"

download_if_missing() {
  local url="$1"
  local output_path="$2"

  if [[ -f "${output_path}" ]]; then
    echo "Skipping $(basename "${output_path}") because it already exists"
    return
  fi

  echo "Downloading $(basename "${output_path}")"
  curl -L --fail --progress-bar "${url}" -o "${output_path}"
}

download_if_missing "${ULTRAFACE_URL}" "${MODELS_DIR}/ultraface-rfb-320.onnx"
download_if_missing "${U2NETP_URL}" "${MODELS_DIR}/u2netp.onnx"

read -r -p "Download u2net_human_seg.onnx too? [y/N] " reply || reply=""
reply="$(printf '%s' "${reply}" | tr '[:upper:]' '[:lower:]')"

if [[ "${reply}" == "y" || "${reply}" == "yes" ]]; then
  download_if_missing "${U2NET_HUMAN_SEG_URL}" "${MODELS_DIR}/u2net_human_seg.onnx"
else
  echo "Skipping u2net_human_seg.onnx"
fi
