# TrempiadaBot

Telegram-based ridesharing bot connecting drivers with hitchhikers in Israel.

## Quick Reference

- **Language**: TypeScript (strict mode)
- **Runtime**: Node.js 20+
- **Bot framework**: Telegraf v4
- **Database**: SQLite via better-sqlite3 (WAL mode, foreign keys ON)
- **Routing**: OSRM (self-hosted with Israel OSM data)
- **Car recognition**: Claude Vision API (Sonnet)

## Commands

```bash
npm run build        # Compile TypeScript
npm run dev          # Run with ts-node
npm run dev:watch    # Run with ts-node and restart on file changes
npm run migrate      # Initialize/migrate database
npx tsc --noEmit     # Type-check without emitting
```

## Architecture

Single-process monolith. No microservices, no message queues.

```
src/
├── index.ts                 # Entry point, wires services together
├── types/index.ts           # All types, constants (POINTS, DEFAULTS)
├── db/
│   ├── migrate.ts           # Schema DDL + initDatabase()
│   └── repository.ts        # Data access layer (all SQL queries)
├── bot/
│   ├── session.ts           # In-memory state machine per Telegram user
│   ├── deps.ts              # BotDeps interface (shared dependency bundle)
│   ├── ui.ts                # Shared UI helpers (keyboards, showMainMenu, showStatus, etc.)
│   ├── handlers.ts          # Thin wiring: middleware, notify(), assembles BotDeps, delegates to sub-handlers
│   └── handlers/
│       ├── account.ts       # /start, /cancel, /trust, /sos, /status, /delete + cancellation/verification actions
│       ├── drive-posting.ts # /drive, Waze import, ride review/edit, post ride, accept/skip candidates
│       ├── ride-request.ts  # /ride, pickup/dropoff scenes, time window selection
│       ├── in-ride.ts       # Message relay, confirmation code, accept/skip/complete ride, ratings
│       └── registration.ts  # Name/photo/gender scenes, car registration, car confirmation/edit
├── services/
│   ├── routing.ts           # OSRM client (route calc, detour estimation)
│   ├── matching.ts          # Core matching algorithm (driver↔rider)
│   └── car-recognition.ts   # Claude Vision for license plate/car extraction
├── logger.ts                # Pino-backed structured JSON logger (LOG_LEVEL-controlled)
└── utils/
    └── index.ts             # Formatting, geo helpers, code generation
```

## Key Design Decisions

- **Bot state machine**: Each Telegram user has a `SessionState` with a `scene` (current flow step) and `data` (temporary state). Sessions are in-memory; losing them on restart just restarts the user's current flow.
- **Handler modularity**: `handlers.ts` is a thin wiring layer. Each sub-handler file in `handlers/` covers one user journey and exports `register*Handlers(bot, deps)` + `handle*Message(ctx, deps): Promise<boolean>`. The message handler in `handlers.ts` chains them in priority order (in-ride → drive-posting → ride-request → registration). Shared UI is in `ui.ts`; the `BotDeps` bundle is in `deps.ts`.
- **Matching algorithm**: Quick-filter candidates by haversine distance + time window, then OSRM detour calculation for accurate results. Ranked by least detour.
- **Points economy**: Rides are free. Drivers earn 2 pts (rating ≥4) or 1 pt (rating <4). Riders earn 0.5/0.2. New users get 5 pts. No real money touches the system.
- **Trust model**: Drivers must complete ≥1 verification. Each verification is stored in DB; drivers control which are _visible_ to riders vs just verified by the system.
- **Message relay**: During active rides, non-command messages forwarded between parties through the bot (no personal contact shared).
- **Anti-gaming**: Min 5km ride distance, same-pair 24h cooldown, cancellation tracking, simultaneous rating reveal.
- **Logging**: Server-side logs are structured JSON via Pino through `src/logger.ts`. Do not log raw Telegram message text, confirmation codes, phone numbers, license plates, Telegram file IDs, or precise personal location values. Log metadata, IDs, timings, state transitions, aggregate matching counters, and external service failures.
- **Dev impersonation**: Dev-mode persona switching rewrites `ctx.from.id` before domain handlers run. Domain handlers should use the effective `ctx.from.id`; outbound cross-user messages should use `notify()`. Unsafe dev-only database operations live in `DevRepository`, not the regular `Repository`; the dev menu includes a confirmed hard delete for the current effective identity's database rows and session data.

