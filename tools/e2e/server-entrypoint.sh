#!/bin/bash
set -euo pipefail

SIM_BIN="${SIM_BIN:-/usr/local/bin/chia-gaming-sim}"
PLAYER_DIR="${PLAYER_DIR:-/opt/player}"
TRACKER_DIR="${TRACKER_DIR:-/opt/tracker}"
GAME_PORT="${GAME_PORT:-3002}"
TRACKER_PORT="${TRACKER_PORT:-3003}"
TRACKER_SELF="${TRACKER_SELF:-http://server:3003}"

PIDS=()

cleanup() {
  for pid in "${PIDS[@]}"; do
    kill "$pid" 2>/dev/null || true
  done
  for pid in "${PIDS[@]}"; do
    wait "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT

echo "=== Starting simulator (port 5800) ==="
RUST_LOG="${RUST_LOG:-error}" "$SIM_BIN" &
PIDS+=($!)

for i in $(seq 1 30); do
  if curl -sf -X POST "http://127.0.0.1:5800/get_peak" >/dev/null 2>&1; then
    echo "Simulator ready"
    break
  fi
  sleep 1
done
if ! curl -sf -X POST "http://127.0.0.1:5800/get_peak" >/dev/null 2>&1; then
  echo "Simulator failed to start within 30 seconds"
  exit 1
fi

echo "=== Starting player app (port $GAME_PORT) ==="
node "$PLAYER_DIR/static-server.js" "$PLAYER_DIR" "$GAME_PORT" 0.0.0.0 &
PIDS+=($!)

echo "=== Starting tracker (port $TRACKER_PORT) ==="
PORT="$TRACKER_PORT" node "$TRACKER_DIR/service.js" \
  --self "$TRACKER_SELF" \
  --dir "$TRACKER_DIR" &
PIDS+=($!)

for i in $(seq 1 30); do
  if curl -sf "http://127.0.0.1:${GAME_PORT}/" >/dev/null 2>&1 \
     && curl -sf "http://127.0.0.1:${TRACKER_PORT}/" >/dev/null 2>&1; then
    echo "All servers ready"
    break
  fi
  sleep 1
done

if ! curl -sf "http://127.0.0.1:${GAME_PORT}/" >/dev/null 2>&1 \
   || ! curl -sf "http://127.0.0.1:${TRACKER_PORT}/" >/dev/null 2>&1; then
  echo "Player or tracker failed to start within 30 seconds"
  exit 1
fi

echo "=== Server stack running ==="
while true; do sleep 3600; done
