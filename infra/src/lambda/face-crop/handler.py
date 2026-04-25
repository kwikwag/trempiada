"""
face-crop Lambda

POST /  — accepts either:
  • raw JPEG/PNG body  (API GW proxy with isBase64Encoded=true)
  • JSON body          {"image": "<base64>"}

Returns 200 image/jpeg (isBase64Encoded=true) or JSON error.

Steps:
  1. Detect faces via Rekognition — reject unless exactly one.
  2. Run u2net_human_seg ONNX model to produce a human-mask.
  3. Crop a square portrait centered on the face.
  4. Composite the cropped foreground over a vertical gradient background.
  5. Stamp a watermark and return JPEG.
"""

import base64
import io
import json
import os

import boto3
import numpy as np
import onnxruntime as ort
from PIL import Image, ImageDraw, ImageFilter, ImageFont, ImageOps

# ── constants ────────────────────────────────────────────────────────────────

OUTPUT_SIZE = 600          # square output (px)
MODEL_INPUT_SIZE = 320
MODEL_PATH = os.path.join(os.path.dirname(__file__), "u2net_human_seg.onnx")

GRADIENT_TOP = (0xB1, 0x5B, 0x86)
GRADIENT_BOTTOM = (0x44, 0x0F, 0x50)
WATERMARK_TEXT = "Trempiada"

# Face (forehead→chin) as a fraction of the output portrait height.
# This sets how prominent the face appears.
FACE_V_FRACTION = 0.45
# Fraction of face-height to add above the Rekognition bounding box for hair.
HAIR_HEADROOM = 0.20

# Rekognition Bytes limit (5 MB); we pre-shrink to stay safe.
REK_MAX_BYTES = 4 * 1024 * 1024

# ── module-level init (cold-start once) ──────────────────────────────────────

_ort_session: ort.InferenceSession | None = None
_rekognition = boto3.client("rekognition")


def _ort() -> ort.InferenceSession:
    global _ort_session
    if _ort_session is None:
        _ort_session = ort.InferenceSession(
            MODEL_PATH, providers=["CPUExecutionProvider"]
        )
    return _ort_session


# ── image helpers ─────────────────────────────────────────────────────────────


def _make_gradient(width: int, height: int) -> Image.Image:
    t = np.linspace(0, 1, height, dtype=np.float32)[:, np.newaxis, np.newaxis]
    top = np.array(GRADIENT_TOP, dtype=np.float32)
    bot = np.array(GRADIENT_BOTTOM, dtype=np.float32)
    arr = (top * (1 - t) + bot * t).astype(np.uint8)
    arr = np.broadcast_to(arr, (height, width, 3)).copy()
    return Image.fromarray(arr, "RGB")


