import { z } from "zod";

export interface WazeDriveInfo {
  originLat: number;
  originLng: number;
  originLabel: string;
  destLat: number;
  destLng: number;
  destLabel: string;
  etaSeconds: number;
}

const WazeDriverInfoSchema = z.object({
  lon: z.number(),
  lat: z.number(),
  calculatedLocation: z.object({
    city: z.string().optional(),
    street: z.string().optional(),
    latitude: z.number(),
    longitude: z.number(),
  }),
  eta: z.number(),
  status: z.string().optional(),
});

export function extractWazeDriveUrl(text: string): string | null {
  const match = text.match(/https:\/\/(?:www\.)?waze\.com\/ul\?[^\s<>"']+/i);
  if (!match) return null;

  return match[0].replace(/[),.;!?]+$/, "");
}

export function extractWazeSdToken(wazeUrl: string): string | null {
  try {
    const url = new URL(wazeUrl);
    if (url.protocol !== "https:") return null;
    if (url.hostname !== "waze.com") return null;
    if (url.pathname !== "/ul") return null;

    return url.searchParams.get("sd");
  } catch {
    return null;
  }
}

export class WazeService {
  private baseUrl: string;

  constructor(baseUrl = "https://www.waze.com/il-rtserver/web") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async getDriveInfo(wazeUrl: string): Promise<WazeDriveInfo | null> {
    const token = extractWazeSdToken(wazeUrl);
    if (!token) return null;

    const params = new URLSearchParams({
      token,
      getUserInfo: "true",
      _: String(Date.now()),
    });

    try {
      const res = await fetch(`${this.baseUrl}/PickUpGetDriverInfo?${params}`);
      if (!res.ok) return null;

      const parsed = WazeDriverInfoSchema.safeParse(await res.json());
      if (!parsed.success) {
        console.warn("Waze driver info response validation failed:", parsed.error);
        return null;
      }

      const data = parsed.data;
      if (data.status && data.status !== "ok") return null;

      const destinationParts = [
        data.calculatedLocation.street,
        data.calculatedLocation.city,
      ].filter(Boolean);

      return {
        originLat: data.lat,
        originLng: data.lon,
        originLabel: "Waze location",
        destLat: data.calculatedLocation.latitude,
        destLng: data.calculatedLocation.longitude,
        destLabel: destinationParts.length
          ? destinationParts.join(", ")
          : `${data.calculatedLocation.latitude.toFixed(4)}, ${data.calculatedLocation.longitude.toFixed(4)}`,
        etaSeconds: data.eta,
      };
    } catch (err) {
      console.error("Waze drive import error:", err);
      return null;
    }
  }
}
