#!/bin/bash
# Run the staged production player app and hub services.
#
# Must be run after ./tools/stage-production.sh. Press Ctrl-C to stop both.
# PLAYER_PATH=/player/ HUB_PATH=/hub/ selects independent directory mounts.
# For access from another machine, set HOST=0.0.0.0 and PUBLIC_HOST to this
# machine's reachable hostname or IP address.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GAME_PORT="${GAME_PORT:-3002}"
HUB_PORT="${HUB_PORT:-3003}"
HOST="${HOST:-127.0.0.1}"
PUBLIC_HOST="${PUBLIC_HOST:-$HOST}"

normalize_path() {
    node -e '
const value = process.argv[1];
const url = new URL(value, "http://mount.invalid");
if (url.origin !== "http://mount.invalid" || url.pathname !== value || url.search || url.hash) {
    throw new Error("Mount paths must be absolute URL paths without dot segments, queries, or fragments");
}
process.stdout.write(value.replace(/\/+$/, "") + "/");
' "$1"
}
PLAYER_PATH=$(normalize_path "${PLAYER_PATH:-/}")
HUB_PATH=$(normalize_path "${HUB_PATH:-/}")
PLAYER_URL="http://$PUBLIC_HOST:$GAME_PORT$PLAYER_PATH"
HUB_URL="http://$PUBLIC_HOST:$HUB_PORT$HUB_PATH"

PLAYER_STAGE="${PLAYER_STAGE:-$ROOT_DIR/.stage-player}"
HUB_STAGE="${HUB_STAGE:-$ROOT_DIR/.stage-hub}"

if [ ! -d "$PLAYER_STAGE" ] || [ ! -d "$HUB_STAGE" ]; then
    echo "Staging directories missing. Run ./tools/stage-production.sh first."
    exit 1
fi

if [ ! -f "$PLAYER_STAGE/static-server.js" ]; then
    echo "ERROR: player stage is missing static-server.js"
    exit 1
fi

if [ ! -f "$HUB_STAGE/service.js" ]; then
    echo "ERROR: hub stage is missing service.js"
    exit 1
fi

PIDS=()
CLEANED_UP=0

cleanup() {
    [ "$CLEANED_UP" -eq 0 ] || return
    CLEANED_UP=1
    echo ""
    echo "=== Stopping services ==="
    for pid in "${PIDS[@]}"; do
        kill -TERM "$pid" 2>/dev/null || true
    done

    for _ in $(seq 1 50); do
        local running=0
        for pid in "${PIDS[@]}"; do
            if kill -0 "$pid" 2>/dev/null; then
                running=1
                break
            fi
        done
        [ "$running" -eq 0 ] && break
        sleep 0.1
    done

    local forced=0
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -KILL "$pid" 2>/dev/null || true
            forced=1
        fi
    done
    [ "$forced" -eq 0 ] || echo "Forced remaining services to stop."

    for pid in "${PIDS[@]}"; do
        wait "$pid" 2>/dev/null || true
    done
}
trap cleanup EXIT INT TERM

echo "=== Starting player app on $PLAYER_URL ==="
node "$PLAYER_STAGE/static-server.js" "$PLAYER_STAGE" "$GAME_PORT" "$HOST" "$PLAYER_PATH" &
PIDS+=($!)

echo "=== Starting hub on $HUB_URL ==="
PORT="$HUB_PORT" node "$HUB_STAGE/service.js" \
    --self "$HUB_URL" \
    --dir "$HUB_STAGE" \
    --redirect-html-to "$PLAYER_URL" &
PIDS+=($!)

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Player app: $PLAYER_URL"
echo "  Hub:        $HUB_URL"
echo ""
echo "  Press Ctrl-C to stop both services."
echo "════════════════════════════════════════════════════════"

wait
