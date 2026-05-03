use std::path::Path;
#[cfg(all(target_arch = "x86_64", feature = "ort-backend"))]
use std::sync::Mutex;

use image::codecs::png::PngEncoder;
use image::imageops::{self, FilterType};
use image::{DynamicImage, GrayImage, ImageBuffer, ImageEncoder, Luma, Rgba, RgbaImage};
use thiserror::Error;
use tract_onnx::prelude::*;

type TractRunner = SimplePlan<TypedFact, Box<dyn TypedOp>, TypedModel>;
#[cfg(all(target_arch = "x86_64", feature = "ort-backend"))]
type SegmenterRunner = OrtSegmenter;
#[cfg(not(all(target_arch = "x86_64", feature = "ort-backend")))]
type SegmenterRunner = TractRunner;

const DEFAULT_OUTPUT_WIDTH: u32 = 768;
const DEFAULT_OUTPUT_HEIGHT: u32 = 960;
const DEFAULT_GRADIENT_TOP: [u8; 3] = [0xB1, 0x5B, 0x86];
const DEFAULT_GRADIENT_BOTTOM: [u8; 3] = [0x44, 0x0F, 0x50];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SegmenterPreset {
    U2NetHumanSeg,
    U2NetP,
}

impl SegmenterPreset {
    pub fn model_name(self) -> &'static str {
        match self {
            Self::U2NetHumanSeg => "u2net_human_seg",
            Self::U2NetP => "u2netp",
        }
    }

    pub fn default_input_size(self) -> usize {
        320
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct SegmenterPresetParseError;

impl std::str::FromStr for SegmenterPreset {
    type Err = SegmenterPresetParseError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        match value {
            "u2net_human_seg" | "human" => Ok(Self::U2NetHumanSeg),
            "u2netp" | "small" => Ok(Self::U2NetP),
            _ => Err(SegmenterPresetParseError),
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FaceCropperConfig {
    pub face_input_width: usize,
    pub face_input_height: usize,
    pub segmentation_input_size: usize,
    pub face_score_threshold: f32,
    pub face_iou_threshold: f32,
    pub min_face_area_ratio: f32,
    pub output_width: u32,
    pub output_height: u32,
    pub gradient_top: [u8; 3],
    pub gradient_bottom: [u8; 3],
    pub mask_blur_sigma: f32,
    pub crop_aspect_ratio: f32,
    pub crop_face_height_multiplier: f32,
    pub crop_face_top_padding: f32,
    pub watermark_opacity: f32,
    pub watermark_max_width_ratio: f32,
    pub watermark_margin_ratio: f32,
}

impl Default for FaceCropperConfig {
    fn default() -> Self {
        Self {
            face_input_width: 320,
            face_input_height: 240,
            segmentation_input_size: 320,
            face_score_threshold: 0.72,
            face_iou_threshold: 0.25,
            min_face_area_ratio: 0.012,
            output_width: DEFAULT_OUTPUT_WIDTH,
            output_height: DEFAULT_OUTPUT_HEIGHT,
            gradient_top: DEFAULT_GRADIENT_TOP,
            gradient_bottom: DEFAULT_GRADIENT_BOTTOM,
            mask_blur_sigma: 1.4,
            crop_aspect_ratio: 4.0 / 5.0,
            crop_face_height_multiplier: 3.15,
            crop_face_top_padding: 0.68,
            watermark_opacity: 0.7,
            watermark_max_width_ratio: 0.18,
            watermark_margin_ratio: 0.03,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct FaceBox {
    pub x1: f32,
    pub y1: f32,
    pub x2: f32,
    pub y2: f32,
    pub confidence: f32,
}

impl FaceBox {
    fn width(self) -> f32 {
        (self.x2 - self.x1).max(f32::EPSILON)
    }

    fn height(self) -> f32 {
        (self.y2 - self.y1).max(f32::EPSILON)
    }

    fn center_x(self) -> f32 {
        (self.x1 + self.x2) * 0.5
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CropRect {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

#[derive(Debug)]
pub struct FaceCropResult {
    pub png_bytes: Vec<u8>,
    pub face_box: FaceBox,
    pub crop_rect: CropRect,
    pub output_width: u32,
    pub output_height: u32,
}

pub struct FaceCropRequest<'a> {
    pub image_bytes: &'a [u8],
    pub watermark_png_bytes: Option<&'a [u8]>,
}

pub struct FaceCropper {
    face_detector: TractRunner,
    segmenter: SegmenterRunner,
    config: FaceCropperConfig,
}

#[cfg(all(target_arch = "x86_64", feature = "ort-backend"))]
struct OrtSegmenter {
    session: Mutex<ort::session::Session>,
}

#[derive(Debug, Error)]
pub enum FaceCropError {
    #[error("image decode failed: {0}")]
    ImageDecode(String),
    #[error("watermark decode failed: {0}")]
    WatermarkDecode(String),
    #[error("face detector model failed: {0}")]
    FaceDetectorModel(String),
    #[error("segmenter model failed: {0}")]
    SegmenterModel(String),
    #[error("no face detected")]
    NoFaceDetected,
    #[error("multiple faces detected: {0}")]
    MultipleFacesDetected(usize),
    #[error("model returned an unexpected tensor shape")]
    UnexpectedTensorShape,
    #[error("watermark must have non-zero dimensions")]
    EmptyWatermark,
    #[error("png encode failed: {0}")]
    Encode(String),
}

impl FaceCropper {
    /// Creates a CPU-only cropper backed by tract-onnx.
    /// Defaults to the human-specific U^2-Net segmenter preset.
    pub fn new(
        face_detector_model_path: &Path,
        segmenter_model_path: &Path,
        config: FaceCropperConfig,
    ) -> Result<Self, FaceCropError> {
        Self::new_with_segmenter_preset(
            face_detector_model_path,
            segmenter_model_path,
            SegmenterPreset::U2NetHumanSeg,
            config,
        )
    }

    /// Creates a CPU-only cropper with an explicit segmentation model preset.
    ///
    /// `u2net_human_seg` is usually the better production choice for portraits.
    /// `u2netp` is much smaller and useful for fast A/B tests on CPU, but it is
    /// not specialized for humans and may cut hair and shoulders less cleanly.
    pub fn new_with_segmenter_preset(
        face_detector_model_path: &Path,
        segmenter_model_path: &Path,
        segmenter_preset: SegmenterPreset,
        config: FaceCropperConfig,
    ) -> Result<Self, FaceCropError> {
        let segmentation_input_size = if config.segmentation_input_size == 0 {
            segmenter_preset.default_input_size()
        } else {
            config.segmentation_input_size
        };
        let face_detector = load_model(
            face_detector_model_path,
            config.face_input_width,
            config.face_input_height,
            "face detector",
        )?;
        let segmenter = load_segmenter_model(
            segmenter_model_path,
            segmenter_preset.model_name(),
            segmentation_input_size,
        )?;

        let mut config = config;
        config.segmentation_input_size = segmentation_input_size;

        Ok(Self {
            face_detector,
            segmenter,
            config,
        })
    }

    pub fn process(&self, request: FaceCropRequest<'_>) -> Result<FaceCropResult, FaceCropError> {
        let input_image = image::load_from_memory(request.image_bytes)
            .map_err(|err| FaceCropError::ImageDecode(err.to_string()))?;
        let watermark = request
            .watermark_png_bytes
            .map(|watermark_png_bytes| {
                let watermark = image::load_from_memory(watermark_png_bytes)
                    .map_err(|err| FaceCropError::WatermarkDecode(err.to_string()))?
                    .to_rgba8();

                if watermark.width() == 0 || watermark.height() == 0 {
                    return Err(FaceCropError::EmptyWatermark);
                }

                Ok(watermark)
            })
            .transpose()?;

        let face = self.detect_single_face(&input_image)?;
        let crop_rect = compute_crop_rect(
            input_image.width(),
            input_image.height(),
            face,
            &self.config,
        );

        let cropped = imageops::crop_imm(
            &input_image.to_rgba8(),
            crop_rect.x,
            crop_rect.y,
            crop_rect.width,
            crop_rect.height,
        )
        .to_image();

        let mask = self.segment_foreground(&cropped)?;
        let mut resized_foreground = imageops::resize(
            &cropped,
            self.config.output_width,
            self.config.output_height,
            FilterType::CatmullRom,
        );
        let resized_mask = imageops::resize(
            &mask,
            self.config.output_width,
            self.config.output_height,
            FilterType::CatmullRom,
        );
        let mut composited = paint_gradient(
            self.config.output_width,
            self.config.output_height,
            self.config.gradient_top,
            self.config.gradient_bottom,
        );
        if let Some(watermark) = watermark.as_ref() {
            overlay_watermark(
                &mut resized_foreground,
                &resized_mask,
                watermark,
                &self.config,
            );
        }
        composite_with_mask(&mut composited, &resized_foreground, &resized_mask);

        let png_bytes = encode_png(&composited)?;

        Ok(FaceCropResult {
            png_bytes,
            face_box: face,
            crop_rect,
            output_width: self.config.output_width,
            output_height: self.config.output_height,
        })
    }

    fn detect_single_face(&self, image: &DynamicImage) -> Result<FaceBox, FaceCropError> {
        let rgb = image.to_rgb8();
        let resized = imageops::resize(
            &rgb,
            self.config.face_input_width as u32,
            self.config.face_input_height as u32,
            FilterType::Triangle,
        );

        let input = face_detector_tensor(&resized);
        let outputs = self
            .face_detector
            .run(tvec!(input.into()))
            .map_err(|err| FaceCropError::FaceDetectorModel(err.to_string()))?;

        let detections = parse_ultraface_detections(
            &outputs,
            self.config.face_score_threshold,
            self.config.face_iou_threshold,
            self.config.min_face_area_ratio,
            self.config.face_input_width as f32,
            self.config.face_input_height as f32,
        )?;

        match detections.len() {
            0 => Err(FaceCropError::NoFaceDetected),
            1 => {
                let face = detections[0];
                let scale_x = image.width() as f32;
                let scale_y = image.height() as f32;

                Ok(FaceBox {
                    x1: face.x1 * scale_x,
                    y1: face.y1 * scale_y,
                    x2: face.x2 * scale_x,
                    y2: face.y2 * scale_y,
                    confidence: face.confidence,
                })
            }
            count => Err(FaceCropError::MultipleFacesDetected(count)),
        }
    }

    fn segment_foreground(&self, cropped: &RgbaImage) -> Result<GrayImage, FaceCropError> {
        let rgb = DynamicImage::ImageRgba8(cropped.clone()).to_rgb8();
        let sz = self.config.segmentation_input_size;
        let resized = imageops::resize(&rgb, sz as u32, sz as u32, FilterType::Triangle);

        let raw_mask = run_segmenter(&self.segmenter, segmentation_tensor(&resized), sz)?;
        let blurred = imageops::blur(&raw_mask, self.config.mask_blur_sigma);

        Ok(imageops::resize(
            &blurred,
            cropped.width(),
            cropped.height(),
            FilterType::CatmullRom,
        ))
    }
}

fn load_model(
    model_path: &Path,
    input_width: usize,
    input_height: usize,
    kind: &str,
) -> Result<TractRunner, FaceCropError> {
    tract_onnx::onnx()
        .model_for_path(model_path)
        .and_then(|model| {
            model
                .with_input_fact(
                    0,
                    InferenceFact::dt_shape(
                        f32::datum_type(),
                        tvec!(1, 3, input_height as i64, input_width as i64),
                    ),
                )?
                .into_optimized()?
                .into_runnable()
        })
        .map_err(|err| {
            if kind == "face detector" {
                FaceCropError::FaceDetectorModel(err.to_string())
            } else {
                FaceCropError::SegmenterModel(format!("{kind}: {err}"))
            }
        })
}

#[cfg(not(all(target_arch = "x86_64", feature = "ort-backend")))]
fn load_segmenter_model(
    model_path: &Path,
    model_name: &str,
    input_size: usize,
) -> Result<SegmenterRunner, FaceCropError> {
    // TODO: tract currently mis-evaluates Resize sizes in the U2Net model on
    // this path. Keep it for portability, but prefer the ORT backend on x86_64.
    tract_onnx::onnx()
        .model_for_path(model_path)
        .and_then(|model| {
            model
                .with_input_fact(
                    0,
                    InferenceFact::dt_shape(
                        f32::datum_type(),
                        tvec!(1i64, 3i64, input_size as i64, input_size as i64),
                    ),
                )?
                .into_optimized()?
                .into_runnable()
        })
        .map_err(|err| FaceCropError::SegmenterModel(format!("{model_name}: {err}")))
}

#[cfg(all(target_arch = "x86_64", feature = "ort-backend"))]
fn load_segmenter_model(
    model_path: &Path,
    model_name: &str,
    _input_size: usize,
) -> Result<SegmenterRunner, FaceCropError> {
    use ort::session::{builder::GraphOptimizationLevel, Session};

    let session = Session::builder()
        .map_err(|err| FaceCropError::SegmenterModel(format!("{model_name}: {err}")))?
        .with_optimization_level(GraphOptimizationLevel::Level3)
        .map_err(|err| FaceCropError::SegmenterModel(format!("{model_name}: {err}")))?
        .commit_from_file(model_path)
        .map_err(|err| FaceCropError::SegmenterModel(format!("{model_name}: {err}")))?;

    Ok(OrtSegmenter {
        session: Mutex::new(session),
    })
}

#[cfg(not(all(target_arch = "x86_64", feature = "ort-backend")))]
fn run_segmenter(
    segmenter: &SegmenterRunner,
    input: Vec<f32>,
    input_size: usize,
) -> Result<GrayImage, FaceCropError> {
    let tensor: Tensor =
        tract_ndarray::Array4::from_shape_vec((1, 3, input_size, input_size), input)
            .map_err(|err| FaceCropError::SegmenterModel(err.to_string()))?
            .into();
    let outputs = segmenter
        .run(tvec!(tensor.into()))
        .map_err(|err| FaceCropError::SegmenterModel(err.to_string()))?;

    extract_tract_mask(&outputs[0])
}

#[cfg(all(target_arch = "x86_64", feature = "ort-backend"))]
fn run_segmenter(
    segmenter: &SegmenterRunner,
    input: Vec<f32>,
    input_size: usize,
) -> Result<GrayImage, FaceCropError> {
    use ort::value::Tensor as OrtTensor;

    let tensor = OrtTensor::from_array((
        [1_usize, 3, input_size, input_size],
        input.into_boxed_slice(),
    ))
    .map_err(|err| FaceCropError::SegmenterModel(err.to_string()))?;
    let mut session = segmenter.session.lock().map_err(|err| {
        FaceCropError::SegmenterModel(format!("ort session lock poisoned: {err}"))
    })?;
    let outputs = session
        .run(ort::inputs![tensor])
        .map_err(|err| FaceCropError::SegmenterModel(err.to_string()))?;
    let (shape, data) = outputs[0]
        .try_extract_tensor::<f32>()
        .map_err(|err| FaceCropError::SegmenterModel(err.to_string()))?;
    let shape = shape
        .iter()
        .map(|dimension| {
            usize::try_from(*dimension).map_err(|_| FaceCropError::UnexpectedTensorShape)
        })
        .collect::<Result<Vec<_>, _>>()?;

    extract_mask_from_f32_data(&shape, data)
}

fn face_detector_tensor(image: &ImageBuffer<image::Rgb<u8>, Vec<u8>>) -> Tensor {
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

fn segmentation_tensor(image: &ImageBuffer<image::Rgb<u8>, Vec<u8>>) -> Vec<f32> {
    let (width, height) = image.dimensions();
    let mut tensor = vec![0.0_f32; 3 * height as usize * width as usize];

    for (x, y, pixel) in image.enumerate_pixels() {
        let [r, g, b] = pixel.0;
        let rf = r as f32 / 255.0;
        let gf = g as f32 / 255.0;
        let bf = b as f32 / 255.0;
        let pixel_index = y as usize * width as usize + x as usize;
        let channel_stride = width as usize * height as usize;
        tensor[pixel_index] = (rf - 0.485) / 0.229;
        tensor[channel_stride + pixel_index] = (gf - 0.456) / 0.224;
        tensor[channel_stride * 2 + pixel_index] = (bf - 0.406) / 0.225;
    }

    tensor
}

fn parse_ultraface_detections(
    outputs: &TVec<TValue>,
    score_threshold: f32,
    iou_threshold: f32,
    min_face_area_ratio: f32,
    detector_input_width: f32,
    detector_input_height: f32,
) -> Result<Vec<FaceBox>, FaceCropError> {
    let mut boxes_view = None;
    let mut scores_view = None;

    for output in outputs {
        let view = output
            .to_array_view::<f32>()
            .map_err(|err| FaceCropError::FaceDetectorModel(err.to_string()))?;
        match view.shape() {
            [1, _, 4] => boxes_view = Some(view),
            [1, _, 2] => scores_view = Some(view),
            _ => {}
        }
    }

    let boxes = boxes_view.ok_or(FaceCropError::UnexpectedTensorShape)?;
    let scores = scores_view.ok_or(FaceCropError::UnexpectedTensorShape)?;
    let count = boxes.shape()[1];
    let priors = ultraface_priors(detector_input_width, detector_input_height);
    if priors.len() != count {
        return Err(FaceCropError::UnexpectedTensorShape);
    }
    let min_area = min_face_area_ratio.max(0.0);
    let mut candidates = Vec::new();

    for index in 0..count {
        let confidence = scores[[0, index, 1]];
        if confidence < score_threshold {
            continue;
        }

        let prior = priors
            .get(index)
            .copied()
            .ok_or(FaceCropError::UnexpectedTensorShape)?;
        let (x1, y1, x2, y2) = decode_ultraface_box(
            boxes[[0, index, 0]],
            boxes[[0, index, 1]],
            boxes[[0, index, 2]],
            boxes[[0, index, 3]],
            prior,
        );
        let x1 = x1.clamp(0.0, 1.0);
        let y1 = y1.clamp(0.0, 1.0);
        let x2 = x2.clamp(0.0, 1.0);
        let y2 = y2.clamp(0.0, 1.0);
        let area_ratio = ((x2 - x1).max(0.0)) * ((y2 - y1).max(0.0));

        if area_ratio < min_area {
            continue;
        }

        candidates.push(FaceBox {
            x1,
            y1,
            x2,
            y2,
            confidence,
        });
    }

    candidates.sort_by(|left, right| right.confidence.total_cmp(&left.confidence));
    let mut kept = Vec::new();

    'candidate: for candidate in candidates {
        for existing in &kept {
            if iou(candidate, *existing) > iou_threshold {
                continue 'candidate;
            }
        }

        kept.push(candidate);
    }

    Ok(kept)
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

fn iou(left: FaceBox, right: FaceBox) -> f32 {
    let x1 = left.x1.max(right.x1);
    let y1 = left.y1.max(right.y1);
    let x2 = left.x2.min(right.x2);
    let y2 = left.y2.min(right.y2);

    let intersection = (x2 - x1).max(0.0) * (y2 - y1).max(0.0);
    if intersection <= 0.0 {
        return 0.0;
    }

    let left_area = left.width() * left.height();
    let right_area = right.width() * right.height();
    let union = left_area + right_area - intersection;

    if union <= 0.0 {
        0.0
    } else {
        intersection / union
    }
}

fn compute_crop_rect(
    image_width: u32,
    image_height: u32,
    face: FaceBox,
    config: &FaceCropperConfig,
) -> CropRect {
    let face_height = face.height();
    let extra_top_margin_ratio = 0.15_f32;
    let target_face_width_ratio = 0.70_f32;
    let target_face_height_ratio = 0.70_f32;
    let crop_width_from_face_width = face.width() / target_face_width_ratio;
    let crop_width_from_face_height =
        (face_height / target_face_height_ratio) * config.crop_aspect_ratio;
    let crop_width = crop_width_from_face_width
        .max(crop_width_from_face_height)
        .max(1.0)
        .min(image_width as f32);
    let crop_height = (crop_width / config.crop_aspect_ratio)
        .round()
        .min(image_height as f32);
    let crop_width = (crop_height * config.crop_aspect_ratio)
        .round()
        .min(image_width as f32);
    let mut x = face.center_x() - crop_width * 0.5;
    let mut y =
        ((face.y1 + face.y2) * 0.5) - crop_height * 0.5 - face_height * extra_top_margin_ratio;
    x = x.clamp(0.0, image_width as f32 - crop_width);
    y = y.clamp(0.0, image_height as f32 - crop_height);

    CropRect {
        x: x.round() as u32,
        y: y.round() as u32,
        width: crop_width.round().max(1.0) as u32,
        height: crop_height.round().max(1.0) as u32,
    }
}

#[cfg(not(all(target_arch = "x86_64", feature = "ort-backend")))]
fn extract_tract_mask(output: &TValue) -> Result<GrayImage, FaceCropError> {
    let view = output
        .to_array_view::<f32>()
        .map_err(|err| FaceCropError::SegmenterModel(err.to_string()))?;
    let shape = view.shape().to_vec();
    let data: Vec<f32> = view.iter().copied().collect();

    extract_mask_from_f32_data(&shape, &data)
}

fn extract_mask_from_f32_data(shape: &[usize], data: &[f32]) -> Result<GrayImage, FaceCropError> {
    let (height, width) = match shape {
        [1, 1, h, w] => (*h, *w),
        [1, h, w] => (*h, *w),
        [h, w] => (*h, *w),
        _ => return Err(FaceCropError::UnexpectedTensorShape),
    };
    if data.len() != height * width {
        return Err(FaceCropError::UnexpectedTensorShape);
    }

    let mut min_value = f32::INFINITY;
    let mut max_value = f32::NEG_INFINITY;
    for &v in data {
        min_value = min_value.min(v);
        max_value = max_value.max(v);
    }

    let scale = if (max_value - min_value).abs() < f32::EPSILON {
        1.0
    } else {
        1.0 / (max_value - min_value)
    };

    let mut mask = GrayImage::new(width as u32, height as u32);
    for y in 0..height {
        for x in 0..width {
            let normalized = ((data[y * width + x] - min_value) * scale).clamp(0.0, 1.0);
            let softened = smoothstep(0.08, 0.92, normalized);
            mask.put_pixel(x as u32, y as u32, Luma([(softened * 255.0).round() as u8]));
        }
    }

    Ok(mask)
}

fn smoothstep(edge0: f32, edge1: f32, value: f32) -> f32 {
    let t = ((value - edge0) / (edge1 - edge0)).clamp(0.0, 1.0);
    t * t * (3.0 - 2.0 * t)
}

fn paint_gradient(width: u32, height: u32, top: [u8; 3], bottom: [u8; 3]) -> RgbaImage {
    let mut background = RgbaImage::new(width, height);

    for y in 0..height {
        let t = if height <= 1 {
            0.0
        } else {
            y as f32 / (height - 1) as f32
        };
        let r = lerp_channel(top[0], bottom[0], t);
        let g = lerp_channel(top[1], bottom[1], t);
        let b = lerp_channel(top[2], bottom[2], t);

        for x in 0..width {
            background.put_pixel(x, y, Rgba([r, g, b, 255]));
        }
    }

    background
}

fn lerp_channel(start: u8, end: u8, t: f32) -> u8 {
    (start as f32 + (end as f32 - start as f32) * t).round() as u8
}

fn composite_with_mask(canvas: &mut RgbaImage, foreground: &RgbaImage, mask: &GrayImage) {
    for y in 0..canvas.height() {
        for x in 0..canvas.width() {
            let alpha = mask.get_pixel(x, y)[0] as f32 / 255.0;
            let background = canvas.get_pixel(x, y).0;
            let subject = foreground.get_pixel(x, y).0;
            let out = [
                blend_channel(subject[0], background[0], alpha),
                blend_channel(subject[1], background[1], alpha),
                blend_channel(subject[2], background[2], alpha),
                255,
            ];
            canvas.put_pixel(x, y, Rgba(out));
        }
    }
}

fn blend_channel(foreground: u8, background: u8, alpha: f32) -> u8 {
    (foreground as f32 * alpha + background as f32 * (1.0 - alpha)).round() as u8
}

fn overlay_watermark(
    subject: &mut RgbaImage,
    subject_mask: &GrayImage,
    watermark: &RgbaImage,
    config: &FaceCropperConfig,
) {
    let period_x = watermark.width() as f32;
    let period_y = watermark.height() as f32;
    let angle = -11.25_f32.to_radians();
    let cos_theta = angle.cos();
    let sin_theta = angle.sin();
    let center_x = subject.width() as f32 * 0.5;
    let center_y = subject.height() as f32 * 0.5;
    let opacity = config.watermark_opacity.clamp(0.0, 1.0);

    for y in 0..subject.height() {
        for x in 0..subject.width() {
            let subject_alpha = subject_mask.get_pixel(x, y)[0] as f32 / 255.0;
            if subject_alpha <= 0.0 {
                continue;
            }
            let dx = x as f32 - center_x;
            let dy = y as f32 - center_y;
            let pattern_x = dx * cos_theta + dy * sin_theta;
            let pattern_y = -dx * sin_theta + dy * cos_theta;
            let cell_x = (pattern_x + watermark.width() as f32 * 0.5).rem_euclid(period_x);
            let cell_y = (pattern_y + watermark.height() as f32 * 0.5).rem_euclid(period_y);

            if cell_x >= watermark.width() as f32 || cell_y >= watermark.height() as f32 {
                continue;
            }

            let foreground = watermark.get_pixel(cell_x as u32, cell_y as u32).0;
            let alpha = (foreground[3] as f32 / 255.0) * opacity * subject_alpha;
            if alpha <= 0.0 {
                continue;
            }

            let background = subject.get_pixel(x, y).0;
            let out = [
                blend_channel(foreground[0], background[0], alpha),
                blend_channel(foreground[1], background[1], alpha),
                blend_channel(foreground[2], background[2], alpha),
                255,
            ];
            subject.put_pixel(x, y, Rgba(out));
        }
    }
}

fn encode_png(image: &RgbaImage) -> Result<Vec<u8>, FaceCropError> {
    let mut bytes = Vec::new();
    let encoder = PngEncoder::new(&mut bytes);
    encoder
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            image::ExtendedColorType::Rgba8,
        )
        .map_err(|err| FaceCropError::Encode(err.to_string()))?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn crop_rect_keeps_aspect_ratio_and_prefers_headroom() {
        let config = FaceCropperConfig::default();
        let face = FaceBox {
            x1: 420.0,
            y1: 240.0,
            x2: 620.0,
            y2: 500.0,
            confidence: 0.95,
        };

        let rect = compute_crop_rect(1200, 1600, face, &config);

        let ratio = rect.width as f32 / rect.height as f32;
        assert!((ratio - (4.0 / 5.0)).abs() < 0.002);
        let face_width_ratio = face.width() / rect.width as f32;
        assert!(face_width_ratio <= 0.72);
        let face_height_ratio = face.height() / rect.height as f32;
        assert!(face_height_ratio <= 0.72);
        let face_center = face.center_x();
        let crop_center = rect.x as f32 + rect.width as f32 * 0.5;
        assert!((crop_center - face_center).abs() < 1.0);
        let face_center_y = (face.y1 + face.y2) * 0.5;
        let crop_center_y = rect.y as f32 + rect.height as f32 * 0.5;
        assert!(crop_center_y < face_center_y);
        assert!((face_center_y - crop_center_y - face.height() * 0.15).abs() < 1.0);
        assert!(rect.x + rect.width <= 1200);
        assert!(rect.y + rect.height <= 1600);
    }

    #[test]
    fn crop_rect_centers_face_when_source_has_room() {
        let config = FaceCropperConfig::default();
        let face = FaceBox {
            x1: 409.0,
            y1: 272.0,
            x2: 744.0,
            y2: 757.0,
            confidence: 0.99,
        };

        let rect = compute_crop_rect(1024, 932, face, &config);

        let face_center_y = (face.y1 + face.y2) * 0.5;
        let crop_center_y = rect.y as f32 + rect.height as f32 * 0.5;
        assert!(crop_center_y < face_center_y);
        assert!(rect.y > 0);
    }

    #[test]
    fn gradient_uses_requested_endpoints() {
        let image = paint_gradient(2, 3, [10, 20, 30], [110, 120, 130]);

        assert_eq!(image.get_pixel(0, 0).0, [10, 20, 30, 255]);
        assert_eq!(image.get_pixel(1, 2).0, [110, 120, 130, 255]);
    }

    #[test]
    fn watermark_tiles_only_visible_subject_pixels() {
        let config = FaceCropperConfig::default();
        let mut subject = RgbaImage::from_pixel(200, 300, Rgba([10, 20, 30, 255]));
        let mut mask = GrayImage::from_pixel(200, 300, Luma([0]));
        for y in 60..240 {
            for x in 40..160 {
                mask.put_pixel(x, y, Luma([255]));
            }
        }
        let watermark = RgbaImage::from_pixel(40, 20, Rgba([255, 255, 255, 255]));

        overlay_watermark(&mut subject, &mask, &watermark, &config);

        assert_eq!(subject.get_pixel(10, 10).0, [10, 20, 30, 255]);
        assert_ne!(subject.get_pixel(100, 150).0, [10, 20, 30, 255]);
    }

    #[test]
    fn segmenter_presets_expose_expected_model_names() {
        assert_eq!(
            SegmenterPreset::U2NetHumanSeg.model_name(),
            "u2net_human_seg"
        );
        assert_eq!(SegmenterPreset::U2NetP.model_name(), "u2netp");
        assert_eq!(SegmenterPreset::U2NetHumanSeg.default_input_size(), 320);
        assert_eq!(SegmenterPreset::U2NetP.default_input_size(), 320);
    }

    #[test]
    fn ultraface_priors_match_expected_count_for_320x240() {
        let priors = ultraface_priors(320.0, 240.0);
        assert_eq!(priors.len(), 4420);
    }

    #[test]
    fn ultraface_decode_zero_delta_maps_to_prior_box() {
        let prior = [0.5_f32, 0.5, 0.25, 0.4];
        let (x1, y1, x2, y2) = decode_ultraface_box(0.0, 0.0, 0.0, 0.0, prior);

        assert!((x1 - 0.375).abs() < 1e-6);
        assert!((y1 - 0.3).abs() < 1e-6);
        assert!((x2 - 0.625).abs() < 1e-6);
        assert!((y2 - 0.7).abs() < 1e-6);
    }
}
