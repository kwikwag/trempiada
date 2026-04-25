import sharp from "sharp";
import {
  DetectFacesCommand,
  type DetectFacesCommandInput,
  type FaceDetail,
  type RekognitionClient,
} from "@aws-sdk/client-rekognition";
import type { Logger } from "../../logger";
import { noopLogger } from "../../logger";

export interface CropRegion {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface ProfileFaceServiceOptions {
  rekognition: Pick<RekognitionClient, "send">;
  logger?: Logger;
  thresholds: {
    minSharpness: number;
    minBrightness: number;
    maxYaw: number;
    maxPitch: number;
    maxRoll: number;
    outputSize: number;
    cropPaddingRatio: number;
  };
}

export class ProfileFaceService {
  private readonly rekognition: Pick<RekognitionClient, "send">;
  private readonly logger: Logger;
  private readonly thresholds: ProfileFaceServiceOptions["thresholds"];

  constructor({ rekognition, logger = noopLogger, thresholds }: ProfileFaceServiceOptions) {
    this.rekognition = rekognition;
    this.logger = logger;
    this.thresholds = thresholds;
  }

  async validateAndCropPhoto(
    imageBuffer: Buffer,
    mimeType: string,
    cachedFaces?: FaceDetail[],
  ): Promise<ProfilePhotoValidationResult> {
    const faces = cachedFaces ?? (await this.detectFaces(imageBuffer));
    if (!faces) {
      return invalidPhoto(
        "We couldn't check that photo just now. Please try again in a moment.",
        "detect_failed",
      );
    }

    if (faces.length === 0) {
      return invalidPhoto(
        "I couldn't find a face in that photo. Please send a clear photo of just your face.",
        "no_face",
      );
    }
    if (faces.length > 1) {
      return invalidPhoto(
        "That photo has more than one face. Please send a photo with only your face in frame.",
        "multiple_faces",
      );
    }

    const face = faces[0];
    const rejectionReason = classifyFace(face, this.thresholds);
    if (rejectionReason) {
      return invalidPhoto(rejectionReason.message, rejectionReason.code);
    }

    try {
      const image = sharp(imageBuffer, { failOn: "none" });
      const meta = await image.metadata();
      const imgWidth = meta.width ?? this.thresholds.outputSize;
      const imgHeight = meta.height ?? this.thresholds.outputSize;
      const cropRegion = getFaceCrop({
        face,
        width: imgWidth,
        height: imgHeight,
        paddingRatio: this.thresholds.cropPaddingRatio,
      });
      const outputSize = this.thresholds.outputSize;
      const crop = await applyCrop({
        image: imageBuffer,
        cropRegion,
        outputSize: { width: outputSize, height: outputSize },
      });
      return {
        ok: true,
        croppedBuffer: crop,
        mimeType: mimeType === "image/png" ? "image/png" : "image/jpeg",
        face,
        cropRegion,
      };
    } catch (err) {
      this.logger.error("profile_photo_crop_failed", { err });
      return invalidPhoto(
        "I couldn't prepare that photo. Please try a different one.",
        "crop_failed",
      );
    }
  }

