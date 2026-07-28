#!/bin/bash
# Run the staged production player app and hub services.
#
# Must be run after ./tools/stage-production.sh. Press Ctrl-C to stop both.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

GAME_PORT="${GAME_PORT:-3002}"
HUB_PORT="${HUB_PORT:-3003}"
HOST="${HOST:-127.0.0.1}"

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

echo "=== Starting player app on http://$HOST:$GAME_PORT ==="
node "$PLAYER_STAGE/static-server.js" "$PLAYER_STAGE" "$GAME_PORT" "$HOST" &
PIDS+=($!)

echo "=== Starting hub on http://$HOST:$HUB_PORT ==="
PORT="$HUB_PORT" node "$HUB_STAGE/service.js" \
    --self "http://$HOST:$HUB_PORT" \
    --dir "$HUB_STAGE" &
PIDS+=($!)

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Player app: http://$HOST:$GAME_PORT"
echo "  Hub:        http://$HOST:$HUB_PORT"
echo ""
echo "  Press Ctrl-C to stop both services."
echo "════════════════════════════════════════════════════════"

wait
