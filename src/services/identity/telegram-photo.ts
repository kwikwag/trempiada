import { z } from "zod";
import type { Logger } from "../../logger";
import { noopLogger } from "../../logger";

const TelegramGetFileSchema = z.object({
  ok: z.boolean(),
  result: z.object({ file_path: z.string() }).optional(),
});

export interface TelegramPhotoServiceOptions {
  botToken: string;
  logger?: Logger;
}

export class TelegramPhotoService {
  private readonly botToken: string;
  private readonly logger: Logger;

  constructor({ botToken, logger = noopLogger }: TelegramPhotoServiceOptions) {
    this.botToken = botToken;
    this.logger = logger;
  }

  async downloadByFileId(fileId: string): Promise<TelegramDownloadedPhoto | null> {
    const file = await this.getFile(fileId);
    if (!file) return null;
    const buffer = await this.downloadFile(file.file_path);
    if (!buffer) return null;
    return {
      filePath: file.file_path,
      mimeType: detectImageType(buffer),
      buffer,
    };
  }

  private async getFile(fileId: string): Promise<{ file_path: string } | null> {
    try {
      const response = await fetch(
        `https://api.telegram.org/bot${this.botToken}/getFile?file_id=${fileId}`,
      );
      const parsed = TelegramGetFileSchema.safeParse(await response.json());
      if (!parsed.success || !parsed.data.ok) {
        this.logger.warn("telegram_profile_get_file_failed");
        return null;
      }
      return parsed.data.result ?? null;
    } catch (err) {
      this.logger.error("telegram_profile_get_file_error", { err });
      return null;
    }
  }

  private async downloadFile(filePath: string): Promise<Buffer | null> {
    try {
      const response = await fetch(`https://api.telegram.org/file/bot${this.botToken}/${filePath}`);
      const data = await response.arrayBuffer();
      return Buffer.from(data);
    } catch (err) {
      this.logger.error("telegram_profile_photo_download_error", { err });
      return null;
    }
  }
}

export interface TelegramDownloadedPhoto {
  filePath: string;
  mimeType: string;
  buffer: Buffer;
}

export function detectImageType(buffer: Buffer): string {
  if (buffer[0] === 0xff && buffer[1] === 0xd8) return "image/jpeg";
  if (buffer[0] === 0x89 && buffer[1] === 0x50) return "image/png";
  if (buffer[0] === 0x52 && buffer[1] === 0x49) return "image/webp";
  return "image/jpeg";
}
