#!/bin/bash
set -x
set -e
set -E

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FE_DIR="$SCRIPT_DIR/resources/gaming-fe"
WASM_DIR="$SCRIPT_DIR/wasm"
LOBBY_SERVICE_DIR="$SCRIPT_DIR/resources/lobby-service"
LOBBY_VIEW_DIR="$SCRIPT_DIR/resources/lobby-view"
LOBBY_CONN_DIR="$SCRIPT_DIR/resources/lobby-connection"
WC_DIR="$SCRIPT_DIR/resources/wc-stub"
CLSP_DIR="$SCRIPT_DIR/clsp"

GAME_PORT=${GAME_PORT:-3002}
LOBBY_PORT=${LOBBY_PORT:-3003}
WC_PORT=${WC_PORT:-3004}
SIM_PORT=${SIM_PORT:-5800}
LOBBY_SERVICE_PORT=${LOBBY_SERVICE_PORT:-5801}

SKIP_BUILD=0
PIDS=()

for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=1 ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

# Kill anything still listening on our ports from a previous run.
for p in $GAME_PORT $LOBBY_PORT $WC_PORT $SIM_PORT $LOBBY_SERVICE_PORT; do
    pids=$(lsof -ti:"$p" 2>/dev/null || true)
    [ -n "$pids" ] && kill $pids 2>/dev/null || true
done
sleep 0.5

cleanup() {
    echo ""
    echo "=== Stopping all services ==="
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    echo "All services stopped."
}
trap cleanup EXIT

# ── Pre-flight checks ───────────────────────────────────────────────

# macOS wasm32 clang workaround
if [ -x /opt/homebrew/opt/llvm/bin/clang ]; then
    export CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang
    export AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/llvm-ar
elif [ -x /usr/local/opt/llvm/bin/clang ]; then
    export CC_wasm32_unknown_unknown=/usr/local/opt/llvm/bin/clang
    export AR_wasm32_unknown_unknown=/usr/local/opt/llvm/bin/llvm-ar
fi

# ── Build (skip with --skip-build) ──────────────────────────────────

if [ "$SKIP_BUILD" -eq 0 ]; then
    echo "=== Building WASM (web target) ==="
    (cd "$WASM_DIR" && wasm-pack build --out-dir="$FE_DIR/dist" --release --target=web)

    echo "=== Building lobby-connection ==="
    (cd "$LOBBY_CONN_DIR" && yarn install && yarn build)

    echo "=== Building gaming frontend ==="
    (cd "$FE_DIR" && yarn install && yarn build)

    echo "=== Building lobby-view ==="
    (cd "$LOBBY_VIEW_DIR" && yarn install && yarn build)

    echo "=== Building lobby-service ==="
    (cd "$LOBBY_SERVICE_DIR" && yarn install && yarn build)

    echo "=== Building wc-stub ==="
    (cd "$WC_DIR" && yarn install && yarn build)

    echo "=== Building simulator ==="
    cargo build --features sim-tests,sim-server --bin chia-gaming-sim
fi

# Generate the urls file with the actual lobby port
echo "{\"tracker\": \"http://localhost:$LOBBY_PORT/?lobby=true\"}" > "$FE_DIR/dist/urls"

# ── Start services ──────────────────────────────────────────────────

echo "=== Starting simulator (port $SIM_PORT) ==="
SIM_BIN="${CARGO_TARGET_DIR:-$SCRIPT_DIR/target}/debug/chia-gaming-sim"
RUST_LOG=debug "$SIM_BIN" &
PIDS+=($!)

echo "=== Waiting for simulator ==="
for i in $(seq 1 5); do
    if curl -s -X POST "http://localhost:$SIM_PORT/get_peak" >/dev/null 2>&1; then
        echo "Simulator ready"
        break
    fi
    sleep 1
done

if ! curl -s -X POST "http://localhost:$SIM_PORT/get_peak" >/dev/null 2>&1; then
    echo "Simulator failed to start within 5 seconds"
    exit 1
fi

echo "=== Starting static file server (ports $GAME_PORT, $LOBBY_PORT) ==="
node "$SCRIPT_DIR/resources/local-server.js" "$SCRIPT_DIR" "$GAME_PORT" "$LOBBY_PORT" &
PIDS+=($!)

echo "=== Starting wc-stub (port $WC_PORT) ==="
(cd "$WC_DIR" && PORT=$WC_PORT node ./dist/index.js) &
PIDS+=($!)

echo "=== Starting lobby-service (port $LOBBY_SERVICE_PORT) ==="
(cd "$LOBBY_SERVICE_DIR" && PORT=$LOBBY_SERVICE_PORT node ./dist/index-rollup.cjs --self "http://localhost:$LOBBY_PORT") &
PIDS+=($!)

echo "=== Starting beacon ==="
"$SCRIPT_DIR/resources/nginx/beacon.sh" "http://localhost:$GAME_PORT" "http://localhost:$LOBBY_PORT" &
PIDS+=($!)

echo ""
echo "════════════════════════════════════════════════════════"
echo "  All services running:"
echo "    Game frontend:  http://localhost:$GAME_PORT"
echo "    Lobby view:     http://localhost:$LOBBY_PORT"
echo "    WC stub:        http://localhost:$WC_PORT"
echo "    Simulator:      http://localhost:$SIM_PORT"
echo ""
echo "  Press Ctrl-C to stop all services."
echo "════════════════════════════════════════════════════════"
echo ""

# Wait for any child to exit (or Ctrl-C)
wait
