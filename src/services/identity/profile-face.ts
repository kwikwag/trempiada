import sharp from "sharp";
import {
  DetectFacesCommand,
  type DetectFacesCommandInput,
  type FaceDetail,
  type RekognitionClient,
} from "@aws-sdk/client-rekognition";
import type { Logger } from "../../logger";
import { noopLogger } from "../../logger";

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
  ): Promise<ProfilePhotoValidationResult> {
    const faces = await this.detectFaces(imageBuffer);
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
      const crop = await cropFace({
        imageBuffer,
        face,
        outputSize: this.thresholds.outputSize,
        paddingRatio: this.thresholds.cropPaddingRatio,
      });
      return {
        ok: true,
        croppedBuffer: crop,
        mimeType: mimeType === "image/png" ? "image/png" : "image/jpeg",
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

async function cropFace({
  imageBuffer,
  face,
  outputSize,
  paddingRatio,
}: {
  imageBuffer: Buffer;
  face: FaceDetail;
  outputSize: number;
  paddingRatio: number;
}): Promise<Buffer> {
  const image = sharp(imageBuffer, { failOn: "none" });
  const metadata = await image.metadata();
  const width = metadata.width ?? outputSize;
  const height = metadata.height ?? outputSize;
  const box = face.BoundingBox;
  if (
    box?.Left === undefined ||
    box.Top === undefined ||
    box.Width === undefined ||
    box.Height === undefined
  ) {
    throw new Error("Missing face bounding box");
  }

  const faceCenterX = (box.Left + box.Width / 2) * width;
  const faceCenterY = (box.Top + box.Height / 2) * height;
  const squareSize = Math.max(box.Width * width, box.Height * height) * paddingRatio;

  const left = Math.round(clamp(faceCenterX - squareSize / 2, 0, Math.max(0, width - squareSize)));
  const top = Math.round(clamp(faceCenterY - squareSize / 2, 0, Math.max(0, height - squareSize)));
  const extractSize = Math.max(1, Math.min(Math.round(squareSize), width - left, height - top));

  return sharp(imageBuffer, { failOn: "none" })
    .extract({
      left,
      top,
      width: extractSize,
      height: extractSize,
    })
    .resize(outputSize, outputSize, { fit: "cover" })
    .jpeg({ quality: 90 })
    .toBuffer();
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}
