import { Markup } from "telegraf";
import type { Context } from "telegraf";
import type { Repository } from "../db/repository";
import type { SessionManager } from "./session";
import { formatTrustProfile, formatRideSummary } from "../utils";
import type { Logger } from "../logger";
import { noopLogger } from "../logger";
import type { Match, Ride, RideRequest, User } from "../types";

export const SOS_KEYBOARD = Markup.keyboard([["🚨 SOS"]]).resize();
export const REMOVE_KEYBOARD = Markup.removeKeyboard();

export function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🚗 Offer a ride", "menu_drive"),
      Markup.button.callback("🛑 Request a ride", "menu_ride"),
    ],
    [
      Markup.button.callback("👤 Trust profile", "menu_trust"),
      Markup.button.callback("📊 My status", "menu_status"),
    ],
  ]);
}

export function statusKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("Show my status", "menu_status")]]);
}

export async function showMainMenu(ctx: Context, name: string): Promise<void> {
  await ctx.reply(`What would you like to do, ${name}?`, mainMenuKeyboard());
}

export async function renderTrustProfile(
  ctx: Context,
  userId: number,
  repo: Repository,
): Promise<void> {
  const user = repo.getUserById(userId)!;
  const verifications = repo.getVerifications(userId);
  const profile = formatTrustProfile(user, verifications, false);
  const verifiedTypes = new Set(verifications.map((v) => v.type));
  const buttons = [];

  if (!verifiedTypes.has("facebook"))
    buttons.push([Markup.button.callback("Connect Facebook", "verify_facebook")]);
  if (!verifiedTypes.has("linkedin"))
    buttons.push([Markup.button.callback("Connect LinkedIn", "verify_linkedin")]);
  if (!verifiedTypes.has("google"))
    buttons.push([Markup.button.callback("Connect Google", "verify_google")]);
  if (!verifiedTypes.has("email"))
    buttons.push([Markup.button.callback("Add email", "verify_email")]);

  for (const v of verifications) {
    if (["facebook", "linkedin", "google", "email"].includes(v.type)) {
      const icon = v.sharedWithRiders ? "👁" : "🙈";
      buttons.push([
        Markup.button.callback(
          `${icon} ${v.type} — ${v.sharedWithRiders ? "visible to riders" : "hidden"}`,
          `toggle_vis_${v.type}`,
        ),
      ]);
    }
  }

  await ctx.reply(
    `Your trust profile:\n\n${profile}\n\n` +
      (buttons.length > 0 ? `Manage your verifications:` : `All verifications complete! ✅`),
    buttons.length > 0 ? Markup.inlineKeyboard(buttons) : undefined,
  );
}

export async function handleSos(
  ctx: Context,
  userId: number,
  repo: Repository,
  logger: Logger = noopLogger,
): Promise<void> {
  const activeMatch = repo.getActiveMatchForUser(userId);
  await ctx.reply(
    `📍 Your ride details have been saved.\n\n` +
      `🚨 Emergency: call 100 (Israel Police)\n` +
      `🚑 Ambulance: 101\n\n` +
      `If you need to share your situation with someone you trust, ` +
      `send them this chat right now.`,
    Markup.inlineKeyboard([[Markup.button.callback("I'm OK, false alarm", "sos_ok")]]),
  );
  if (activeMatch) {
    logger.warn("sos_triggered", {
      userId,
      matchId: activeMatch.id,
      rideId: activeMatch.rideId,
      requestId: activeMatch.requestId,
    });
    // TODO(privacy/legal): persist SOS events to a dedicated `sos_events` table
  }
}

export function rideReviewContent(telegramId: number, sessions: SessionManager) {
  const session = sessions.get(telegramId);
  const isEditingPostedRide = typeof session.data.editingRideId === "number";
  const summary = formatRideSummary(
    session.data.originLabel,
    session.data.destLabel,
    session.data.estimatedDuration,
    session.data.departureTime,
    session.data.seats,
    session.data.maxDetour,
  );

  return {
    text: `Here's your ride:\n\n${summary}\n\n`,
    keyboard: Markup.inlineKeyboard([
      [
        Markup.button.callback(
          isEditingPostedRide ? "Save changes ✅" : "Post this ride ✅",
          "post_ride",
        ),
      ],
      [Markup.button.callback("Edit something ✏️", "edit_ride")],
      [
        Markup.button.callback(
          isEditingPostedRide ? "Keep current offer" : "Cancel",
          "cancel_ride_flow",
        ),
      ],
    ]),
  };
}

export async function replyWithRideReview(
  ctx: Context,
  telegramId: number,
  sessions: SessionManager,
): Promise<void> {
  const review = rideReviewContent(telegramId, sessions);
  await ctx.reply(review.text, review.keyboard);
}

