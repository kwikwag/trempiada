# WhatsApp Bot Implementation Plan (with Telegram Feature Parity)

## 1) Goal and Success Criteria

Build a WhatsApp bot that works **alongside** the existing Telegram bot, sharing one backend/domain model so both channels support the same end-user capabilities:

- Registration and profile lifecycle (including photo flow and optional liveness).
- Rider request flow and driver offer flow.
- Matching, acceptance, ride lifecycle, relay messaging, cancellation, and ratings.
- Points economy and trust/verification visibility.
- Status visibility and “what to do next” UX guidance.

**Definition of done (v1 parity):** A user can complete the full ride journey on WhatsApp with no required Telegram-only steps.

---

## 2) Product Principles for Multi-Channel Support

1. **Single domain, multi-channel adapters**
   - Keep matching, repository logic, ride state transitions, verification policy, and points in shared services.
   - Channel layer should only map inbound events and outbound UI primitives.

2. **Canonical conversation state**
   - Move session/scene state from Telegram-only assumptions toward a channel-aware state store (`channel`, `channelUserId`, `effectiveUserId`).
   - Preserve current in-memory behavior initially, with a clear path to DB/Redis persistence for reliability.

3. **Feature parity through capability mapping**
   - Where WhatsApp lacks Telegram affordances, provide equivalent UX via list messages, quick replies, interactive buttons, and short text prompts.

4. **Safety and privacy invariants stay unchanged**
   - Keep PII logging restrictions, no direct contact sharing, confirmation code handling, and trust checks consistent across channels.

---

## 3) Current-State Assessment (Telegram)

Before implementation, run a quick architecture inventory and classify each component:

- **Reusable as-is**: repository, matching, routing, identity/photo processing, points/rating logic.
- **Needs interface extraction**: handler flows tightly coupled to Telegraf `ctx` and Telegram keyboards.
- **Needs channel abstraction**: command discovery, menu rendering, message relay formatting, media handling.

Deliverable: short matrix (`component` → `status` → `migration action`) added to this plan or a companion design doc.

---

## 4) Target Architecture

## 4.1 Channel-Agnostic Core

Create/expand core application services that express user intents independent of Telegram/WhatsApp:

- `startRegistration`, `completeProfile`, `startRideRequest`, `startDriveOffer`
- `editOpenRequest/Offer`, `cancelActiveActivity`, `acceptMatch`, `skipMatch`
- `relayMessage`, `confirmPickupCode`, `completeRide`, `submitRating`
- `getStatusViewModel`, `getMainMenuViewModel`

Each returns:
- state mutations,
- domain events,
- and a channel-neutral response model (text blocks, choices, media request prompts, etc.).

## 4.2 Channel Adapters

Implement adapters with a common contract:

- `TelegramAdapter` (refactor existing bot wiring to use shared contract).
- `WhatsAppAdapter` (new): webhook parser + outbound sender.

Suggested adapter interface:

- `parseInboundUpdate(raw): InboundEvent`
- `sendMessage(outbound: OutboundMessage): Promise<void>`
- `sendInteractive(outbound: OutboundInteractive): Promise<void>`
- `sendMediaRequest(...)`
- `normalizeUserIdentity(...)`

## 4.3 Orchestrator Layer

Add an application orchestrator:

- receives normalized inbound event,
- loads session/user state,
- invokes channel-agnostic flow handlers,
- emits outbound responses through selected adapter,
- writes metrics/audit logs.

This replaces direct Telegraf-first branching as the primary path.

---

## 5) Data Model & Identity Strategy

## 5.1 Multi-channel Identity Linking

Add identity mapping so one person can use either app:

- New table (example): `user_channel_identities`
  - `id`
  - `user_id` (FK to users)
  - `channel` (`telegram` | `whatsapp`)
  - `channel_user_id` (Telegram ID / WhatsApp wa_id)
  - `display_name`
  - timestamps
  - unique (`channel`, `channel_user_id`)

On first WhatsApp contact:
- If trusted linking exists: attach to existing `user_id`.
- Else create a new user or run account-link flow.

## 5.2 Account Linking UX

Support these paths:

1. **Fresh user on WhatsApp** → create account directly.
2. **Existing Telegram user wants same account on WhatsApp**:
   - Generate short-lived link code in Telegram profile screen (or status).
   - Enter code in WhatsApp to bind identity.
3. Optional reverse linking (from WhatsApp to Telegram) for symmetry.

Security:
- single-use codes,
- short expiry (e.g., 10 min),
- rate limiting attempts.

## 5.3 Session State

Upgrade session keying from `telegramId` to `(channel, channelUserId)` while preserving current behavior. Later migrate sessions to persistent storage if needed.

---

## 6) WhatsApp UX Mapping (Parity Plan)

## 6.1 Core Interaction Model

Map Telegram inline keyboard UX to WhatsApp interactive primitives:

- Main menu → WhatsApp interactive list/button message.
- Scene choices (time windows, accept/skip, edit fields) → quick reply buttons/list rows.
- Back to menu → persistent “Back to menu” option in every scene.
- SOS availability during active rides → repeated context button/text shortcut in ride-stage messages.

## 6.2 Command & Discovery

Telegram slash commands become:

- greeting + menu on first message (“hi”, “start”),
- keyword fallbacks (`ride`, `drive`, `status`, `profile`, `cancel`, `sos`),
- always-present “Menu” affordance.

## 6.3 Media & Verification Flows

- Profile photo upload: accept incoming WhatsApp media and pass through same validation/crop pipeline.
- Car photo recognition: accept media, forward to existing Claude Vision pipeline.
- Liveness flow: share web URL similarly; maintain the same finalize-and-compare logic.

