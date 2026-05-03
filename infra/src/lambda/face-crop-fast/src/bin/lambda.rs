use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use aws_config::BehaviorVersion;
use aws_sdk_s3::Client as S3Client;
use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use face_crop_fast::{FaceCropRequest, FaceCropper, FaceCropperConfig, SegmenterPreset};
use lambda_runtime::{service_fn, Error as LambdaError, LambdaEvent};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

const ULTRAFACE_MODEL_PATH: &str = "/var/task/models/ultraface-rfb-320.onnx";
const U2NET_MODEL_PATH: &str = "/var/task/models/u2netp.onnx";
const JPEG_OUTPUT_QUALITY: u8 = 60;

#[derive(Deserialize)]
struct S3Loc {
    bucket: String,
    key: String,
}

#[derive(Deserialize)]
struct Event {
    image_base64: Option<String>,
    image_s3: Option<S3Loc>,
    watermark_s3: S3Loc,
}

#[derive(Serialize)]
struct Response {
    image_base64: String,
}

struct State {
    cropper: FaceCropper,
    s3: S3Client,
    watermark_cache: Mutex<HashMap<String, Vec<u8>>>,
}

async fn fetch_s3(s3: &S3Client, bucket: &str, key: &str) -> Result<Vec<u8>, LambdaError> {
    let output = s3.get_object().bucket(bucket).key(key).send().await?;
    let bytes = output.body.collect().await?.into_bytes().into();
    Ok(bytes)
}

async fn handle(event: LambdaEvent<Event>, state: Arc<State>) -> Result<Response, LambdaError> {
    let ev = event.payload;

    // Load watermark, cached by bucket+key across warm invocations
    let wm_cache_key = format!("{}/{}", ev.watermark_s3.bucket, ev.watermark_s3.key);
    let watermark = {
        let cache = state.watermark_cache.lock().await;
        cache.get(&wm_cache_key).cloned()
    };
    let watermark = match watermark {
        Some(b) => b,
        None => {
            let b = fetch_s3(&state.s3, &ev.watermark_s3.bucket, &ev.watermark_s3.key).await?;
            state
                .watermark_cache
                .lock()
                .await
                .insert(wm_cache_key, b.clone());
            b
        }
    };

    // Load image
    let image_bytes: Vec<u8> = match (ev.image_base64, ev.image_s3) {
        (Some(b64), _) => BASE64.decode(b64)?,
        (None, Some(loc)) => fetch_s3(&state.s3, &loc.bucket, &loc.key).await?,
        (None, None) => return Err("either image_base64 or image_s3 must be provided".into()),
    };

    // Run ML inference on the blocking thread pool to avoid stalling the async runtime
    let state_clone = Arc::clone(&state);
    let result = tokio::task::spawn_blocking(move || {
        state_clone.cropper.process(FaceCropRequest {
            image_bytes: &image_bytes,
            watermark_png_bytes: Some(&watermark),
        })
    })
    .await??;

    let jpeg = png_to_jpeg(&result.png_bytes, JPEG_OUTPUT_QUALITY)?;

    Ok(Response {
        image_base64: BASE64.encode(jpeg),
    })
}

fn png_to_jpeg(png_bytes: &[u8], quality: u8) -> Result<Vec<u8>, LambdaError> {
    use image::codecs::jpeg::JpegEncoder;
    let img = image::load_from_memory(png_bytes)?.to_rgb8();
    let mut buf = Vec::new();
    JpegEncoder::new_with_quality(&mut buf, quality).encode_image(&img)?;
    Ok(buf)
}

#[tokio::main]
async fn main() -> Result<(), LambdaError> {
    let config = aws_config::load_defaults(BehaviorVersion::latest()).await;
    let s3 = S3Client::new(&config);

    let cropper = FaceCropper::new_with_segmenter_preset(
        Path::new(ULTRAFACE_MODEL_PATH),
        Path::new(U2NET_MODEL_PATH),
        SegmenterPreset::U2NetP,
        FaceCropperConfig::default(),
    )?;

    // Pre-warm the watermark cache if the location is known at init time.
    let mut watermark_cache = HashMap::new();
    if let (Ok(bucket), Ok(key)) = (
        std::env::var("WATERMARK_BUCKET"),
        std::env::var("WATERMARK_KEY"),
    ) {
        let data = fetch_s3(&s3, &bucket, &key).await?;
        watermark_cache.insert(format!("{bucket}/{key}"), data);
    }

    let state = Arc::new(State {
        cropper,
        s3,
        watermark_cache: Mutex::new(watermark_cache),
    });

    lambda_runtime::run(service_fn(|event| {
        let state = Arc::clone(&state);
        async move { handle(event, state).await }
    }))
    .await
}
