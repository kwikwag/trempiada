import { Markup } from "telegraf";
import type { Context } from "telegraf";
import type { Repository } from "../db/repository";
import type { SessionManager } from "./session";
import {
  formatTrustProfile,
  formatRideSummary,
  formatCarInfo,
  formatTime,
  type RideChangedField,
} from "../utils";
import type { Logger } from "../logger";
import { noopLogger } from "../logger";
import type { Match, Ride, RideRequest, User } from "../types";

export const SOS_KEYBOARD = Markup.keyboard([["🚨 SOS"]]).resize();
export const REMOVE_KEYBOARD = Markup.removeKeyboard();
type InlineButton = ReturnType<typeof Markup.button.callback>;

export function mainMenuKeyboard() {
  return Markup.inlineKeyboard([
    [
      Markup.button.callback("🚗 Offer a ride", "menu_drive"),
      Markup.button.callback("🛑 Request a ride", "menu_ride"),
    ],
    [
      Markup.button.callback("👤 My profile", "menu_profile"),
      Markup.button.callback("📊 My status", "menu_status"),
    ],
  ]);
}

export function statusKeyboard() {
  return Markup.inlineKeyboard([[Markup.button.callback("Show my status", "menu_status")]]);
}

export function withBackToMenuButton(rows: InlineButton[][]) {
  return Markup.inlineKeyboard([...rows, [Markup.button.callback("Back to menu", "back_to_menu")]]);
}

export function backToMenuKeyboard() {
  return withBackToMenuButton([]);
}

export function genderKeyboard() {
  return withBackToMenuButton([
    [Markup.button.callback("Male", "gender_male")],
    [Markup.button.callback("Female", "gender_female")],
    [Markup.button.callback("Other", "gender_other")],
  ]);
}

export function verificationKeyboard() {
  return withBackToMenuButton([
    [Markup.button.callback("Facebook", "verify_facebook")],
    [Markup.button.callback("LinkedIn", "verify_linkedin")],
    [Markup.button.callback("Google", "verify_google")],
    [Markup.button.callback("Email", "verify_email")],
  ]);
}

export function profilePhotoPromptKeyboard() {
  return withBackToMenuButton([[Markup.button.callback("Skip for now", "photo_skip")]]);
}

export function profilePhotoConfirmKeyboard() {
  return withBackToMenuButton([
    [Markup.button.callback("Use this photo", "photo_confirm_use")],
    [Markup.button.callback("Try another photo", "photo_confirm_retry")],
    [Markup.button.callback("Skip for now", "photo_skip")],
  ]);
}

export async function replyNotRegistered(ctx: Context): Promise<void> {
  await ctx.reply(
    "TrempiadaBot connects drivers with hitchhikers in Israel.\n\nTap below to get started — it takes about 30 seconds.",
    Markup.inlineKeyboard([[Markup.button.callback("Get started 👋", "menu_start")]]),
  );
}

export async function showMainMenu(ctx: Context, name: string): Promise<void> {
  await ctx.reply(`What would you like to do, ${name}?`, mainMenuKeyboard());
}

export async function renderProfile(
  ctx: Context,
  { userId, repo }: { userId: number; repo: Repository },
): Promise<void> {
  const user = repo.getUserById(userId)!;
  const verifications = repo.getVerifications(userId);
  const verifiedTypes = new Set(verifications.map((v) => v.type));

  const genderLabel = user.gender
    ? { male: "Male", female: "Female", other: "Other" }[user.gender]
    : "Not set";
  const photoLabel = !user.photoFileId
    ? "Missing"
    : repo.hasCurrentFaceLivenessVerification(userId)
      ? "Verified ✅"
      : "Unverified";

  const personalInfo = [
    `👤 *${user.firstName}*`,
    `⚧ Gender: ${genderLabel}`,
    `📸 Photo: ${photoLabel}`,
  ].join("\n");

  const verStats = formatTrustProfile({ user, verifications, forPublic: false });

  const verButtons = [];
  if (user.photoFileId) {
    verButtons.push([
      Markup.button.callback("View picture", "view_profile_photo"),
      Markup.button.callback("Change picture", "profile_photo"),
    ]);
  } else {
    verButtons.push([Markup.button.callback("Add picture", "profile_photo")]);
  }
  verButtons.push([Markup.button.callback("Run face liveness check", "profile_liveness")]);
  if (!verifiedTypes.has("facebook"))
    verButtons.push([Markup.button.callback("Connect Facebook", "verify_facebook")]);
  if (!verifiedTypes.has("linkedin"))
    verButtons.push([Markup.button.callback("Connect LinkedIn", "verify_linkedin")]);
  if (!verifiedTypes.has("google"))
    verButtons.push([Markup.button.callback("Connect Google", "verify_google")]);
  if (!verifiedTypes.has("email"))
    verButtons.push([Markup.button.callback("Add email", "verify_email")]);

  for (const v of verifications) {
    if (["facebook", "linkedin", "google", "email"].includes(v.type)) {
      const icon = v.sharedWithRiders ? "👁" : "🙈";
      verButtons.push([
        Markup.button.callback(
          `${icon} ${v.type} — ${v.sharedWithRiders ? "visible to riders" : "hidden"}`,
          `toggle_vis_${v.type}`,
        ),
      ]);
    }
  }

  verButtons.push([Markup.button.callback("🔄 Restart profile", "restart_profile")]);

  await ctx.reply(
    `*My Profile*\n\n${personalInfo}\n\n*Verifications & Trust*\n${verStats}` +
      (verButtons.length > 1 ? `\n\nManage your verifications:` : ""),
    { parse_mode: "Markdown", ...Markup.inlineKeyboard(verButtons) },
  );
}

