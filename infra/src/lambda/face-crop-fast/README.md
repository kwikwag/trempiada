# face-crop-fast

Small Rust library for fast portrait extraction from a mobile photo.

Runtime target: CPU only. The face detector and U²-Net segmenter run through exactly one inference backend selected at build time:

- `backend-ort`: ONNX Runtime for both models. Preferred for x86_64 Lambda builds.
- `backend-tract`: `tract-onnx` for both models. Preferred for arm64 builds and fully static builds.

The backends are mutually exclusive and there is no default backend. Build commands must pass exactly one of `--features backend-ort` or `--features backend-tract`.

It uses:

- `ultraface-rfb-320`-style ONNX output for the "exactly one face" check
- either `u2net_human_seg` or `u2netp`-style ONNX output for foreground matting

The library loads both models once, then exposes a single `process` call that:

1. rejects images with zero or multiple faces
2. computes a portrait crop around the detected face
3. removes the background with the segmentation mask
4. composites the portrait over a vertical gradient
5. optionally overlays a caller-provided watermark PNG

Expected model files are not committed here. The caller should provide filesystem paths at startup.

Default output size is `768x960` with gradient `#B15B86 -> #440F50`.

## Segmenter choice

- `u2net_human_seg`: default and recommended for production portrait crops; better tuned for human mattes.
- `u2netp`: much smaller and easier to test on CPU; usually faster, but less precise around hair, shoulders, and thin edges.

Switching between them is just a constructor choice:

```rust
use face_crop_fast::{FaceCropper, FaceCropperConfig, SegmenterPreset};

let cropper = FaceCropper::new_with_segmenter_preset(
    face_detector_model_path,
    segmenter_model_path,
    SegmenterPreset::U2NetP,
    FaceCropperConfig::default(),
)?;
```

If you want the existing default behavior, `FaceCropper::new(...)` still uses `SegmenterPreset::U2NetHumanSeg`.

## Try It On Disk

There is a tiny local CLI in `src/bin/run.rs`. It expects an input image and output path, and uses these defaults unless overridden:

- `--ultraface models/ultraface-rfb-320.onnx`
- `--u2net models/u2netp.onnx`
- no watermark unless you pass `--watermark`

From this directory:

```bash
cargo run --bin run --features backend-tract -- \
  /absolute/path/to/input.jpg \
  /absolute/path/to/output.png
```

To add a watermark:

```bash
cargo run --bin run --features backend-tract -- \
  /absolute/path/to/input.jpg \
  /absolute/path/to/output.png \
  --watermark /absolute/path/to/watermark.png
```

To switch to `u2net_human_seg`:

```bash
cargo run --bin run --features backend-tract -- \
  /absolute/path/to/input.jpg \
  /absolute/path/to/output.png \
  --u2net /absolute/path/to/u2net_human_seg.onnx
```

The command writes a composited PNG and prints the detected face confidence plus the crop rectangle it used.

## Build Backends

Use `backend-tract` for pure-Rust local development:

```bash
cargo run --bin run --features backend-tract -- \
  /absolute/path/to/input.jpg \
  /absolute/path/to/output.png
```

For an ORT-only build:

```bash
cargo build --release --bin lambda --features backend-ort
```

The Lambda ZIP helper defaults to ORT on x86_64 and tract on arm64:

```bash
bash scripts/build-lambda-zip.sh x86_64
bash scripts/build-lambda-zip.sh arm64
```

Override the backend explicitly with a second argument or `FACE_CROP_BACKEND`:

```bash
bash scripts/build-lambda-zip.sh x86_64 tract
FACE_CROP_BACKEND=ort bash scripts/build-lambda-zip.sh arm64
```

## Download Models

There is a helper script that downloads the default ONNX files into `models/`:

```bash
bash scripts/download-models.sh
```

It downloads `ultraface-rfb-320.onnx` and `u2netp.onnx`, then prompts before downloading the much larger `u2net_human_seg.onnx`.
