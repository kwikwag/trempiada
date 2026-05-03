use std::env;
use std::path::Path;

use image::imageops::{self, FilterType};
use tract_onnx::prelude::*;

fn main() {
    if let Err(err) = run() {
        eprintln!("{err}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let mut args = env::args().skip(1);
    let image_path = args.next().ok_or_else(|| {
        String::from("usage: cargo run --bin debug-face -- <image> [face_model.onnx]")
    })?;
    let model_path = args
        .next()
        .unwrap_or_else(|| String::from("models/ultraface-rfb-320.onnx"));

    let image = image::open(&image_path)
        .map_err(|err| format!("failed to open image {}: {err}", image_path))?
        .to_rgb8();
    let resized = imageops::resize(&image, 320, 240, FilterType::Triangle);
    let input = face_detector_tensor(&resized);

    let model = tract_onnx::onnx()
        .model_for_path(Path::new(&model_path))
        .map_err(|err| format!("failed to load model: {err}"))?
        .with_input_fact(
            0,
            InferenceFact::dt_shape(f32::datum_type(), tvec!(1, 3, 240_i64, 320_i64)),
        )
        .map_err(|err| format!("failed to set input fact: {err}"))?
        .into_optimized()
        .map_err(|err| format!("failed to optimize model: {err}"))?
        .into_runnable()
        .map_err(|err| format!("failed to make model runnable: {err}"))?;

    let outputs = model
        .run(tvec!(input.into()))
        .map_err(|err| format!("inference failed: {err}"))?;

    for (index, output) in outputs.iter().enumerate() {
        let view = output
            .to_array_view::<f32>()
            .map_err(|err| format!("failed to read output {index}: {err}"))?;
        println!("output[{index}] shape={:?}", view.shape());

        match view.shape() {
            [1, count, 2] => {
                let mut scored = Vec::new();
                for i in 0..*count {
                    scored.push((i, view[[0, i, 1]], view[[0, i, 0]]));
                }
                scored.sort_by(|a, b| b.1.total_cmp(&a.1));
                println!("top scores:");
                for (i, face_score, background_score) in scored.into_iter().take(10) {
                    println!("  idx={i} face={face_score:.6} bg={background_score:.6}");
                }
            }
            [1, count, 4] => {
                let priors = ultraface_priors(320.0, 240.0);
                println!("first raw boxes:");
                for i in 0..(*count).min(5) {
                    println!(
                        "  idx={i} box=({:.3}, {:.3}, {:.3}, {:.3})",
                        view[[0, i, 0]],
                        view[[0, i, 1]],
                        view[[0, i, 2]],
                        view[[0, i, 3]]
                    );
                }
                let interesting = [4291_usize, 4271, 4396, 4293, 4311, 4273, 4381, 4399, 4289, 4397];
                println!("decoded top candidate boxes:");
                for idx in interesting {
                    let prior = priors[idx];
                    let (x1, y1, x2, y2) = decode_ultraface_box(
                        view[[0, idx, 0]],
                        view[[0, idx, 1]],
                        view[[0, idx, 2]],
                        view[[0, idx, 3]],
                        prior,
                    );
                    println!("  idx={idx} decoded=({x1:.3}, {y1:.3}, {x2:.3}, {y2:.3})");
                }

                let scores = outputs[0]
                    .to_array_view::<f32>()
                    .map_err(|err| format!("failed to read scores: {err}"))?;
                let kept = collect_detections(&scores, &view, &priors, 0.72, 0.25);
                println!("kept detections after nms:");
                for (idx, detection) in kept.iter().enumerate() {
                    println!(
                        "  kept[{idx}] score={:.6} box=({:.3}, {:.3}, {:.3}, {:.3})",
                        detection.4, detection.0, detection.1, detection.2, detection.3
                    );
                }
            }
            _ => {}
        }
    }

    Ok(())
}

fn face_detector_tensor(
    image: &image::ImageBuffer<image::Rgb<u8>, Vec<u8>>,
) -> Tensor {
    let (width, height) = image.dimensions();
    let mut tensor = tract_ndarray::Array4::<f32>::zeros((1, 3, height as usize, width as usize));

    for (x, y, pixel) in image.enumerate_pixels() {
        let [r, g, b] = pixel.0;
        tensor[[0, 0, y as usize, x as usize]] = (b as f32 - 127.0) / 128.0;
        tensor[[0, 1, y as usize, x as usize]] = (g as f32 - 127.0) / 128.0;
        tensor[[0, 2, y as usize, x as usize]] = (r as f32 - 127.0) / 128.0;
    }

    tensor.into()
}

fn ultraface_priors(input_width: f32, input_height: f32) -> Vec<[f32; 4]> {
    let strides = [8.0_f32, 16.0, 32.0, 64.0];
    let min_boxes: [&[f32]; 4] = [
        &[10.0, 16.0, 24.0],
        &[32.0, 48.0],
        &[64.0, 96.0],
        &[128.0, 192.0, 256.0],
    ];
    let mut priors = Vec::new();

    for (stride, boxes_for_stride) in strides.iter().zip(min_boxes.iter()) {
        let feature_map_width = (input_width / stride).ceil() as usize;
        let feature_map_height = (input_height / stride).ceil() as usize;
        let scale_width = input_width / stride;
        let scale_height = input_height / stride;

        for y in 0..feature_map_height {
            for x in 0..feature_map_width {
                let center_x = (x as f32 + 0.5) / scale_width;
                let center_y = (y as f32 + 0.5) / scale_height;

                for min_box in *boxes_for_stride {
                    priors.push([
                        center_x,
                        center_y,
                        min_box / input_width,
                        min_box / input_height,
                    ]);
                }
            }
        }
    }

    priors
}

fn decode_ultraface_box(
    delta_x: f32,
    delta_y: f32,
    delta_w: f32,
    delta_h: f32,
    prior: [f32; 4],
) -> (f32, f32, f32, f32) {
    let center_variance = 0.1_f32;
    let size_variance = 0.2_f32;

    let center_x = delta_x * center_variance * prior[2] + prior[0];
    let center_y = delta_y * center_variance * prior[3] + prior[1];
    let width = (delta_w * size_variance).exp() * prior[2];
    let height = (delta_h * size_variance).exp() * prior[3];

    (
        center_x - width * 0.5,
        center_y - height * 0.5,
        center_x + width * 0.5,
        center_y + height * 0.5,
    )
}

fn collect_detections(
    scores: &tract_ndarray::ArrayViewD<'_, f32>,
    boxes: &tract_ndarray::ArrayViewD<'_, f32>,
    priors: &[[f32; 4]],
    score_threshold: f32,
    iou_threshold: f32,
) -> Vec<(f32, f32, f32, f32, f32)> {
    let mut candidates = Vec::new();

    for index in 0..boxes.shape()[1] {
        let confidence = scores[[0, index, 1]];
        if confidence < score_threshold {
            continue;
        }

        let prior = priors[index];
        let (x1, y1, x2, y2) = decode_ultraface_box(
            boxes[[0, index, 0]],
            boxes[[0, index, 1]],
            boxes[[0, index, 2]],
            boxes[[0, index, 3]],
            prior,
        );
        candidates.push((
            x1.clamp(0.0, 1.0),
            y1.clamp(0.0, 1.0),
            x2.clamp(0.0, 1.0),
            y2.clamp(0.0, 1.0),
            confidence,
        ));
    }

    candidates.sort_by(|left, right| right.4.total_cmp(&left.4));
    let mut kept = Vec::new();

    'candidate: for candidate in candidates {
        for existing in &kept {
            if iou(candidate, *existing) > iou_threshold {
                continue 'candidate;
            }
        }
        kept.push(candidate);
    }

    kept
}

fn iou(left: (f32, f32, f32, f32, f32), right: (f32, f32, f32, f32, f32)) -> f32 {
    let x1 = left.0.max(right.0);
    let y1 = left.1.max(right.1);
    let x2 = left.2.min(right.2);
    let y2 = left.3.min(right.3);
    let intersection = (x2 - x1).max(0.0) * (y2 - y1).max(0.0);
    if intersection <= 0.0 {
        return 0.0;
    }

    let left_area = (left.2 - left.0).max(0.0) * (left.3 - left.1).max(0.0);
    let right_area = (right.2 - right.0).max(0.0) * (right.3 - right.1).max(0.0);
    intersection / (left_area + right_area - intersection)
}
