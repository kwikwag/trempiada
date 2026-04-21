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
│   └── handlers.ts          # All bot commands + message routing
├── services/
│   ├── routing.ts           # OSRM client (route calc, detour estimation)
│   ├── matching.ts          # Core matching algorithm (driver↔rider)
│   └── car-recognition.ts   # Claude Vision for license plate/car extraction
└── utils/
    └── index.ts             # Formatting, geo helpers, code generation
```

## Key Design Decisions

- **Bot state machine**: Each Telegram user has a `SessionState` with a `scene` (current flow step) and `data` (temporary state). Sessions are in-memory; losing them on restart just restarts the user's current flow.
- **Matching algorithm**: Quick-filter candidates by haversine distance + time window, then OSRM detour calculation for accurate results. Ranked by least detour.
- **Points economy**: Rides are free. Drivers earn 2 pts (rating ≥4) or 1 pt (rating <4). Riders earn 0.5/0.2. New users get 5 pts. No real money touches the system.
- **Trust model**: Drivers must complete ≥1 verification. Each verification is stored in DB; drivers control which are _visible_ to riders vs just verified by the system.
- **Message relay**: During active rides, non-command messages forwarded between parties through the bot (no personal contact shared).
- **Anti-gaming**: Min 5km ride distance, same-pair 24h cooldown, cancellation tracking, simultaneous rating reveal.

## Environment Variables

```
BOT_TOKEN=           # Telegram bot token (required)
ANTHROPIC_API_KEY=   # For car photo analysis (required)
DATABASE_PATH=       # Default: ./data/rides.db
OSRM_URL=            # Default: http://localhost:5000
```

## TODO (priority order)

1. Geocoding service (text addresses → coordinates via Nominatim)
2. OAuth flows for social verification (Facebook, LinkedIn, Google)
3. Waze link parsing for route import
4. "Share ride" lightweight web page for safety
5. Hebrew localization (all bot strings)
6. Admin dashboard for dispute resolution
7. Ride expiry/cleanup (expire open rides past departure time)
8. Multiple passengers per ride (currently matches one rider at a time)

## Conventions

- All DB column names use snake_case; TypeScript properties use camelCase
- Row mappers in repository.ts handle the conversion
- All dates stored as ISO 8601 strings in SQLite
- Telegram file IDs stored for photos (not downloaded/stored locally)
- Points are REAL in SQLite (fractional values like 0.5)

# Agent Notes

- Also read `AGENTS.local.md` if it exists. It may contain machine-specific local setup.