## Environment Variables

```
BOT_TOKEN=           # Telegram bot token (required)
ANTHROPIC_API_KEY=   # For car photo analysis (required)
DATABASE_PATH=       # Default: ./data/rides.db
OSRM_URL=            # Default: http://localhost:5000
LOG_LEVEL=           # debug | info | warn | error (default: info)
```

## Conventions

- All DB column names use snake_case; TypeScript properties use camelCase
- Row mappers in repository.ts handle the conversion
- All dates stored as ISO 8601 strings in SQLite
- Telegram file IDs stored for photos (not downloaded/stored locally)
- Points are REAL in SQLite (fractional values like 0.5)
- Prefer named object arguments for functions where positional order is unclear; use them by default for functions with 4+ arguments.
- Keep code DRY and simple.

## UX Model

- Primary interaction is **inline keyboard buttons**, not slash commands
- Slash commands exist as aliases (discoverable via Telegram's `/` menu via `setMyCommands`)
- A **main menu** (inline keyboard) is shown after: `/start`, registration, ride completion, cancellation
- A **persistent SOS reply keyboard** is shown to both parties from match acceptance until ride end or cancellation — it is the only reply keyboard used and must be explicitly removed with `Markup.removeKeyboard()` on ride conclusion
- `showMainMenu(ctx, name)` is the canonical way to return a user to idle state — prefer it over ad-hoc text prompts
- A user can have only one active ride activity at a time: matched ride, open driver offer, or open rider request. Starting the opposite role should guide them to cancel/switch first, not create a second active activity.
- **Deferred profile**: `/start` auto-creates an account using the Telegram display name and profile photo (if available). Gender and photo are collected just-in-time on first ride or drive action via `ensureProfileComplete` in `src/bot/handlers/profile.ts`. Car registration is collected just-in-time on first drive action. If a user has already done one action (e.g., requested a ride), their gender and photo are already set and are not asked again when they offer a drive.
- Open driver offers and rider requests can be modified only while still unmatched. Edit flows keep the current open activity active while the user chooses a field and reviews changes; saving replaces the previous open offer/request. Once matched, users must cancel the ride before changing route, time, seats, or request details.
- `showStatus(ctx, userId, repo)` is the canonical state summary and should include the user's role, route, current state, and the obvious next action buttons.

## Tests

Run with `npm test` (unit) or `npm run test:all`. Uses Node's built-in test runner with `ts-node`.

**Existing coverage** (`tests/unit/`): `matching`, `routing`, `geocoding`, `waze`, `car-recognition`, `license-lookup`. `tests/integration/matching` uses real in-memory SQLite + real `MatchingService`.

**Missing tests** are tracked in `TODO.md` with specific function names and cases.

**Rules:**

- Repository tests use a real in-memory SQLite instance (call `initDatabase(db)` then `new Repository(db)`)
- Handler tests require a mock Telegraf context — skip unless explicitly requested
- When you add a feature, check whether a test for that method is missing and add it

# Agent Notes

- Also read `AGENTS.local.md` if it exists. It may contain machine-specific local setup.

## End-of-Task Checklist

After completing any non-trivial task, address the following before closing:

1. **Type-check** — Run `npm run typecheck` and confirm it passes.
2. **Tests** — Look at `tests/unit/` and `tests/integration/` to see what already exists. For each file you changed, ask: is the changed method/function covered? If not, write the test or add a specific entry (function name + cases) to the test backlog in `TODO.md`. Never write vague entries like "add tests for X" — name the specific functions and the cases.
3. **Remaining work** — Any follow-up tasks, known gaps, or edge cases? Add them to `TODO.md`. All tasks live there — never in `AGENTS.md`.
4. **AGENTS.md** — Does any new design decision, UX pattern, convention, or architectural fact need to be recorded here? Update in-place. Keep it free of task lists.
