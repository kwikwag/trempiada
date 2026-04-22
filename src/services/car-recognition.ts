import { z } from "zod";
import type { CarDetails } from "../types";
import { DEFAULTS } from "../types";
import type { LicenseLookupService } from "./license-lookup";
import type { Logger } from "../logger";
import { noopLogger } from "../logger";

const TelegramGetFileSchema = z.object({
  ok: z.boolean(),
  result: z.object({ file_path: z.string() }).optional(),
});

const GeminiPartSchema = z.object({
  thought: z.boolean().optional(),
  text: z.string().optional(),
});

const GeminiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({
          parts: z.array(GeminiPartSchema),
        }),
      }),
    )
    .optional(),
});

/**
 * Extract car details from a photo of the rear of a vehicle.
 * Uses Google Gemini vision to read the license plate and identify the car.
 *
 * Flow:
 * 1. User sends photo → Telegram gives us a file_id
 * 2. We download the photo from Telegram's servers
 * 3. Send to Gemini vision to extract plate + car details
 * 4. Cross-reference plate with the local Israeli license database
 */
export class CarRecognitionService {
  private geminiApiKey: string;
  private botToken: string;
  private model: string;
  private licenseLookup?: LicenseLookupService;
  private logger: Logger;

  constructor({
    geminiApiKey,
    botToken,
    licenseLookup,
    model = "gemini-2.5-flash-lite",
    logger = noopLogger,
  }: CarRecognitionServiceOptions) {
    this.geminiApiKey = geminiApiKey;
    this.botToken = botToken;
    this.licenseLookup = licenseLookup;
    this.model = model;
    this.logger = logger;
  }

  /** Build the thinkingConfig for the model generation.
   *  - gemini-2.x: thinkingBudget: 0  (disable thinking)
   *  - gemini-3.x: thinkingLevel: "minimal"
   * @internal
   * Visible for testing
   */
  thinkingConfig(): object {
    if (/^gemini-2\b/.test(this.model)) return { thinkingBudget: 0 };
    if (/^gemini-3\b/.test(this.model)) return { thinkingLevel: "minimal" };
    return {};
  }

  /**
   * Download a photo from Telegram and extract car details.
   */
  async extractFromTelegramPhoto(fileId: string): Promise<CarDetails | null> {
    const start = Date.now();
    this.logger.info("car_recognition_started", { model: this.model });
    const fileInfo = await this.getTelegramFile(fileId);
    if (!fileInfo) {
      this.logger.warn("car_recognition_file_lookup_failed", { durationMs: Date.now() - start });
      return null;
    }

    const imageBuffer = await this.downloadTelegramFile(fileInfo.file_path);
    if (!imageBuffer) {
      this.logger.warn("car_recognition_photo_download_failed", {
        durationMs: Date.now() - start,
      });
      return null;
    }

    const result = await this.analyzeCarImage(imageBuffer);
    this.logger.info(result ? "car_recognition_completed" : "car_recognition_no_result", {
      durationMs: Date.now() - start,
      model: this.model,
    });
    return result;
  }