export async function handleSos(
  ctx: Context,
  { userId, repo, logger = noopLogger }: { userId: number; repo: Repository; logger?: Logger },
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

  let changedFields: Set<RideChangedField> | undefined;
  if (isEditingPostedRide) {
    changedFields = new Set();
    if (session.data.seats !== session.data.originalSeats) changedFields.add("seats");
    if (session.data.carId !== session.data.originalCarId) changedFields.add("car");
    if (session.data.departureTime !== session.data.originalDepartureTime)
      changedFields.add("departure");
    if (
      session.data.originLabel !== session.data.originalOriginLabel ||
      session.data.destLabel !== session.data.originalDestLabel
    )
      changedFields.add("route");
  }

  const hasChanges = (changedFields?.size ?? 0) > 0;
  const summary = formatRideSummary({
    originLabel: session.data.originLabel,
    destLabel: session.data.destLabel,
    durationSeconds: session.data.estimatedDuration,
    departureTime: session.data.departureTime,
    carInfo: session.data.carInfo,
    seats: session.data.seats,
    maxDetour: session.data.maxDetour,
    changedFields,
  });

  return {
    text: `Here's your ride:\n\n${summary}\n\n`,
    extra: {
      parse_mode: "Markdown" as const,
      ...Markup.inlineKeyboard([
        [Markup.button.callback("✏️ Seats available", "edit_ride_seats")],
        [Markup.button.callback("✏️ Departure time", "edit_ride_departure")],
        [Markup.button.callback("✏️ Origin", "edit_ride_origin")],
        [Markup.button.callback("✏️ Destination", "edit_ride_dest")],
        [Markup.button.callback("🚗 Change car", "edit_ride_car")],
        [
          Markup.button.callback(
            isEditingPostedRide ? "Save changes ✅" : "Post this ride ✅",
            "post_ride",
          ),
          Markup.button.callback(
            isEditingPostedRide
              ? hasChanges
                ? "Discard changes"
                : "Keep current offer"
              : "Cancel",
            "cancel_ride_flow",
          ),
        ],
      ]),
    },
  };
}

export async function replyWithRideReview(
  ctx: Context,
  { telegramId, sessions }: { telegramId: number; sessions: SessionManager },
): Promise<void> {
  const review = rideReviewContent(telegramId, sessions);
  await ctx.reply(review.text, review.extra);
}

export async function showStatus(
  ctx: Context,
  { userId, repo }: { userId: number; repo: Repository },
): Promise<void> {
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
        formatMatchStatus({ match: activeMatch, isDriver, otherUser, ride, request }),
      ].join("\n"),
      Markup.inlineKeyboard(buttons),
    );
    return;
  }

  const openRide = repo.getOpenRideForDriver(userId);
  if (openRide) {
    const activeCar = repo.getActiveCar(userId);
    const carInfo = activeCar?.id === openRide.carId ? formatCarInfo(activeCar) : undefined;
    await ctx.reply(
      [accountLine(user), "", formatOpenRideStatus(openRide, carInfo)].join("\n"),
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

function formatMatchStatus({
  match,
  isDriver,
  otherUser,
  ride,
  request,
}: {
  match: Match;
  isDriver: boolean;
  otherUser: User | null;
  ride: Ride | null;
  request: RideRequest | null;
}): string {
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

function formatOpenRideStatus(ride: Ride, carInfo?: string): string {
  return [
    "🚗 You are offering a ride.",
    `📍 ${ride.originLabel} → ${ride.destLabel}`,
    `🕐 Leaving ${formatTime(ride.departureTime)}`,
    ...(carInfo ? [carInfo] : []),
    `👥 ${ride.availableSeats} seat${ride.availableSeats === 1 ? "" : "s"} available`,
    "Next: review matching riders, modify this offer, or cancel it before requesting a ride.",
  ].join("\n");
}

function formatOpenRequestStatus(request: RideRequest): string {
  return [
    "🛑 You are requesting a ride.",
    `📍 ${request.pickupLabel} → ${request.dropoffLabel}`,
    `🕐 Window: ${formatTime(request.earliestDeparture)}-${formatTime(request.latestDeparture)}`,
    "Next: wait for a driver, or cancel this request before offering a ride.",
  ].join("\n");
}

export function cancellationKeyboard() {
  return withBackToMenuButton([
    [Markup.button.callback("Changed plans", "cancel_changed_plans")],
    [Markup.button.callback("Other party didn't show", "cancel_no_show")],
    [Markup.button.callback("Felt unsafe", "cancel_felt_unsafe")],
    [Markup.button.callback("Other reason", "cancel_other")],
  ]);
}

export async function resolveLocation(
  message: any,
  geocoding: {
    reverseGeocode: (args: { lat: number; lng: number }) => Promise<string | null>;
    geocode: (query: string) => Promise<{ lat: number; lng: number; label: string } | null>;
  },
): Promise<{ lat: number; lng: number; label: string } | null> {
  if ("location" in message) {
    const lat = message.location.latitude;
    const lng = message.location.longitude;
    const resolved = await geocoding.reverseGeocode({ lat, lng });
    const label = resolved ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`;
    return { lat, lng, label };
  }
  if ("text" in message) {
    return geocoding.geocode(message.text.trim());
  }
  return null;
}
