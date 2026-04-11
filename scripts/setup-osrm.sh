#!/usr/bin/env bash
# Setup OSRM with Israel OSM data.
# Run once before starting docker compose.
# Requires Docker to be running.
set -euo pipefail

VOLUME=trempbot_osrm_data
OSM_URL="https://download.geofabrik.de/asia/israel-and-palestine-latest.osm.pbf"
OSM_FILE="israel-and-palestine-latest.osm.pbf"
IMAGE="osrm/osrm-backend:latest"

echo "Creating Docker volume '$VOLUME'..."
docker volume create "$VOLUME" 2>/dev/null || true

echo "Downloading Israel OSM data (~60 MB)..."
docker run --rm -v "${VOLUME}:/data" --entrypoint sh "$IMAGE" -c \
  "wget -q --show-progress -O /data/${OSM_FILE} ${OSM_URL}"

echo "Running OSRM extract..."
docker run --rm -v "${VOLUME}:/data" "$IMAGE" \
  osrm-extract -p /opt/car.lua /data/${OSM_FILE}

echo "Running OSRM partition..."
docker run --rm -v "${VOLUME}:/data" "$IMAGE" \
  osrm-partition /data/israel-and-palestine-latest.osrm

echo "Running OSRM customize..."
docker run --rm -v "${VOLUME}:/data" "$IMAGE" \
  osrm-customize /data/israel-and-palestine-latest.osrm

echo "Renaming to israel.osrm for docker-compose..."
docker run --rm -v "${VOLUME}:/data" --entrypoint sh "$IMAGE" -c \
  "for f in /data/israel-and-palestine-latest.osrm*; do mv \"\$f\" \"\${f/israel-and-palestine-latest/israel}\"; done"

echo ""
echo "Done! OSRM data is ready. Start the bot with:"
echo "  docker compose up -d"
