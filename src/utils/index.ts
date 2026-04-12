import crypto from "crypto";
import type { User, TrustVerification, Car } from "../types";

/** Generate a random N-digit numeric code */
export function generateCode(length: number = 4): string {
  const max = Math.pow(10, length);
  const num = crypto.randomInt(0, max);
  return num.toString().padStart(length, "0");
}

/** Mask a plate number for pre-confirmation display: "12-345-67" → "••-•45-67" */
export function maskPlate(plate: string): string {
  const digits = plate.replace(/\D/g, "");
  if (digits.length < 4) return "••••";
  const visible = digits.slice(-4);
  const masked = "•".repeat(digits.length - 4);
  // Reconstruct with original separators roughly
  return masked + visible;
}

/** Format seconds into human-readable duration */
export function formatDuration(seconds: number): string {
  const mins = Math.round(seconds / 60);
  if (mins < 60) return `${mins} min`;
  const hours = Math.floor(mins / 60);
  const remainder = mins % 60;
  return remainder > 0 ? `${hours}h ${remainder}min` : `${hours}h`;
}

/** Format a trust profile for display */
export function formatTrustProfile(
  user: User,
  verifications: TrustVerification[],
  forPublic: boolean = false,
): string {
  const lines: string[] = [];

  const verTypeLabels: Record<string, string> = {
    phone: "Phone",
    photo: "Photo",
    car: "Car details",
    facebook: "Facebook",
    linkedin: "LinkedIn",
    google: "Google",
    email: "Email",
  };

  for (const v of verifications) {
    if (forPublic && !v.sharedWithRiders) continue;
    lines.push(`✅ ${verTypeLabels[v.type] || v.type} verified`);
  }

  if (user.avgRatingAsDriver !== null && user.totalRidesAsDriver > 0) {
    lines.push(
      `⭐ ${user.avgRatingAsDriver.toFixed(1)} (${user.totalRidesAsDriver} rides as driver)`,
    );
  }
  if (user.avgRatingAsRider !== null && user.totalRidesAsRider > 0) {
    lines.push(`⭐ ${user.avgRatingAsRider.toFixed(1)} (${user.totalRidesAsRider} rides as rider)`);
  }
  if (user.totalRidesAsDriver === 0 && user.totalRidesAsRider === 0) {
    lines.push("⭐ New user (no rides yet)");
  }

  return lines.join("\n");
}

/** Format car info for display */
export function formatCarInfo(car: Car, masked: boolean = false): string {
  const plate = masked ? maskPlate(car.plateNumber) : car.plateNumber;
  const yearStr = car.year ? `, ${car.year}` : "";
  return `🚗 ${car.make} ${car.model}, ${car.color}${yearStr}\n🔢 Plate: ${plate}`;
}

/** Format a ride summary for review before posting */
export function formatRideSummary(
  originLabel: string,
  destLabel: string,
  durationSeconds: number | null,
  departureTime: string,
  seats: number,
  maxDetour: number,
): string {
  const duration = durationSeconds ? formatDuration(durationSeconds) : "calculating...";
  const depTime = formatDepartureTime(departureTime);
  return [
    `📍 ${originLabel} → ${destLabel}`,
    `🕐 ${duration} drive, departing ${depTime}`,
    `👥 ${seats} seat${seats > 1 ? "s" : ""} available`,
    `↩️ Max detour: ${maxDetour} min`,
  ].join("\n");
}

/** Format departure time for display */
function formatDepartureTime(iso: string): string {
  const date = new Date(iso);
  const now = new Date();
  const diffMs = date.getTime() - now.getTime();

  if (diffMs < 5 * 60 * 1000) return "now";
  if (diffMs < 60 * 60 * 1000) return `in ~${Math.round(diffMs / 60000)} min`;

  return date.toLocaleTimeString("en-IL", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

/** Format a match notification for the rider */
export function formatMatchForRider(
  driver: User,
  car: Car,
  publicVerifications: TrustVerification[],
  pickupLabel: string,
  dropoffLabel: string,
  detourSeconds: number,
  departureTime: string,
): string {
  const trustProfile = formatTrustProfile(driver, publicVerifications, true);
  const carInfo = formatCarInfo(car, true); // Masked plate pre-confirmation

  return [
    "🎉 Ride match!\n",
    `👤 ${driver.firstName} (${driver.gender || "not specified"})`,
    carInfo,
    "",
    trustProfile,
    "",
    `📍 Pickup: ${pickupLabel}`,
    `📍 Dropoff: ${dropoffLabel}`,
    `🕐 Departing ${formatDepartureTime(departureTime)}`,
    `↩️ Detour for driver: ~${formatDuration(detourSeconds)}`,
  ].join("\n");
}

/** Haversine distance between two points in km */
export function haversineKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(deg: number): number {
  return deg * (Math.PI / 180);
}
