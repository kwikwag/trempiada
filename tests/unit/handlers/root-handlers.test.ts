import assert from "node:assert/strict";
import test from "node:test";
import { registerHandlers } from "../../../src/bot/handlers";
import { FakeBot, createDeps, inlineButtonTexts, makeCtx } from "./helpers";

function setupRootHandlers() {
  const bot = new FakeBot();
  const { repo, sessions, deps } = createDeps();

  registerHandlers({
    bot: bot as any,
    repo,
    sessions,
    matching: deps.matching,
    routing: deps.routing,
    carRecognition: deps.carRecognition,
    geocoding: deps.geocoding,
    telegramPhotos: deps.telegramPhotos,
    profileFace: deps.profileFace,
    faceLiveness: deps.faceLiveness,
    options: { logger: deps.logger },
  });

  return { bot, repo, sessions };
}

test("message fallthrough replies with gender buttons for registration_gender", async () => {
  const { bot, repo, sessions } = setupRootHandlers();
  const telegramId = 42_001;
  const user = repo.createUser(telegramId, "Dana");
  sessions.setUserId(telegramId, user.id);
  sessions.setScene({ telegramId, scene: "registration_gender" });

  const ctx = makeCtx({ telegramId, message: { text: "hello" } });
  await bot.emit("message", ctx);

  assert.equal(ctx.replies.at(-1)?.text, "Please choose your gender using the buttons below.");
  const buttons = inlineButtonTexts(ctx.replies.at(-1)?.extra);
  assert.ok(buttons.includes("Male"));
  assert.ok(buttons.includes("Back to menu"));
});

test("message fallthrough replies with departure buttons for ride_departure", async () => {
  const { bot, repo, sessions } = setupRootHandlers();
  const telegramId = 42_002;
  const user = repo.createUser(telegramId, "Driver");
  sessions.setUserId(telegramId, user.id);
  sessions.setScene({ telegramId, scene: "ride_departure" });

  const ctx = makeCtx({ telegramId, message: { text: "tomorrow" } });
  await bot.emit("message", ctx);

  assert.match(ctx.replies.at(-1)?.text ?? "", /choose when you're leaving/i);
  const buttons = inlineButtonTexts(ctx.replies.at(-1)?.extra);
  assert.ok(buttons.includes("Now"));
  assert.ok(buttons.includes("Pick a time"));
  assert.ok(buttons.includes("Back to menu"));
});

test("message fallthrough re-renders ride review for ride_review", async () => {
  const { bot, repo, sessions } = setupRootHandlers();
  const telegramId = 42_003;
  const user = repo.createUser(telegramId, "Driver");
  sessions.setUserId(telegramId, user.id);
  sessions.setScene({
    telegramId,
    scene: "ride_review",
    data: {
      originLabel: "Tel Aviv",
      destLabel: "Jerusalem",
      estimatedDuration: 3600,
      departureTime: new Date().toISOString(),
      carInfo: "🚗 Toyota Corolla",
      seats: 3,
      maxDetour: 5,
    },
  });

  const ctx = makeCtx({ telegramId, message: { text: "what now?" } });
  await bot.emit("message", ctx);

  assert.match(ctx.replies.at(-1)?.text ?? "", /Here's your ride:/);
  const buttons = inlineButtonTexts(ctx.replies.at(-1)?.extra);
  assert.ok(buttons.includes("Post this ride ✅"));
});

test("message fallthrough re-renders request review for request_review", async () => {
  const { bot, repo, sessions } = setupRootHandlers();
  const telegramId = 42_004;
  const user = repo.createUser(telegramId, "Rider");
  sessions.setUserId(telegramId, user.id);
  const earliestDeparture = new Date().toISOString();
  const latestDeparture = new Date(Date.now() + 3600_000).toISOString();
  sessions.setScene({
    telegramId,
    scene: "request_review",
    data: {
      editingRequestId: 7,
      pickupLabel: "Pickup",
      dropoffLabel: "Dropoff",
      earliestDeparture,
      latestDeparture,
      originalPickupLabel: "Pickup",
      originalDropoffLabel: "Dropoff",
      originalEarliestDeparture: earliestDeparture,
      originalLatestDeparture: latestDeparture,
    },
  });

  const ctx = makeCtx({ telegramId, message: { text: "huh?" } });
  await bot.emit("message", ctx);

  assert.match(ctx.replies.at(-1)?.text ?? "", /Here's your ride request:/);
  const buttons = inlineButtonTexts(ctx.replies.at(-1)?.extra);
  assert.ok(buttons.includes("Save changes ✅"));
});

test("message fallthrough explains text-only relay for non-text in_ride_relay updates", async () => {
  const { bot, repo, sessions } = setupRootHandlers();
  const telegramId = 42_005;
  const user = repo.createUser(telegramId, "Rider");
  sessions.setUserId(telegramId, user.id);
  sessions.setScene({ telegramId, scene: "in_ride_relay" });

  const ctx = makeCtx({ telegramId, message: { photo: [{ file_id: "abc" }] } });
  await bot.emit("message", ctx);

  assert.match(ctx.replies.at(-1)?.text ?? "", /relay text messages here/i);
  const buttons = inlineButtonTexts(ctx.replies.at(-1)?.extra);
  assert.ok(buttons.includes("Show my status"));
});
