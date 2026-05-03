#!/usr/bin/env bash
set -euo pipefail

arch="${1:-x86_64}"
backend="${FACE_CROP_BACKEND:-${2:-}}"
case "$arch" in
  x86_64)
    binary_path="target/release/lambda"
    zip_name="face-crop-fast-x86_64.zip"
    backend="${backend:-ort}"
    ;;
  arm64)
    binary_path="target/release/lambda"
    zip_name="face-crop-fast-arm64.zip"
    backend="${backend:-tract}"
    machine="$(uname -m)"
    if [[ "$machine" != "aarch64" && "$machine" != "arm64" ]]; then
      echo "arm64 ZIP builds should run on an ARM64 host, such as AWS CodeBuild ARM/Graviton." >&2
      echo "Refusing to cross-compile from $machine." >&2
      exit 1
    fi
    ;;
  *)
    echo "usage: $0 [x86_64|arm64] [ort|tract]" >&2
    exit 2
    ;;
esac

case "$backend" in
  ort)
    echo "Using ORT backend."
    cargo_args=(--release --bin lambda --no-default-features --features backend-ort)
    ;;
  tract)
    echo "Using Tract backend."
    cargo_args=(--release --bin lambda --no-default-features --features backend-tract)
    ;;
  *)
    echo "usage: $0 [x86_64|arm64] [ort|tract]" >&2
    exit 2
    ;;
esac

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
crate_dir="$(cd "$script_dir/.." && pwd)"
dist_dir="$crate_dir/dist"
staging_dir="$crate_dir/target/lambda-zip-$arch"

cd "$crate_dir"

for model in models/ultraface-rfb-320.onnx models/u2netp.onnx; do
  if [[ ! -s "$model" ]]; then
    echo "Required model $model is missing. Run scripts/download-models.sh before building." >&2
    exit 1
  fi
done

echo "Building."
cargo build "${cargo_args[@]}"

echo "Done building. Packaging."
rm -rf "$staging_dir"
mkdir -p "$staging_dir/models" "$dist_dir"

cp "$binary_path" "$staging_dir/bootstrap"
chmod +x "$staging_dir/bootstrap"
cp models/ultraface-rfb-320.onnx "$staging_dir/models/ultraface-rfb-320.onnx"
cp models/u2netp.onnx "$staging_dir/models/u2netp.onnx"

if [[ "$backend" == "ort" ]]; then
  mapfile -t ort_libs < <(find -L target/release target/release/deps -maxdepth 1 -type f -name 'libonnxruntime.so*' 2>/dev/null | sort -u)
  for lib in "${ort_libs[@]}"; do
    cp -L "$lib" "$staging_dir/$(basename "$lib")"
  done

  if ldd "$binary_path" | grep -q 'libonnxruntime'; then
    if [[ "${#ort_libs[@]}" -eq 0 ]]; then
      echo "lambda depends on libonnxruntime, but no libonnxruntime.so* was found under target/release" >&2
      exit 1
    fi
  fi
fi

(
  cd "$staging_dir"
  zip -qr "$dist_dir/$zip_name" .
)

echo "$dist_dir/$zip_name"
