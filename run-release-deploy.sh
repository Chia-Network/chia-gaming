#!/bin/bash
# run-release-deploy.sh
#
# Download the chia-gaming release deploy artifacts from GitHub and run them
# locally. The release zips contain the raw build artifacts (dist/, public/,
# clsp/ for the player; service.js + dist/ + public/ for the lobby), so this
# script assembles the nonce-based runtime layout that index.html expects
# (build-meta.json + app/NONCE/...), mirroring run-local-demo.sh.
#
# Services started:
#   Player app  http://localhost:3002
#   Tracker     http://localhost:3003
#   Simulator   http://localhost:5800 (HTTP) / :5801 (WebSocket)
#
# Prerequisites:
#   - Node 20+  (node must be on PATH)
#   - gh CLI    (github.com/cli/cli)
#   - A built chia-gaming-sim binary (see Step 3 below)
#
# Usage:
#   ./run-release-deploy.sh [0.2.2]   # defaults to 0.2.2
#
# Press Ctrl-C to stop all services.

set -e
set -E

RELEASE_TAG="${1:-0.2.2}"
REPO="Chia-Network/chia-gaming"

GAME_PORT=${GAME_PORT:-3002}
TRACKER_PORT=${TRACKER_PORT:-3003}
SIM_PORT=5800
SIM_WS_PORT=5801

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORK_DIR="/tmp/chia-gaming-${RELEASE_TAG}"
GAME_STAGE="$WORK_DIR/player"
LOBBY_STAGE="$WORK_DIR/server"

PIDS=()

# ── Cleanup ──────────────────────────────────────────────────────────

cleanup() {
    echo ""
    echo "=== Stopping all services ==="
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    for pid in "${PIDS[@]}"; do
        wait "$pid" 2>/dev/null || true
    done
    echo "All services stopped."
}
trap cleanup EXIT

# Kill anything already listening on our ports from a previous run.
for p in $GAME_PORT $TRACKER_PORT $SIM_PORT $SIM_WS_PORT; do
    pids=$(lsof -ti:"$p" -sTCP:LISTEN 2>/dev/null || true)
    [ -n "$pids" ] && kill $pids 2>/dev/null || true
done
sleep 0.5

# ── Step 1: Download the release zips ────────────────────────────────

echo "=== Clearing $WORK_DIR ==="
rm -rf "$WORK_DIR"
mkdir -p "$WORK_DIR"

echo "=== Downloading release $RELEASE_TAG artifacts ==="
gh release download "$RELEASE_TAG" --repo "$REPO" \
    --pattern "chia-gaming-frontend.zip" \
    --pattern "chia-gaming-lobby.zip" \
    -D "$WORK_DIR"
echo "Downloaded: $(ls "$WORK_DIR")"

# ── Step 2: Extract raw artifacts ────────────────────────────────────
#
# The release zips wrap the build output in nested directories, e.g.
#   chia-gaming-frontend/chia-gaming-game/{dist,public,clsp}
#   chia-gaming-lobby/chia-gaming-lobby/{service.js,dist,public}
# We extract to scratch dirs and then locate the inner artifact roots.

FE_RAW="$WORK_DIR/_frontend_raw"
LO_RAW="$WORK_DIR/_lobby_raw"
rm -rf "$FE_RAW" "$LO_RAW"
mkdir -p "$FE_RAW" "$LO_RAW"

echo "=== Extracting player app artifacts ==="
unzip -q "$WORK_DIR/chia-gaming-frontend.zip" -d "$FE_RAW"

echo "=== Extracting tracker artifacts ==="
unzip -q "$WORK_DIR/chia-gaming-lobby.zip" -d "$LO_RAW"

# Locate the inner artifact roots (robust to the wrapper directory names).
GAME_SRC="$(dirname "$(find "$FE_RAW" -type f -path '*/dist/js/index-rollup.js' | head -1)")/../.."
GAME_SRC="$(cd "$GAME_SRC" && pwd)"
LOBBY_SRC="$(dirname "$(find "$LO_RAW" -type f -name 'service.js' | head -1)")"

if [ ! -d "$GAME_SRC/dist" ] || [ ! -d "$GAME_SRC/public" ]; then
    echo "ERROR: could not locate player app artifacts in the frontend zip"
    exit 1
fi
if [ ! -f "$LOBBY_SRC/service.js" ]; then
    echo "ERROR: could not locate service.js in the lobby zip"
    exit 1
fi

# ── Step 3: Assemble the player app staging tree ─────────────────────
#
# index.html fetches /build-meta.json, then loads index.css /
# chia_gaming_wasm.js / index.js relative to basePath (/app/NONCE/).

BUILD_NONCE=$(date +%s%3N)
echo "=== Build nonce: $BUILD_NONCE ==="

echo "=== Assembling player app -> $GAME_STAGE ==="
rm -rf "$GAME_STAGE"
GAME_NONCE_DIR="$GAME_STAGE/app/$BUILD_NONCE"
mkdir -p "$GAME_NONCE_DIR"

cp "$GAME_SRC/public/index.html" "$GAME_STAGE/index.html"
[ -f "$GAME_SRC/public/favicon.svg" ] && cp "$GAME_SRC/public/favicon.svg" "$GAME_STAGE/favicon.svg"
# static-server.js is not in the release zip; use the one from this checkout.
cp "$SCRIPT_DIR/static-server.js" "$GAME_STAGE/static-server.js"
echo "{\"basePath\":\"/app/$BUILD_NONCE/\"}" > "$GAME_STAGE/build-meta.json"

