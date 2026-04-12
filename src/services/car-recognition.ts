import { z } from "zod";
import type { CarDetails } from "../types";
import { DEFAULTS } from "../types";
import type { LicenseLookupService } from "./license-lookup";

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

  constructor(
    geminiApiKey: string,
    botToken: string,
    licenseLookup?: LicenseLookupService,
    model = "gemini-2.5-flash-lite",
  ) {
    this.geminiApiKey = geminiApiKey;
    this.botToken = botToken;
    this.licenseLookup = licenseLookup;
    this.model = model;
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
    const fileInfo = await this.getTelegramFile(fileId);
    if (!fileInfo) return null;

    const imageBuffer = await this.downloadTelegramFile(fileInfo.file_path);
    if (!imageBuffer) return null;

    return this.analyzeCarImage(imageBuffer);
  }

  private async getTelegramFile(fileId: string): Promise<{ file_path: string } | null> {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.botToken}/getFile?file_id=${fileId}`,
      );
      const parsed = TelegramGetFileSchema.safeParse(await res.json());
      if (!parsed.success) {
        console.warn("Telegram getFile: unexpected response shape", parsed.error);
        return null;
      }
      if (!parsed.data.ok) return null;
      return parsed.data.result ?? null;
    } catch (err) {
      console.error("Telegram getFile error:", err);
      return null;
    }
  }

  private async downloadTelegramFile(filePath: string): Promise<Buffer | null> {
    try {
      const url = `https://api.telegram.org/file/bot${this.botToken}/${filePath}`;
      const res = await fetch(url);
      const arrayBuf = await res.arrayBuffer();
      return Buffer.from(arrayBuf);
    } catch (err) {
      console.error("Telegram download error:", err);
      return null;
    }
  }

  /**
   * @internal
   * Visible for testing
   */
  async analyzeCarImage(imageBuffer: Buffer): Promise<CarDetails | null> {
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
        console.warn("Gemini vision: unexpected response shape", geminiParsed.error);
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
        console.error("Gemini vision: empty response", JSON.stringify(data));
        return null;
      }

      const parsed = JSON.parse(text);

      if (parsed.error) {
        console.warn("Car recognition:", parsed.error);
        return null;
      }

      const plateNumber = (parsed.plateNumber || "").replace(/\D/g, "") || "unknown";
      const lookup = this.lookupLicensePlate(plateNumber);

      return {
        plateNumber: lookup ? String(lookup.licensePlateNo) : plateNumber,
        make: lookup?.make || parsed.make || "Unknown",
        model: lookup?.model || parsed.model || "Unknown",
        color: lookup?.color || parsed.color || "Unknown",
        year: lookup?.year ?? this.parseYear(parsed.year),
        seatCount: lookup?.seats ?? DEFAULTS.DEFAULT_SEAT_COUNT,
      };
    } catch (err) {
      console.error("Gemini vision error:", err);
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
