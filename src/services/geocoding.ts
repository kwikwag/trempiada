import { z } from "zod";
import type { Logger } from "../logger";
import { noopLogger } from "../logger";

/**
 * Geocoding service using Nominatim (OpenStreetMap).
 * Converts text addresses to coordinates and vice versa.
 * Biased toward Israel results.
 */
export interface GeocodeResult {
  lat: number;
  lng: number;
  label: string;
}

const NominatimResultSchema = z.object({
  lat: z.string(),
  lon: z.string(),
  display_name: z.string(),
});

export class GeocodingService {
  private baseUrl: string;
  private userAgent: string;

  constructor(
    baseUrl = "https://nominatim.openstreetmap.org",
    userAgent = "TrempiadaBot/1.0",
    private logger: Logger = noopLogger,
  ) {
    this.baseUrl = baseUrl;
    this.userAgent = userAgent;
  }

  /** Convert a text address to coordinates. Returns null if not found. */
  async geocode(query: string): Promise<GeocodeResult | null> {
    const start = Date.now();
    const params = new URLSearchParams({
      q: query,
      format: "json",
      limit: "1",
      countrycodes: "il",
      addressdetails: "0",
    });

    try {
      const res = await fetch(`${this.baseUrl}/search?${params}`, {
        headers: { "User-Agent": this.userAgent },
      });
      if (!res.ok) {
        this.logger.warn("geocode_http_failed", {
          durationMs: Date.now() - start,
          status: res.status,
          queryLength: query.length,
        });
        return null;
      }

      const parsed = z.array(NominatimResultSchema).safeParse(await res.json());
      if (!parsed.success) {
        this.logger.warn("geocode_response_invalid", {
          durationMs: Date.now() - start,
          queryLength: query.length,
          err: parsed.error,
        });
        return null;
      }
      if (!parsed.data.length) {
        this.logger.info("geocode_no_results", {
          durationMs: Date.now() - start,
          queryLength: query.length,
        });
        return null;
      }

      const r = parsed.data[0];
      this.logger.debug("geocode_completed", {
        durationMs: Date.now() - start,
        queryLength: query.length,
      });
      return {
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
        label: this.shortenLabel(r.display_name),
      };
    } catch (err) {
      this.logger.warn("geocode_failed", {
        durationMs: Date.now() - start,
        queryLength: query.length,
        err,
      });
      return null;
    }
  }

  /** Convert coordinates to a human-readable label. Returns null on failure. */
  async reverseGeocode(lat: number, lng: number): Promise<string | null> {
    const start = Date.now();
    const params = new URLSearchParams({
      lat: String(lat),
      lon: String(lng),
      format: "json",
      zoom: "14",
    });

    try {
      const res = await fetch(`${this.baseUrl}/reverse?${params}`, {
        headers: { "User-Agent": this.userAgent },
      });
      if (!res.ok) {
        this.logger.warn("reverse_geocode_http_failed", {
          durationMs: Date.now() - start,
          status: res.status,
        });
        return null;
      }

      const parsed = NominatimResultSchema.safeParse(await res.json());
      if (!parsed.success) {
        this.logger.warn("reverse_geocode_response_invalid", {
          durationMs: Date.now() - start,
          err: parsed.error,
        });
        return null;
      }

      this.logger.debug("reverse_geocode_completed", { durationMs: Date.now() - start });
      return this.shortenLabel(parsed.data.display_name);
    } catch (err) {
      this.logger.warn("reverse_geocode_failed", {
        durationMs: Date.now() - start,
        err,
      });
      return null;
    }
  }

  /**
   * Trim Nominatim's verbose display_name to the first 2-3 meaningful parts.
   * e.g. "Dizengoff Street, Tel Aviv-Yafo, Tel Aviv District, Israel" → "Dizengoff Street, Tel Aviv-Yafo"
   */
  private shortenLabel(displayName: string): string {
    const parts = displayName.split(", ");
    return parts.slice(0, 3).join(", ");
  }
}
