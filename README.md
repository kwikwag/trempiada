# TrempiadaBot 🚗

A Telegram-based ridesharing bot for Israel that connects drivers with hitchhikers along their routes.

## Architecture

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Telegram   │◄───►│     Bot      │◄───►│   SQLite    │
│  Bot API    │     │  (Node.js)   │     │   Database  │
└─────────────┘     └──────┬───────┘     └─────────────┘
                           │
                    ┌──────┴───────┐
                    │              │
              ┌─────▼────┐  ┌─────▼──────┐
              │  OSRM    │  │  Claude    │
              │  (routes)│  │  (car OCR) │
              └──────────┘  └────────────┘
```

**Components:**

- **Telegram Bot** (Telegraf) — User interface, state machine per user
- **SQLite** (better-sqlite3) — Users, cars, rides, matches, ratings
- **OSRM** — Self-hosted route matching for Israel road network
- **Claude Vision API** — License plate + car detail extraction from photos

## Setup

### 1. Prerequisites

- Node.js 20+
- npm
- A Telegram bot token (from @BotFather)
- An Anthropic API key

### 2. Install

```bash
git clone <repo>
cd trempiada
npm install
```

### 3. Configure

```bash
cp .env.example .env
# Edit .env with your tokens
```

### 4. Set up OSRM (Israel routing)

```bash
# Download Israel map data
wget https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf

# Process for OSRM
osrm-extract -p /usr/share/osrm/profiles/car.lua israel-and-palestine-latest.osm.pbf
osrm-partition israel-and-palestine-latest.osrm
osrm-customize israel-and-palestine-latest.osrm

# Run OSRM server
osrm-routed --algorithm=MLD israel-and-palestine-latest.osrm --port 5000
```

Or use Docker:
```bash
docker run -t -v $(pwd):/data ghcr.io/project-osrm/osrm-backend \
  osrm-extract -p /opt/car.lua /data/israel-and-palestine-latest.osm.pbf
docker run -t -v $(pwd):/data ghcr.io/project-osrm/osrm-backend \
  osrm-partition /data/israel-and-palestine-latest.osrm
docker run -t -v $(pwd):/data ghcr.io/project-osrm/osrm-backend \
  osrm-customize /data/israel-and-palestine-latest.osrm
docker run -t -p 5000:5000 -v $(pwd):/data ghcr.io/project-osrm/osrm-backend \
  osrm-routed --algorithm mld /data/israel-and-palestine-latest.osrm
```

### 5. Run

```bash
# Initialize database
npm run migrate

# Development
npm run dev

# Production
npm run build
node dist/index.js
```

## Bot Commands

| Command   | Description                              |
|-----------|------------------------------------------|
| `/start`  | Register or welcome back                 |
| `/drive`  | Offer a ride (triggers car reg if needed)|
| `/ride`   | Request a ride                           |
| `/cancel` | Cancel active ride + reason              |
| `/trust`  | View/manage identity verifications       |
| `/status` | Check points balance and active ride     |
| `/sos`    | Emergency — logs event, shows helplines  |

## Points Economy

- Rides are free to request
- **Drivers** earn 2 pts (rating ≥4) or 1 pt (rating <4)
- **Riders** earn 0.5 pts (rating ≥4) or 0.2 pts (rating <4)
- New users start with **5 points**
- Riders can tip drivers from their balance
- Points will be redeemable with partner businesses (gas stations, etc.)

## Anti-Gaming

- Minimum ride distance: 5 km
- Same pair limited to 1 ride per 24 hours
- Frequent cancellations reduce match priority
- 3+ no-shows trigger account suspension
- Ratings are mutual and simultaneous (prevents retaliation)

## Trust & Safety

- Drivers must complete at least 1 identity verification
- Verifications: phone (auto), photo, car, Facebook, LinkedIn, Google, email
- Drivers choose which verifications are visible to riders
- Riders see a trust profile with verification badges + ratings
- Driver gender is displayed to riders
- License plates partially masked until ride is confirmed
- 4-digit confirmation code at pickup
- In-ride message relay (no personal contact shared)
- /sos command logs event without alerting the other party
- "Share ride with a friend" link for external safety

## Project Structure

```
src/
├── index.ts                 # Entry point
├── types/index.ts           # All type definitions + constants
├── db/
│   ├── migrate.ts           # Schema + initialization
│   └── repository.ts        # Data access layer
├── bot/
│   ├── session.ts           # In-memory session state machine
│   └── handlers.ts          # All bot command + message handlers
├── services/
│   ├── routing.ts           # OSRM client
│   ├── matching.ts          # Core matching algorithm
│   └── car-recognition.ts   # Claude Vision for plate/car extraction
└── utils/
    └── index.ts             # Formatting, geo helpers, code generation
```

## TODO

- [ ] Geocoding service (text addresses → coordinates)
- [ ] Waze link parsing for route import
- [ ] OAuth flows for social verification (Facebook, LinkedIn, Google)
- [ ] "Share ride" web page for safety
- [ ] Admin dashboard for dispute resolution and account suspension management
- [ ] Push notification tuning
- [ ] Rate limiting and abuse detection refinements
- [ ] Hebrew localization
