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

export class GeocodingService {
  private baseUrl: string;
  private userAgent: string;

  constructor(
    baseUrl = "https://nominatim.openstreetmap.org",
    userAgent = "TrempBot/1.0",
  ) {
    this.baseUrl = baseUrl;
    this.userAgent = userAgent;
  }

  /** Convert a text address to coordinates. Returns null if not found. */
  async geocode(query: string): Promise<GeocodeResult | null> {
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
      if (!res.ok) return null;

      const results = (await res.json()) as any[];
      if (!results.length) return null;

      const r = results[0];
      return {
        lat: parseFloat(r.lat),
        lng: parseFloat(r.lon),
        label: this.shortenLabel(r.display_name),
      };
    } catch {
      return null;
    }
  }

  /** Convert coordinates to a human-readable label. Returns null on failure. */
  async reverseGeocode(lat: number, lng: number): Promise<string | null> {
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
      if (!res.ok) return null;

      const result = (await res.json()) as any;
      if (!result?.display_name) return null;

      return this.shortenLabel(result.display_name);
    } catch {
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
