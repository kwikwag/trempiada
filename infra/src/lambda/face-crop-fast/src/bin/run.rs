use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process;

use face_crop_fast::{FaceCropRequest, FaceCropper, FaceCropperConfig, SegmenterPreset};

const DEFAULT_ULTRAFACE_PATH: &str = "models/ultraface-rfb-320.onnx";
const DEFAULT_U2NET_PATH: &str = "models/u2netp.onnx";

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let options = parse_args(env::args().skip(1))?;

    let image_bytes = fs::read(&options.image_path)
        .map_err(|err| format!("failed to read image {}: {err}", options.image_path.display()))?;
    let watermark_bytes = match options.watermark_path.as_ref() {
        Some(watermark_path) => Some(fs::read(watermark_path).map_err(|err| {
            format!(
                "failed to read watermark {}: {err}",
                watermark_path.display()
            )
        })?),
        None => None,
    };

    let cropper = FaceCropper::new_with_segmenter_preset(
        &options.face_model_path,
        &options.segmenter_model_path,
        options.segmenter_preset,
        FaceCropperConfig::default(),
    )
    .map_err(|err| format!("failed to initialize cropper: {err}"))?;

    let result = cropper
        .process(FaceCropRequest {
            image_bytes: &image_bytes,
            watermark_png_bytes: watermark_bytes.as_deref(),
        })
        .map_err(|err| format!("processing failed: {err}"))?;

    fs::write(&options.output_path, &result.png_bytes)
        .map_err(|err| format!("failed to write output {}: {err}", options.output_path.display()))?;

    println!(
        "wrote {} (face {:.3}, crop {}x{}+{},{} -> {}x{})",
        options.output_path.display(),
        result.face_box.confidence,
        result.crop_rect.width,
        result.crop_rect.height,
        result.crop_rect.x,
        result.crop_rect.y,
        result.output_width,
        result.output_height,
    );

    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
struct CliOptions {
    image_path: PathBuf,
    output_path: PathBuf,
    watermark_path: Option<PathBuf>,
    face_model_path: PathBuf,
    segmenter_model_path: PathBuf,
    segmenter_preset: SegmenterPreset,
}

fn parse_args(args: impl Iterator<Item = String>) -> Result<CliOptions, String> {
    let mut args = args;
    let mut image_path = None;
    let mut output_path = None;
    let mut watermark_path = None;
    let mut face_model_path = PathBuf::from(DEFAULT_ULTRAFACE_PATH);
    let mut segmenter_model_path = PathBuf::from(DEFAULT_U2NET_PATH);

    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--help" | "-h" => return Err(usage_error(None)),
            "--watermark" => watermark_path = Some(next_flag_path(&mut args, "--watermark")?),
            "--ultraface" => face_model_path = next_flag_path(&mut args, "--ultraface")?,
            "--u2net" => segmenter_model_path = next_flag_path(&mut args, "--u2net")?,
            value if value.starts_with("--") => {
                return Err(usage_error(Some(format!("unknown flag `{value}`"))));
            }
            value => {
                if image_path.is_none() {
                    image_path = Some(PathBuf::from(value));
                } else if output_path.is_none() {
                    output_path = Some(PathBuf::from(value));
                } else {
                    return Err(usage_error(Some(format!(
                        "unexpected extra positional argument `{value}`"
                    ))));
                }
            }
        }
    }

    let image_path = image_path.ok_or_else(|| usage_error(Some(String::from("missing input image path"))))?;
    let output_path = output_path.ok_or_else(|| usage_error(Some(String::from("missing output image path"))))?;

    Ok(CliOptions {
        image_path,
        output_path,
        watermark_path,
        face_model_path,
        segmenter_model_path: segmenter_model_path.clone(),
        segmenter_preset: infer_segmenter_preset(&segmenter_model_path),
    })
}

fn next_flag_path(args: &mut impl Iterator<Item = String>, flag: &str) -> Result<PathBuf, String> {
    args.next()
        .map(PathBuf::from)
        .ok_or_else(|| usage_error(Some(format!("missing value for {flag}"))))
}

fn infer_segmenter_preset(path: &Path) -> SegmenterPreset {
    let lowercase = path
        .file_name()
        .and_then(|file_name| file_name.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();

    if lowercase.contains("human_seg") {
        SegmenterPreset::U2NetHumanSeg
    } else {
        SegmenterPreset::U2NetP
    }
}

fn usage_error(message: Option<String>) -> String {
    let prefix = message.map(|message| format!("{message}\n")).unwrap_or_default();
    format!(
        "{prefix}usage: cargo run --bin run -- <input> <output> [--watermark <watermark.png>] [--ultraface <face_model.onnx>] [--u2net <segmenter_model.onnx>]"
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_args_uses_defaults_and_optional_watermark() {
        let options = parse_args(
            [
                "input.jpg".to_string(),
                "output.png".to_string(),
                "--watermark".to_string(),
                "wm.png".to_string(),
            ]
            .into_iter(),
        )
        .expect("parse args");

        assert_eq!(options.image_path, PathBuf::from("input.jpg"));
        assert_eq!(options.output_path, PathBuf::from("output.png"));
        assert_eq!(options.watermark_path, Some(PathBuf::from("wm.png")));
        assert_eq!(options.face_model_path, PathBuf::from(DEFAULT_ULTRAFACE_PATH));
        assert_eq!(options.segmenter_model_path, PathBuf::from(DEFAULT_U2NET_PATH));
        assert_eq!(options.segmenter_preset, SegmenterPreset::U2NetP);
    }

    #[test]
    fn parse_args_allows_model_overrides() {
        let options = parse_args(
            [
                "--ultraface".to_string(),
                "custom-face.onnx".to_string(),
                "--u2net".to_string(),
                "models/u2net_human_seg.onnx".to_string(),
                "input.jpg".to_string(),
                "output.png".to_string(),
            ]
            .into_iter(),
        )
        .expect("parse args");

        assert_eq!(options.face_model_path, PathBuf::from("custom-face.onnx"));
        assert_eq!(
            options.segmenter_model_path,
            PathBuf::from("models/u2net_human_seg.onnx")
        );
        assert_eq!(options.segmenter_preset, SegmenterPreset::U2NetHumanSeg);
    }

    #[test]
    fn parse_args_rejects_unknown_flags() {
        let error = parse_args(
            [
                "input.jpg".to_string(),
                "output.png".to_string(),
                "--bad".to_string(),
            ]
            .into_iter(),
        )
        .expect_err("unknown flag should fail");

        assert!(error.contains("unknown flag `--bad`"));
    }
}