  private async detectFaces(imageBuffer: Buffer): Promise<FaceDetail[] | null> {
    const input: DetectFacesCommandInput = {
      Image: { Bytes: imageBuffer },
      Attributes: ["ALL"],
    };

    try {
      const response = await this.rekognition.send(new DetectFacesCommand(input));
      return response.FaceDetails ?? [];
    } catch (err) {
      this.logger.error("profile_photo_detect_faces_failed", { err });
      return null;
    }
  }
}

export type ProfilePhotoValidationResult =
  | {
      ok: true;
      croppedBuffer: Buffer;
      mimeType: string;
      face: FaceDetail;
      cropRegion: CropRegion;
    }
  | {
      ok: false;
      rejectionCode: ProfilePhotoRejectionCode;
      userMessage: string;
    };

export type ProfilePhotoRejectionCode =
  | "detect_failed"
  | "no_face"
  | "multiple_faces"
  | "occluded"
  | "too_blurry"
  | "too_dark"
  | "bad_pose"
  | "crop_failed";

function invalidPhoto(
  userMessage: string,
  rejectionCode: ProfilePhotoRejectionCode,
): ProfilePhotoValidationResult {
  return { ok: false, userMessage, rejectionCode };
}

function classifyFace(
  face: FaceDetail,
  thresholds: ProfileFaceServiceOptions["thresholds"],
): {
  code: ProfilePhotoRejectionCode;
  message: string;
} | null {
  if (face.FaceOccluded?.Value === true) {
    return {
      code: "occluded",
      message: "Your face is partly hidden there. Please send a clear front-facing photo.",
    };
  }

  if ((face.Quality?.Sharpness ?? 0) < thresholds.minSharpness) {
    return {
      code: "too_blurry",
      message: "That photo looks too blurry. Please send a sharper selfie.",
    };
  }

  if ((face.Quality?.Brightness ?? 0) < thresholds.minBrightness) {
    return {
      code: "too_dark",
      message: "That photo is too dark. Please try again in better light.",
    };
  }

  const yaw = Math.abs(face.Pose?.Yaw ?? 0);
  const pitch = Math.abs(face.Pose?.Pitch ?? 0);
  const roll = Math.abs(face.Pose?.Roll ?? 0);
  if (yaw > thresholds.maxYaw || pitch > thresholds.maxPitch || roll > thresholds.maxRoll) {
    return {
      code: "bad_pose",
      message: "Please send a straight, front-facing photo with your whole face visible.",
    };
  }

  return null;
}

export function getFaceCrop({
  face,
  width,
  height,
  paddingRatio = 0.15,
}: {
  face: FaceDetail;
  width: number;
  height: number;
  paddingRatio?: number;
}): CropRegion {
  const bbox = face.BoundingBox;
  if (!bbox || bbox.Left == null || bbox.Top == null || bbox.Width == null || bbox.Height == null) {
    throw new Error("FaceDetail is missing a complete BoundingBox");
  }

  // Estimate where the top of the hair is.
  //
  // Rekognition's BoundingBox.Top sits roughly at the brow/forehead, not the
  // hairline. We use landmarks to measure the face's internal scale (eye line
  // to chin) and extrapolate upward by a similar amount to cover typical hair.
  //
  // If landmarks are unavailable, we fall back to extending the bbox top by a
  // fraction of the bbox height.
  let hairTop = bbox.Top - bbox.Height * 0.25;

  const landmarks = new Map((face.Landmarks ?? []).map((l) => [l.Type, l]));

  const eyeLeft = landmarks.get("eyeLeft");
  const eyeRight = landmarks.get("eyeRight");
  const chinBottom = landmarks.get("chinBottom");

  if (eyeLeft?.Y != null && eyeRight?.Y != null && chinBottom?.Y != null) {
    const eyeLineY = (eyeLeft.Y + eyeRight.Y) / 2;
    const eyeToChin = chinBottom.Y - eyeLineY;
    if (eyeToChin > 0) {
      // Hair above the brow is typically a bit more than the brow-to-chin
      // distance for full hairstyles; 1.1x is a safe default.
      hairTop = Math.min(hairTop, eyeLineY - eyeToChin * 1.1);
    }
  }
  if (hairTop > bbox.Top) {
    hairTop = bbox.Top;
  }

  const headHeight = bbox.Height + (bbox.Top - hairTop);

  const cx = (bbox.Left + bbox.Width / 2) * width;
  const cy = (hairTop + headHeight / 2) * height;
  const ww = bbox.Width * width;
  const hh = headHeight * height;
  const size = Math.max(ww, hh) * (1 + 2 * paddingRatio);

  const crop: CropRegion = {
    left: Math.round(cx - size / 2),
    top: Math.round(cy - size / 2),
    width: Math.round(size),
    height: Math.round(size),
  };

  return crop;
}

export async function applyCrop({
  image,
  cropRegion,
  outputSize,
  quality = 90,
}: {
  image: Buffer;
  cropRegion: CropRegion;
  outputSize: Size;
  quality?: number;
}): Promise<Buffer> {
  const { left, top, width, height } = cropRegion;

  if (width <= 0 || height <= 0) {
    throw new Error(
      `Invalid crop region: width and height must be positive (got ${width}x${height})`,
    );
  }

  // Apply EXIF rotation up front so width/height reflect the visual orientation.
  const rotated = await sharp(image).rotate().toBuffer();
  const { width: srcWidth, height: srcHeight } = await sharp(rotated).metadata();
  if (srcWidth == null || srcHeight == null) {
    throw new Error("Could not determine source image dimensions");
  }

  // Compute the in-bounds intersection of the crop region with the source.
  const interLeft = Math.max(left, 0);
  const interTop = Math.max(top, 0);
  const interRight = Math.min(left + width, srcWidth);
  const interBottom = Math.min(top + height, srcHeight);

  const interWidth = interRight - interLeft;
  const interHeight = interBottom - interTop;

  let canvasBuffer: Buffer;

  if (interWidth <= 0 || interHeight <= 0) {
    // Crop region lies entirely outside the source — just a black rectangle.
    canvasBuffer = await sharp({
      create: {
        width,
        height,
        channels: 3,
        background: { r: 0, g: 0, b: 0 },
      },
    })
      .png()
      .toBuffer();
  } else {
    // Extract the in-bounds portion, then extend it with black on each side
    // to fill the requested crop region.
    const padLeft = interLeft - left;
    const padTop = interTop - top;
    const padRight = width - interWidth - padLeft;
    const padBottom = height - interHeight - padTop;

    canvasBuffer = await sharp(rotated)
      .extract({
        left: interLeft,
        top: interTop,
        width: interWidth,
        height: interHeight,
      })
      .extend({
        top: padTop,
        bottom: padBottom,
        left: padLeft,
        right: padRight,
        background: { r: 0, g: 0, b: 0 },
      })
      .toBuffer();
  }

  return sharp(canvasBuffer)
    .resize(outputSize.width, outputSize.height, { fit: "fill" })
    .jpeg({ quality })
    .toBuffer();
}