export async function showStatus(ctx: Context, userId: number, repo: Repository): Promise<void> {
  const user = repo.getUserById(userId)!;
  const activeMatch = repo.getActiveMatchForUser(userId);

  if (activeMatch) {
    const ride = repo.getRideById(activeMatch.rideId);
    const request = repo.getRideRequestById(activeMatch.requestId);
    const isDriver = activeMatch.driverId === userId;
    const otherUser = repo.getUserById(isDriver ? activeMatch.riderId : activeMatch.driverId);
    const buttons = [];

    if (isDriver && activeMatch.status === "picked_up") {
      buttons.push([Markup.button.callback("🏁 Complete ride", `complete_ride_${activeMatch.id}`)]);
    }
    buttons.push([Markup.button.callback("🚨 SOS", "sos_button")]);
    buttons.push([Markup.button.callback("Cancel ride", "cancel_from_status")]);

    await ctx.reply(
      [
        accountLine(user),
        "",
        formatMatchStatus(activeMatch, isDriver, otherUser, ride, request),
      ].join("\n"),
      Markup.inlineKeyboard(buttons),
    );
    return;
  }

  const openRide = repo.getOpenRideForDriver(userId);
  if (openRide) {
    await ctx.reply(
      [accountLine(user), "", formatOpenRideStatus(openRide)].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("Review riders", "review_riders")],
        [Markup.button.callback("Modify offer", "edit_open_ride")],
        [Markup.button.callback("Cancel offer", "cancel_open_ride")],
        [Markup.button.callback("Request a ride instead", "switch_offer_to_request")],
      ]),
    );
    return;
  }

  const openRequest = repo.getOpenRideRequestForRider(userId);
  if (openRequest) {
    await ctx.reply(
      [accountLine(user), "", formatOpenRequestStatus(openRequest)].join("\n"),
      Markup.inlineKeyboard([
        [Markup.button.callback("Modify request", "edit_open_request")],
        [Markup.button.callback("Cancel request", "cancel_open_request")],
        [Markup.button.callback("Offer a ride instead", "switch_request_to_drive")],
      ]),
    );
    return;
  }

  await ctx.reply(
    [accountLine(user), "", "No active ride offer or request right now."].join("\n"),
    mainMenuKeyboard(),
  );
}

function accountLine(user: User): string {
  return `💰 Points: ${user.pointsBalance.toFixed(1)}`;
}

function formatMatchStatus(
  match: Match,
  isDriver: boolean,
  otherUser: User | null,
  ride: Ride | null,
  request: RideRequest | null,
): string {
  const role = isDriver ? "driver" : "rider";
  const otherRole = isDriver ? "rider" : "driver";
  const otherName = otherUser?.firstName ?? `your ${otherRole}`;
  const route =
    (request ?? ride)
      ? `\n📍 ${request?.pickupLabel ?? ride?.originLabel} → ${request?.dropoffLabel ?? ride?.destLabel}`
      : "";

  if (match.status === "accepted") {
    const next = isDriver
      ? `Next: go to pickup, ask ${otherName} for the ${match.confirmationCode.length}-digit code, then type it here.`
      : `Next: wait for ${otherName} at pickup and show this code when they arrive: ${match.confirmationCode}`;
    return [`🚗 Matched as ${role} with ${otherName}.${route}`, next].join("\n");
  }

  if (match.status === "picked_up") {
    const next = isDriver
      ? "Next: complete the ride after dropoff."
      : `Next: enjoy the ride. You can message ${otherName} here if needed.`;
    return [`🚗 Ride in progress as ${role} with ${otherName}.${route}`, next].join("\n");
  }

  return [
    `🚗 Match pending as ${role} with ${otherName}.${route}`,
    "Next: wait for the other party to confirm.",
  ].join("\n");
}

function formatOpenRideStatus(ride: Ride): string {
  return [
    "🚗 You are offering a ride.",
    `📍 ${ride.originLabel} → ${ride.destLabel}`,
    `🕐 Leaving ${formatStatusTime(ride.departureTime)}`,
    `👥 ${ride.availableSeats} seat${ride.availableSeats === 1 ? "" : "s"} available`,
    "Next: review matching riders, modify this offer, or cancel it before requesting a ride.",
  ].join("\n");
}

function formatOpenRequestStatus(request: RideRequest): string {
  return [
    "🛑 You are requesting a ride.",
    `📍 ${request.pickupLabel} → ${request.dropoffLabel}`,
    `🕐 Window: ${formatStatusTime(request.earliestDeparture)}-${formatStatusTime(request.latestDeparture)}`,
    "Next: wait for a driver, or cancel this request before offering a ride.",
  ].join("\n");
}

function formatStatusTime(iso: string): string {
  return new Date(iso).toLocaleTimeString("en-IL", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

export function cancellationKeyboard() {
  return Markup.inlineKeyboard([
    [Markup.button.callback("Changed plans", "cancel_changed_plans")],
    [Markup.button.callback("Other party didn't show", "cancel_no_show")],
    [Markup.button.callback("Felt unsafe", "cancel_felt_unsafe")],
    [Markup.button.callback("Other reason", "cancel_other")],
  ]);
}

export async function resolveLocation(
  message: any,
  geocoding: {
    reverseGeocode: (lat: number, lng: number) => Promise<string | null>;
    geocode: (query: string) => Promise<{ lat: number; lng: number; label: string } | null>;
  },
): Promise<{ lat: number; lng: number; label: string } | null> {
  if ("location" in message) {
    const lat = message.location.latitude;
    const lng = message.location.longitude;
    const resolved = await geocoding.reverseGeocode(lat, lng);
    const label = resolved ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    return { lat, lng, label };
  }
  if ("text" in message) {
    return geocoding.geocode(message.text.trim());
  }
  return null;
}
