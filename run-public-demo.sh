#!/bin/bash
set -e
set -E

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FE_DIR="$SCRIPT_DIR/front-end"
WASM_DIR="$SCRIPT_DIR/wasm"
LOBBY_SERVICE_DIR="$SCRIPT_DIR/lobby/lobby-service"
LOBBY_FRONTEND_DIR="$SCRIPT_DIR/lobby/lobby-frontend"
CLSP_DIR="$SCRIPT_DIR/clsp"

GAME_PORT=${GAME_PORT:-3002}
TRACKER_PORT=${TRACKER_PORT:-3003}
SIM_PORT=${SIM_PORT:-5800}
SIM_WS_PORT=${SIM_WS_PORT:-5801}

SKIP_BUILD=0
FORCE_BUILD=0
PUBLIC_HOST=""
PIDS=()

for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=1 ;;
        --force-build) FORCE_BUILD=1 ;;
        --host=*) PUBLIC_HOST="${arg#--host=}" ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

if [ "$SKIP_BUILD" -eq 1 ] && [ "$FORCE_BUILD" -eq 1 ]; then
    echo "Error: --skip-build and --force-build are mutually exclusive"
    exit 1
fi

# ── Detect public host ───────────────────────────────────────────────

if [ -z "$PUBLIC_HOST" ]; then
    echo "=== Detecting public IP address ==="
    PUBLIC_HOST=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || true)
    if [ -z "$PUBLIC_HOST" ]; then
        # Fallback: LAN IP from default route interface
        if command -v ip >/dev/null 2>&1; then
            PUBLIC_HOST=$(ip route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src") print $(i+1)}' | head -1)
        fi
        if [ -z "$PUBLIC_HOST" ] && command -v ifconfig >/dev/null 2>&1; then
            PUBLIC_HOST=$(ifconfig | grep 'inet ' | grep -v '127.0.0.1' | head -1 | awk '{print $2}')
        fi
    fi
    if [ -z "$PUBLIC_HOST" ]; then
        echo "Error: could not detect public IP. Use --host=<ip-or-hostname>"
        exit 1
    fi
    echo "  Detected: $PUBLIC_HOST"
fi

SIM_URL="http://$PUBLIC_HOST:$SIM_PORT"

# Kill anything still listening on our ports from a previous run.
for p in $GAME_PORT $TRACKER_PORT $SIM_PORT $SIM_WS_PORT; do
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
    (cd "$WASM_DIR" && wasm-pack build --out-dir="$FE_DIR/dist" --dev --target=web)
    echo "=== Building gaming frontend ==="
    (cd "$FE_DIR" && pnpm install --frozen-lockfile && pnpm run build)
    echo "=== Building lobby-frontend ==="
    (cd "$SCRIPT_DIR/lobby" && pnpm install --frozen-lockfile)
    (cd "$LOBBY_FRONTEND_DIR" && pnpm run build)
    echo "=== Building lobby-service ==="
    (cd "$LOBBY_SERVICE_DIR" && pnpm run build)
fi

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
echo "{\"tracker\": \"http://$PUBLIC_HOST:$TRACKER_PORT\"}" > "$GAME_SERVE/urls"
ln -sf "$CLSP_DIR" "$GAME_SERVE/clsp"
if [ -d "$FE_DIR/public/images" ]; then
    ln -sf "$FE_DIR/public/images" "$GAME_SERVE/images"
fi

echo "=== Assembling lobby-frontend staging directory (symlinks) ==="
LOBBY_SERVE="$LOBBY_FRONTEND_DIR/serve"
rm -rf "$LOBBY_SERVE"
mkdir -p "$LOBBY_SERVE"
ln -sf "$LOBBY_FRONTEND_DIR/public/index.html" "$LOBBY_SERVE/index.html"
ln -sf "$LOBBY_FRONTEND_DIR/public/index.js" "$LOBBY_SERVE/index.js"
ln -sf "$LOBBY_FRONTEND_DIR/dist/css/index.css" "$LOBBY_SERVE/index.css"

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

echo "=== Starting player app static server (port $GAME_PORT, binding 0.0.0.0) ==="
node "$SCRIPT_DIR/local-static-test-server.js" "$GAME_SERVE" "$GAME_PORT" "0.0.0.0" &
PIDS+=($!)

echo "=== Starting tracker (lobby-service + lobby-frontend on port $TRACKER_PORT) ==="
(cd "$LOBBY_SERVICE_DIR" && PORT=$TRACKER_PORT exec node ./dist/index-rollup.cjs \
    --self "http://$PUBLIC_HOST:$TRACKER_PORT" \
    --sim "$SIM_URL" \
    --dir "$LOBBY_SERVE") &
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

echo ""
echo "════════════════════════════════════════════════════════"
echo "  All services running (public mode):"
echo ""
echo "    Player app: http://$PUBLIC_HOST:$GAME_PORT"
echo "    Tracker:    http://$PUBLIC_HOST:$TRACKER_PORT"
echo "    Simulator:  http://$PUBLIC_HOST:$SIM_PORT"
echo ""
echo "  Share this URL with other players:"
echo "    http://$PUBLIC_HOST:$GAME_PORT"
echo ""
echo "  Press Ctrl-C to stop all services."
echo "════════════════════════════════════════════════════════"
echo ""

while true; do
    sleep 3600
done