  private async getTelegramFile(fileId: string): Promise<{ file_path: string } | null> {
    const start = Date.now();
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.botToken}/getFile?file_id=${fileId}`,
      );
      const parsed = TelegramGetFileSchema.safeParse(await res.json());
      if (!parsed.success) {
        this.logger.warn("telegram_get_file_response_invalid", {
          durationMs: Date.now() - start,
          err: parsed.error,
        });
        return null;
      }
      if (!parsed.data.ok) {
        this.logger.warn("telegram_get_file_not_ok", { durationMs: Date.now() - start });
        return null;
      }
      this.logger.debug("telegram_get_file_completed", { durationMs: Date.now() - start });
      return parsed.data.result ?? null;
    } catch (err) {
      this.logger.error("telegram_get_file_failed", {
        durationMs: Date.now() - start,
        err,
      });
      return null;
    }
  }

  private async downloadTelegramFile(filePath: string): Promise<Buffer | null> {
    const start = Date.now();
    try {
      const url = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
      const res = await fetch(url);
      const arrayBuf = await res.arrayBuffer();
      const buffer = Buffer.from(arrayBuf);
      this.logger.debug("telegram_photo_downloaded", {
        durationMs: Date.now() - start,
        bytes: buffer.byteLength,
      });
      return buffer;
    } catch (err) {
      this.logger.error("telegram_photo_download_failed", {
        durationMs: Date.now() - start,
        err,
      });
      return null;
    }
  }

  /**
   * @internal
   * Visible for testing
   */
  async analyzeCarImage(imageBuffer: Buffer): Promise<CarDetails | null> {
    const start = Date.now();
    const base64 = imageBuffer.toString("base64");
    const mimeType = this.detectImageType(imageBuffer);

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent?key=${this.geminiApiKey}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                {
                  inlineData: { mimeType, data: base64 },
                },
                {
                  text: `Analyze this photo of a car (likely the rear view) and extract the requested fields.
License plate digits only, no hyphens or spaces. Estimate the year from model/style if not explicitly visible.
If this is not a car photo, set the error field to "not_a_car".`,
                },
              ],
            },
          ],
          generationConfig: {
            maxOutputTokens: 1024,
            thinkingConfig: this.thinkingConfig(),
            responseMimeType: "application/json",
            responseJsonSchema: {
              type: "object",
              properties: {
                plateNumber: {
                  type: "string",
                  description: "License plate digits only, e.g. 12345678",
                },
                make: { type: "string", description: "Car manufacturer" },
                model: { type: "string", description: "Car model name" },
                color: { type: "string", description: "Car color" },
                year: { type: "integer", description: "Model year" },
                error: { type: "string", description: "Set to 'not_a_car' if image has no car" },
              },
            },
          },
        }),
      });

      const geminiParsed = GeminiResponseSchema.safeParse(await res.json());
      if (!geminiParsed.success) {
        this.logger.warn("gemini_vision_response_invalid", {
          durationMs: Date.now() - start,
          model: this.model,
          err: geminiParsed.error,
        });
        return null;
      }
      const data = geminiParsed.data;
      // Thinking models (e.g. gemini-2.5-flash) prepend thought parts and may
      // split the response across several content parts; join non-thought parts.
      const parts = data.candidates?.[0]?.content?.parts ?? [];
      const text = parts
        .filter((p) => !p.thought)
        .map((p) => p.text ?? "")
        .join("");
      if (!text) {
        this.logger.error("gemini_vision_empty_response", {
          durationMs: Date.now() - start,
          model: this.model,
          candidateCount: data.candidates?.length ?? 0,
        });
        return null;
      }

      const parsed = JSON.parse(text);

      if (parsed.error) {
        this.logger.warn("car_recognition_model_rejected_image", {
          durationMs: Date.now() - start,
          model: this.model,
          reason: parsed.error,
        });
        return null;
      }

      const plateNumber = (parsed.plateNumber || "").replace(/\D/g, "") || "unknown";
      const lookup = this.lookupLicensePlate(plateNumber);
      this.logger.debug(lookup ? "license_lookup_hit" : "license_lookup_miss", {
        durationMs: Date.now() - start,
      });

      return {
        plateNumber: lookup ? String(lookup.licensePlateNo) : plateNumber,
        make: lookup?.make || parsed.make || "Unknown",
        model: lookup?.model || parsed.model || "Unknown",
        color: lookup?.color || parsed.color || "Unknown",
        year: lookup?.year ?? this.parseYear(parsed.year),
        seatCount: lookup?.seats ?? DEFAULTS.DEFAULT_SEAT_COUNT,
      };
    } catch (err) {
      this.logger.error("gemini_vision_failed", {
        durationMs: Date.now() - start,
        model: this.model,
        err,
      });
      return null;
    }
  }

  private lookupLicensePlate(plateNumber: string) {
    if (!this.licenseLookup) return null;

    try {
      return this.licenseLookup.getByLicensePlateNumber(plateNumber);
    } catch {
      return null;
    }
  }

  private parseYear(year: unknown): number | null {
    if (typeof year === "number" && Number.isInteger(year)) return year;
    if (typeof year === "string" && /^\d{4}$/.test(year)) return Number(year);
    return null;
  }

  /**
   * @internal
   * Visible for testing
   */
  detectImageType(buffer: Buffer): string {
    if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
    if (buffer[0] === 0x52 && buffer[1] === 0x49) return "image/webp";
    return "image/jpeg";
  }
}

export interface CarRecognitionServiceOptions {
  geminiApiKey: string;
  botToken: string;
  licenseLookup?: LicenseLookupService;
  model?: string;
  logger?: Logger;
}