## 6.4 Message Relay During Rides

- Preserve relay abstraction: user messages routed through bot, never exposing direct contact.
- Prefix relayed messages with role/context labels for clarity.

---

## 7) API/Provider Choices for WhatsApp

Pick one provider and lock assumptions early:

- **Option A: WhatsApp Cloud API (Meta)** (recommended for direct control).
- Option B: Twilio WhatsApp API (faster ops in some teams, extra vendor layer).

Decision inputs:
- interactive message support,
- media handling,
- webhook reliability,
- cost,
- operational tooling,
- throughput limits.

Deliverable: provider ADR (architecture decision record) with chosen API and tradeoffs.

---

## 8) Incremental Delivery Phases

## Phase 0 — Design & Refactor Prep (1–2 weeks)

- Extract channel-neutral response primitives.
- Create adapter interfaces.
- Refactor Telegram handlers to call orchestrator + shared flow services.
- Add identity-linking schema migration stubs.

**Exit criteria:** Telegram behavior unchanged in production; tests green.

## Phase 1 — WhatsApp MVP Skeleton (1–2 weeks)

- Webhook endpoint + signature verification.
- Inbound normalization/outbound messaging client.
- Minimal menu/status/profile read-only flows on WhatsApp.

**Exit criteria:** A WhatsApp user can create/get account and view status.

## Phase 2 — Ride/Drive Flow Parity (2–3 weeks)

- Request/offer creation and editing.
- Matching candidate review and accept/skip.
- Active ride lifecycle, cancellation, pickup confirmation, completion.
- Ratings and points updates.

**Exit criteria:** End-to-end ride lifecycle fully possible on WhatsApp.

## Phase 3 — Media & Trust Parity (1–2 weeks)

- Profile photo validation + crop confirmation.
- Car recognition flow parity.
- Optional liveness launch/finalization parity.

**Exit criteria:** All trust/photo flows available on WhatsApp.

## Phase 4 — Hardening & Launch (1–2 weeks)

- Reliability improvements (retries/idempotency/dead-letter strategy).
- Metrics dashboards and alerting.
- Load and chaos testing.
- Controlled beta rollout, then general availability.

---

## 9) Reliability, Security, and Compliance

1. **Webhook security**
   - Verify signatures for inbound events.
   - Strict request schema validation.

2. **Idempotency**
   - Deduplicate inbound message IDs.
   - Make state transitions idempotent where possible.

3. **Rate limiting & abuse controls**
   - Per-user throttles, especially linking/verification endpoints.

4. **Logging policy**
   - Preserve current PII-safe logging rules for WhatsApp payloads.

5. **Secrets management**
   - New env vars for WhatsApp tokens, app secret, webhook verify token.

---

## 10) Testing Strategy

1. **Unit tests**
   - Adapter parser/serializer tests.
   - Channel-neutral flow handlers.
   - Identity linking logic and code expiry/rate limits.

2. **Integration tests**
   - End-to-end orchestrator tests with mocked channel adapters.
   - DB-backed tests for linking and mixed-channel lifecycle.

3. **Contract tests**
   - Validate outbound WhatsApp payloads against provider schema.

4. **Regression suite**
   - Ensure Telegram parity remains intact during refactor.

5. **Manual UAT scripts**
   - Role-based journeys (new rider, existing driver, linked account, cancellation edge cases).

---

## 11) Observability & Operations

Track and dashboard by channel:

- new users,
- registration completion,
- request/offer creation,
- match acceptance rate,
- cancellation reasons,
- ride completion rate,
- verification/photo conversion,
- median response latency.

Add alarms for:
- webhook failures,
- outbound API error spikes,
- matching pipeline failures,
- liveness finalization failures.

---

## 12) Rollout Plan

1. Internal dogfood (team only).
2. Closed beta (small user cohort, mixed Telegram + WhatsApp).
3. Gradual ramp by traffic percentage.
4. Full launch with channel-specific help docs.

Include rollback plan:
- disable WhatsApp inbound processing flag,
- keep Telegram fully operational,
- preserve queued critical events where possible.

---

## 13) Concrete Backlog (Initial Tickets)

1. Add `user_channel_identities` migration + repository methods.
2. Introduce channel-neutral `InboundEvent` / `OutboundMessage` models.
3. Build orchestrator entrypoint and port Telegram through it.
4. Implement WhatsApp webhook endpoint and verification.
5. Implement WhatsApp outbound sender with interactive message helpers.
6. Port `/status` and profile views to shared flow + WhatsApp rendering.
7. Port ride request flow.
8. Port drive offer flow.
9. Port in-ride relay + confirmation + completion + rating.
10. Port photo and liveness flows.
11. Add mixed-channel integration tests.
12. Add dashboards + alerts + runbooks.

---

## 14) Open Decisions to Resolve Early

1. Preferred WhatsApp provider (Meta Cloud API vs Twilio).
2. Account-link default behavior (auto-create vs force linking prompt when phone likely matches known user).
3. Session persistence timeline (in-memory first vs Redis/DB now).
4. UX fallback strategy when interactive messages are unavailable.
5. SLA targets per channel and acceptable latency budgets.

---

## 15) Suggested Repo Deliverables

- `docs/whatsapp-bot-implementation-plan.md` (this file).
- ADR: `docs/adr/xxxx-whatsapp-provider-choice.md`.
- Technical design: `docs/whatsapp-architecture.md` with sequence diagrams.
- Task tracking in `TODO.md` with concrete function-level test additions as implementation begins.