cp "$GAME_SRC/dist/js/index-rollup.js"       "$GAME_NONCE_DIR/index.js"
cp "$GAME_SRC/dist/css/index.css"            "$GAME_NONCE_DIR/index.css"
cp "$GAME_SRC/dist/chia_gaming_wasm.js"      "$GAME_NONCE_DIR/chia_gaming_wasm.js"
cp "$GAME_SRC/dist/chia_gaming_wasm_bg.wasm" "$GAME_NONCE_DIR/chia_gaming_wasm_bg.wasm"
cp -r "$GAME_SRC/clsp" "$GAME_NONCE_DIR/clsp"
[ -d "$GAME_SRC/public/images" ] && cp -r "$GAME_SRC/public/images" "$GAME_NONCE_DIR/images"

# Point the player app at the local tracker. In a production deployment this
# file would reference the deployed tracker URL instead.
echo "{\"tracker\": \"http://localhost:$TRACKER_PORT\"}" > "$GAME_NONCE_DIR/urls"

# ── Step 4: Assemble the tracker staging tree ────────────────────────

echo "=== Assembling tracker -> $LOBBY_STAGE ==="
rm -rf "$LOBBY_STAGE"
LOBBY_NONCE_DIR="$LOBBY_STAGE/app/$BUILD_NONCE"
mkdir -p "$LOBBY_NONCE_DIR"

cp "$LOBBY_SRC/public/index.html" "$LOBBY_STAGE/index.html"
cp "$LOBBY_SRC/service.js"        "$LOBBY_STAGE/service.js"
echo "{\"basePath\":\"/app/$BUILD_NONCE/\"}" > "$LOBBY_STAGE/build-meta.json"

cp "$LOBBY_SRC/public/index.js"   "$LOBBY_NONCE_DIR/index.js"
cp "$LOBBY_SRC/dist/css/index.css" "$LOBBY_NONCE_DIR/index.css"

# Scratch dirs no longer needed.
rm -rf "$FE_RAW" "$LO_RAW"

# ── Step 5: Simulator ─────────────────────────────────────────────────
#
# The simulator is a dev-only Rust binary not included in the release zips.
# To build it from a source checkout:
#   cargo build --features sim-server --bin chia-gaming-sim
# The binary lands at target/debug/chia-gaming-sim.

SIM_BIN=""
for candidate in \
    "$SCRIPT_DIR/target/debug/chia-gaming-sim" \
    "$SCRIPT_DIR/target/release/chia-gaming-sim" \
    "$WORK_DIR/target/debug/chia-gaming-sim" \
    "$WORK_DIR/target/release/chia-gaming-sim"; do
    if [ -x "$candidate" ]; then
        SIM_BIN="$candidate"
        break
    fi
done

if [ -z "$SIM_BIN" ]; then
    echo "ERROR: chia-gaming-sim binary not found. Build it first:"
    echo "  cargo build --features sim-server --bin chia-gaming-sim"
    exit 1
fi

echo "=== Starting simulator (port $SIM_PORT) using $SIM_BIN ==="
RUST_LOG=info "$SIM_BIN" &
PIDS+=($!)

echo "=== Waiting for simulator ==="
for i in $(seq 1 10); do
    if curl -s "http://localhost:$SIM_PORT/get_peak" >/dev/null 2>&1; then
        echo "Simulator ready"
        break
    fi
    sleep 1
done

if ! curl -s "http://localhost:$SIM_PORT/get_peak" >/dev/null 2>&1; then
    echo "ERROR: Simulator failed to start within 10 seconds"
    exit 1
fi

# ── Start player app static server ───────────────────────────────────

echo "=== Starting player app static server (port $GAME_PORT) ==="
node "$GAME_STAGE/static-server.js" "$GAME_STAGE" "$GAME_PORT" &
PIDS+=($!)

# ── Start tracker ─────────────────────────────────────────────────────

echo "=== Starting tracker (port $TRACKER_PORT) ==="
(cd "$LOBBY_STAGE" && PORT=$TRACKER_PORT exec node service.js \
    --self "http://localhost:$TRACKER_PORT" \
    --dir "$LOBBY_STAGE") &
PIDS+=($!)

# ── Wait for services ────────────────────────────────────────────────

echo "=== Waiting for services ==="
for i in $(seq 1 10); do
    if curl -s "http://localhost:$GAME_PORT/" >/dev/null 2>&1 && \
       curl -s "http://localhost:$TRACKER_PORT/" >/dev/null 2>&1; then
        echo "All servers ready"
        break
    fi
    sleep 1
done

echo ""
echo "════════════════════════════════════════════════════════"
echo "  All services running:"
echo "    Player app: http://localhost:$GAME_PORT"
echo "    Tracker:    http://localhost:$TRACKER_PORT"
echo "    Simulator:  http://localhost:$SIM_PORT"
echo ""
echo "  Extracted to:"
echo "    $GAME_STAGE"
echo "    $LOBBY_STAGE"
echo ""
echo "  Press Ctrl-C to stop all services."
echo "════════════════════════════════════════════════════════"
echo ""

while true; do
    sleep 3600
done
