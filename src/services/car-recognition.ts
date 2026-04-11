import type { CarDetails } from "../types";
import { DEFAULTS } from "../types";

/**
 * Extract car details from a photo of the rear of a vehicle.
 * Uses Claude's vision API to read the license plate and identify
 * the car, then optionally cross-references with Israel's vehicle DB.
 *
 * Flow:
 * 1. User sends photo → Telegram gives us a file_id
 * 2. We download the photo from Telegram's servers
 * 3. Send to Claude vision to extract plate + car details
 * 4. (Future) Cross-reference plate with Israeli MOT database API
 */
export class CarRecognitionService {
  private anthropicApiKey: string;
  private botToken: string;

  constructor(anthropicApiKey: string, botToken: string) {
    this.anthropicApiKey = anthropicApiKey;
    this.botToken = botToken;
  }

  /**
   * Download a photo from Telegram and extract car details.
   */
  async extractFromTelegramPhoto(fileId: string): Promise<CarDetails | null> {
    // Step 1: Get file path from Telegram
    const fileInfo = await this.getTelegramFile(fileId);
    if (!fileInfo) return null;

    // Step 2: Download the image
    const imageBuffer = await this.downloadTelegramFile(fileInfo.file_path);
    if (!imageBuffer) return null;

    // Step 3: Send to Claude for analysis
    return this.analyzeCarImage(imageBuffer);
  }

  private async getTelegramFile(fileId: string): Promise<{ file_path: string } | null> {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${this.botToken}/getFile?file_id=${fileId}`
      );
      const data = (await res.json()) as any;
      if (!data.ok) return null;
      return data.result;
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

  private async analyzeCarImage(imageBuffer: Buffer): Promise<CarDetails | null> {
    const base64 = imageBuffer.toString("base64");

    // Detect media type from buffer magic bytes
    const mediaType = this.detectImageType(imageBuffer);

    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": this.anthropicApiKey,
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: "claude-sonnet-4-20250514",
          max_tokens: 500,
          messages: [
            {
              role: "user",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    media_type: mediaType,
                    data: base64,
                  },
                },
                {
                  type: "text",
                  text: `Analyze this photo of a car (likely the rear view). Extract:
1. License plate number (Israeli format: XX-XXX-XX or similar)
2. Car make (manufacturer)
3. Car model
4. Color

Respond ONLY with a JSON object, no markdown, no backticks:
{"plateNumber": "...", "make": "...", "model": "...", "color": "...", "year": null}

If you can estimate the year from the model, include it. If you can't read the plate clearly, use your best guess and note uncertainty. If this doesn't appear to be a car photo, respond with: {"error": "not_a_car"}`,
                },
              ],
            },
          ],
        }),
      });

      const data = (await res.json()) as any;
      const text = data.content?.[0]?.text;
      if (!text) return null;

      const parsed = JSON.parse(text.replace(/```json|```/g, "").trim());

      if (parsed.error) {
        console.warn("Car recognition:", parsed.error);
        return null;
      }

      return {
        plateNumber: parsed.plateNumber || "unknown",
        make: parsed.make || "Unknown",
        model: parsed.model || "Unknown",
        color: parsed.color || "Unknown",
        year: parsed.year || null,
        seatCount: DEFAULTS.DEFAULT_SEAT_COUNT,
      };
    } catch (err) {
      console.error("Claude vision error:", err);
      return null;
    }
  }

  private detectImageType(buffer: Buffer): string {
    if (buffer[0] === 0xFF && buffer[1] === 0xD8) return "image/jpeg";
    if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
    if (buffer[0] === 0x52 && buffer[1] === 0x49) return "image/webp";
    return "image/jpeg"; // fallback
  }
}
