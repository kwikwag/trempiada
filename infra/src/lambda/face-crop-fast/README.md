# face-crop-fast

Small Rust library for fast portrait extraction from a mobile photo.

Runtime target: CPU only. The face detector runs through `tract-onnx`, and the U²-Net segmenter runs through ONNX Runtime CPU for broader ONNX operator compatibility.

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
cargo run --bin run -- \
  /absolute/path/to/input.jpg \
  /absolute/path/to/output.png
```

To add a watermark:

```bash
cargo run --bin run -- \
  /absolute/path/to/input.jpg \
  /absolute/path/to/output.png \
  --watermark /absolute/path/to/watermark.png
```

To switch to `u2net_human_seg`:

```bash
cargo run --bin run -- \
  /absolute/path/to/input.jpg \
  /absolute/path/to/output.png \
  --u2net /absolute/path/to/u2net_human_seg.onnx
```

The command writes a composited PNG and prints the detected face confidence plus the crop rectangle it used.

## Download Models

There is a helper script that downloads the default ONNX files into `models/`:

```bash
bash scripts/download-models.sh
```

It downloads `ultraface-rfb-320.onnx` and `u2netp.onnx`, then prompts before downloading the much larger `u2net_human_seg.onnx`.
