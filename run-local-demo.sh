#!/bin/bash
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
TRACKER_PORT=${TRACKER_PORT:-3003}
WC_PORT=${WC_PORT:-3004}
SIM_PORT=${SIM_PORT:-5800}
SIM_WS_PORT=${SIM_WS_PORT:-5801}

SKIP_BUILD=0
FORCE_BUILD=0
PIDS=()

for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=1 ;;
        --force-build) FORCE_BUILD=1 ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

if [ "$SKIP_BUILD" -eq 1 ] && [ "$FORCE_BUILD" -eq 1 ]; then
    echo "Error: --skip-build and --force-build are mutually exclusive"
    exit 1
fi

# Kill anything still listening on our ports from a previous run.
# Use -sTCP:LISTEN to avoid killing browsers that have connections to these ports.
for p in $GAME_PORT $TRACKER_PORT $WC_PORT $SIM_PORT $SIM_WS_PORT; do
    pids=$(lsof -ti:"$p" -sTCP:LISTEN 2>/dev/null || true)
    [ -n "$pids" ] && kill $pids 2>/dev/null || true
done
sleep 0.5

cleanup() {
    echo ""
    echo "=== Stopping all services ==="
    for pid in "${PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
    done
    kill $(lsof -i -n -P | grep LISTEN | grep :$WC_PORT | awk '{print $2}') 2>/dev/null || true
    for pid in "${PIDS[@]}"; do
        wait "$pid" 2>/dev/null || true
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

# ── Build (skip with --skip-build, force with --force-build) ────────

if [ "$FORCE_BUILD" -eq 1 ]; then
    echo "=== --force-build: clearing Rust and JS build caches ==="
    cargo clean 2>/dev/null || true
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
    echo "=== Building simulator + chialisp (if needed) ==="
    cargo build --features sim-server --bin chia-gaming-sim
    echo "=== Building WASM (web target) ==="
    (cd "$WASM_DIR" && wasm-pack build --out-dir="$FE_DIR/dist" --release --target=web)
    echo "=== Building lobby-connection ==="
    (cd "$LOBBY_CONN_DIR" && yarn install --frozen-lockfile && yarn build)
    echo "=== Building gaming frontend ==="
    (cd "$FE_DIR" && yarn install --frozen-lockfile && yarn build)
    echo "=== Building lobby-view ==="
    (cd "$LOBBY_VIEW_DIR" && yarn install --frozen-lockfile && yarn build)
    echo "=== Building lobby-service ==="
    (cd "$LOBBY_SERVICE_DIR" && yarn install --frozen-lockfile && yarn build)
    echo "=== Building wc-stub ==="
    (cd "$WC_DIR" && yarn install --frozen-lockfile && yarn build)
i

# ── Assemble staging directories ────────────────────────────────────

echo "=== Assembling player app staging directory (symlinks) ==="
GAME_SERVE="$FE_DIR/serve"
rm -rf "$GAME_SERVE"
mkdir -p "$GAME_SERVE"
ln -sf "$FE_DIR/public/index.html" "$GAME_SERVE/index.html"
if [ -f "$FE_DIR/public/favicon.svg" ]; then
    ln -sf "$FE_DIR/public/favicon.svg" "$GAME_SERVE/favicon.svg"
fi
ln -sf "$FE_DIR/dist/js/index-rollup.js" "$GAME_SERVE/index.js"
ln -sf "$FE_DIR/dist/css/index.css" "$GAME_SERVE/index.css"
ln -sf "$FE_DIR/dist/chia_gaming_wasm.js" "$GAME_SERVE/chia_gaming_wasm.js"
ln -sf "$FE_DIR/dist/chia_gaming_wasm_bg.wasm" "$GAME_SERVE/chia_gaming_wasm_bg.wasm"
echo '{"version":3,"sources":[],"mappings":""}' > "$GAME_SERVE/chia_gaming_wasm_bg.wasm.map"
# Static urls config for the player app
echo "{\"tracker\": \"http://localhost:$TRACKER_PORT\"}" > "$GAME_SERVE/urls"
# Symlink chialisp hex files
ln -sf "$CLSP_DIR" "$GAME_SERVE/clsp"
# Symlink images if they exist
if [ -d "$FE_DIR/public/images" ]; then
    ln -sf "$FE_DIR/public/images" "$GAME_SERVE/images"
fi

echo "=== Assembling lobby-view staging directory (symlinks) ==="
LOBBY_SERVE="$LOBBY_VIEW_DIR/serve"
rm -rf "$LOBBY_SERVE"
mkdir -p "$LOBBY_SERVE"
ln -sf "$LOBBY_VIEW_DIR/public/index.html" "$LOBBY_SERVE/index.html"
ln -sf "$LOBBY_VIEW_DIR/public/index.js" "$LOBBY_SERVE/index.js"
ln -sf "$LOBBY_VIEW_DIR/dist/css/index.css" "$LOBBY_SERVE/index.css"

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

echo "=== Starting player app static server (port $GAME_PORT) ==="
node "$SCRIPT_DIR/resources/static-server.js" "$GAME_SERVE" "$GAME_PORT" &
PIDS+=($!)

echo "=== Starting wc-stub (port $WC_PORT) ==="
(cd "$WC_DIR" && PORT=$WC_PORT exec node --disable-warning=DEP0169 ./dist/index.js) &
PIDS+=($!)

echo "=== Starting tracker (lobby-service + lobby-view on port $TRACKER_PORT) ==="
(cd "$LOBBY_SERVICE_DIR" && PORT=$TRACKER_PORT exec node ./dist/index-rollup.cjs --self "http://localhost:$TRACKER_PORT" --dir "$LOBBY_SERVE") &
PIDS+=($!)

echo "=== Waiting for services ==="
for i in $(seq 1 10); do
    if curl -s "http://localhost:$GAME_PORT/" >/dev/null 2>&1 && \
       curl -s "http://localhost:$TRACKER_PORT/" >/dev/null 2>&1; then
        echo "All servers ready"
        break
    fi
    sleep 1
done

echo "=== Starting beacon ==="
"$SCRIPT_DIR/resources/nginx/beacon.sh" "http://localhost:$GAME_PORT" "http://localhost:$TRACKER_PORT" &
PIDS+=($!)

echo ""
echo "════════════════════════════════════════════════════════"
echo "  All services running:"
echo "    Player app (static): http://localhost:$GAME_PORT"
echo "    Tracker:             http://localhost:$TRACKER_PORT"
echo "    WC stub:             http://localhost:$WC_PORT"
echo "    Simulator:           http://localhost:$SIM_PORT"
echo ""
echo "  Press any key (or Ctrl-C) to stop all services."
echo "════════════════════════════════════════════════════════"
echo ""

read -r -s -n 1
