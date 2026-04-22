import { Markup } from "telegraf";
import type { Context } from "telegraf";
import type { Repository } from "../db/repository";
import type { SessionManager } from "./session";
import { formatTrustProfile, formatRideSummary } from "../utils";

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

export async function handleSos(ctx: Context, userId: number, repo: Repository): Promise<void> {
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
    console.warn(
      `SOS triggered: match=${activeMatch.id}, user=${userId}, time=${new Date().toISOString()}`,
    );
    // TODO(privacy/legal): persist SOS events to a dedicated `sos_events` table
  }
}

export function rideReviewContent(telegramId: number, sessions: SessionManager) {
  const session = sessions.get(telegramId);
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
      [Markup.button.callback("Post this ride ✅", "post_ride")],
      [Markup.button.callback("Edit something ✏️", "edit_ride")],
      [Markup.button.callback("Cancel", "cancel_ride_flow")],
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

  let statusText = `💰 Points: ${user.pointsBalance.toFixed(1)}\n`;

  if (activeMatch) {
    statusText += `\n🚗 Active ride (${activeMatch.status})\nMatch #${activeMatch.id}`;
    await ctx.reply(
      statusText,
      Markup.inlineKeyboard([
        [Markup.button.callback("🚨 SOS", "sos_button")],
        [Markup.button.callback("Cancel ride", "cancel_from_status")],
      ]),
    );
  } else {
    statusText += `\nNo active ride right now.`;
    await ctx.reply(statusText, mainMenuKeyboard());
  }
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