def _add_watermark(image: Image.Image, text: str) -> Image.Image:
    out = image.copy().convert("RGBA")
    overlay = Image.new("RGBA", out.size, (0, 0, 0, 0))
    draw = ImageDraw.Draw(overlay)
    font_size = max(14, out.width // 22)
    font: ImageFont.FreeTypeFont | ImageFont.ImageFont
    for path in (
        "/usr/share/fonts/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    ):
        try:
            font = ImageFont.truetype(path, font_size)
            break
        except OSError:
            pass
    else:
        font = ImageFont.load_default()

    bbox = draw.textbbox((0, 0), text, font=font)
    tw, th = bbox[2] - bbox[0], bbox[3] - bbox[1]
    margin = max(8, out.width // 40)
    x, y = out.width - tw - margin, out.height - th - margin
    draw.text((x + 1, y + 1), text, font=font, fill=(0, 0, 0, 110))
    draw.text((x, y), text, font=font, fill=(255, 255, 255, 170))
    return Image.alpha_composite(out, overlay).convert("RGB")


# ── segmentation ──────────────────────────────────────────────────────────────

_MEAN = np.array([0.485, 0.456, 0.406], dtype=np.float32)
_STD = np.array([0.229, 0.224, 0.225], dtype=np.float32)


def _segment(image: Image.Image) -> np.ndarray:
    """
    Returns a float32 alpha mask in [0, 1] at the same size as *image*.
    Uses min-max normalisation on the raw model output, matching rembg's
    inference approach (works regardless of whether sigmoid is baked in).
    """
    orig_w, orig_h = image.size
    inp = image.convert("RGB").resize(
        (MODEL_INPUT_SIZE, MODEL_INPUT_SIZE), Image.BILINEAR
    )
    arr = (np.array(inp, dtype=np.float32) / 255.0 - _MEAN) / _STD
    arr = arr.transpose(2, 0, 1)[np.newaxis]  # (1, 3, H, W)

    session = _ort()
    pred = session.run(None, {session.get_inputs()[0].name: arr})[0][0, 0]

    mn, mx = pred.min(), pred.max()
    pred = (pred - mn) / (mx - mn) if mx > mn else np.ones_like(pred)

    mask = (
        Image.fromarray((pred * 255).astype(np.uint8))
        .resize((orig_w, orig_h), Image.BILINEAR)
        .filter(ImageFilter.GaussianBlur(radius=2))
    )
    return np.array(mask, dtype=np.float32) / 255.0


# ── crop & composite ──────────────────────────────────────────────────────────


def _crop_region(
    face_bbox: dict, img_w: int, img_h: int
) -> tuple[int, int, int, int]:
    """
    Compute (left, top, right, bottom) pixel crop such that the face occupies
    FACE_V_FRACTION of OUTPUT_SIZE height, with hair headroom above the bbox.
    """
    fb = face_bbox["BoundingBox"]
    fl = fb["Left"] * img_w
    ft = fb["Top"] * img_h
    fw = fb["Width"] * img_w
    fh = fb["Height"] * img_h

    side = fh / FACE_V_FRACTION          # square side length
    cx = fl + fw / 2
    top = ft - fh * HAIR_HEADROOM         # push up a bit for hair

    left = cx - side / 2
    return (int(left), int(top), int(left + side), int(top + side))


def _extract_and_composite(
    image: Image.Image,
    mask: np.ndarray,
    crop: tuple[int, int, int, int],
) -> Image.Image:
    """
    Crop image & mask (padding with zeros where out-of-bounds), resize to
    OUTPUT_SIZE, and composite foreground over gradient background.
    """
    l, t, r, b = crop
    cw, ch = r - l, b - t
    iw, ih = image.size

    canvas = Image.new("RGB", (cw, ch), (0, 0, 0))
    mask_canvas = np.zeros((ch, cw), dtype=np.float32)

    il, it = max(l, 0), max(t, 0)
    ir, ib = min(r, iw), min(b, ih)

    if il < ir and it < ib:
        canvas.paste(image.crop((il, it, ir, ib)), (il - l, it - t))
        mask_canvas[it - t : ib - t, il - l : ir - l] = mask[it:ib, il:ir]

    size = OUTPUT_SIZE
    fg = canvas.resize((size, size), Image.LANCZOS)
    alpha = (
        Image.fromarray((mask_canvas * 255).astype(np.uint8))
        .resize((size, size), Image.BILINEAR)
    )

    bg = _make_gradient(size, size)
    bg.paste(fg, (0, 0), alpha)
    return bg


# ── Rekognition helper ────────────────────────────────────────────────────────


def _shrink_for_rekognition(image_bytes: bytes) -> bytes:
    """Downscale iteratively until the image fits the Rekognition bytes limit."""
    if len(image_bytes) <= REK_MAX_BYTES:
        return image_bytes
    img = Image.open(io.BytesIO(image_bytes)).convert("RGB")
    scale = 0.7
    while True:
        tmp = img.resize(
            (int(img.width * scale), int(img.height * scale)), Image.LANCZOS
        )
        buf = io.BytesIO()
        tmp.save(buf, format="JPEG", quality=85)
        data = buf.getvalue()
        if len(data) <= REK_MAX_BYTES:
            return data
        scale *= 0.7


# ── Lambda entry point ────────────────────────────────────────────────────────


def handler(event: dict, context: object) -> dict:
    # ── parse input ──────────────────────────────────────────────────────────
    try:
        if event.get("isBase64Encoded"):
            image_bytes = base64.b64decode(event.get("body", ""))
        else:
            body = event.get("body") or "{}"
            payload = json.loads(body) if isinstance(body, str) else body
            image_bytes = base64.b64decode(payload["image"])
    except Exception as exc:
        return _err(400, "invalid_request", str(exc))

    # ── 1. face detection ─────────────────────────────────────────────────────
    try:
        rek_bytes = _shrink_for_rekognition(image_bytes)
        resp = _rekognition.detect_faces(
            Image={"Bytes": rek_bytes}, Attributes=["DEFAULT"]
        )
        faces = resp["FaceDetails"]
    except Exception as exc:
        return _err(502, "face_detection_failed", str(exc))

    if not faces:
        return _err(422, "no_face", "No face detected in the image.")
    if len(faces) > 1:
        return _err(422, "multiple_faces", f"Found {len(faces)} faces; expected exactly 1.")

    # ── 2. load & orient image ────────────────────────────────────────────────
    try:
        image = ImageOps.exif_transpose(
            Image.open(io.BytesIO(image_bytes)).convert("RGB")
        )
    except Exception as exc:
        return _err(400, "invalid_image", str(exc))

    # ── 3. segment ────────────────────────────────────────────────────────────
    mask = _segment(image)

    # ── 4. crop + composite ───────────────────────────────────────────────────
    crop = _crop_region(faces[0], *image.size)
    result = _extract_and_composite(image, mask, crop)

    # ── 5. watermark ──────────────────────────────────────────────────────────
    result = _add_watermark(result, WATERMARK_TEXT)

    # ── 6. encode & return ────────────────────────────────────────────────────
    buf = io.BytesIO()
    result.save(buf, format="JPEG", quality=88, optimize=True)
    return {
        "statusCode": 200,
        "headers": {"content-type": "image/jpeg"},
        "isBase64Encoded": True,
        "body": base64.b64encode(buf.getvalue()).decode(),
    }


def _err(status: int, code: str, detail: str) -> dict:
    return {
        "statusCode": status,
        "headers": {"content-type": "application/json"},
        "body": json.dumps({"error": code, "detail": detail}),
    }
