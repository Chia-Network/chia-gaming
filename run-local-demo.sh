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

SKIP_BUILD=0
FORCE_BUILD=0
PIDS=()
CLEANED_UP=0

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

stop_processes() {
    local label=$1
    shift
    local pids=("$@")
    [ "${#pids[@]}" -eq 0 ] && return

    for pid in "${pids[@]}"; do
        kill -TERM "$pid" 2>/dev/null || true
    done

    for _ in $(seq 1 50); do
        local running=0
        for pid in "${pids[@]}"; do
            if kill -0 "$pid" 2>/dev/null; then
                running=1
                break
            fi
        done
        [ "$running" -eq 0 ] && break
        sleep 0.1
    done

    local forced=0
    for pid in "${pids[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            kill -KILL "$pid" 2>/dev/null || true
            forced=1
        fi
    done
    [ "$forced" -eq 0 ] || echo "Forced remaining $label to stop."

    for pid in "${pids[@]}"; do
        wait "$pid" 2>/dev/null || true
    done
}

cleanup() {
    [ "$CLEANED_UP" -eq 0 ] || return
    CLEANED_UP=1
    echo ""
    echo "=== Stopping all services ==="
    stop_processes "services" "${PIDS[@]}"
    echo "All services stopped."
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

# ── Pre-flight checks ───────────────────────────────────────────────

if ! command -v wasm-pack &>/dev/null; then
    echo "=== Installing wasm-pack ==="
    case "$(uname -s)" in
        Linux*)  cargo install wasm-pack ;;
        Darwin*) brew install wasm-pack ;;
        *)       echo "Unsupported OS for automatic wasm-pack install"; exit 1 ;;
    esac
fi

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
    ./tools/build-chialisp.sh
    echo "=== Building WASM (web target) ==="
    (cd "$WASM_DIR" && wasm-pack build --out-dir="$FE_DIR/dist" --dev --target=web)
    echo "=== Building gaming frontend ==="
    (cd "$FE_DIR" && pnpm install --frozen-lockfile && pnpm run build)
    echo "=== Building lobby-frontend ==="
    (cd "$SCRIPT_DIR/lobby" && pnpm install --frozen-lockfile --ignore-scripts)
    (cd "$LOBBY_FRONTEND_DIR" && pnpm run build)
    echo "=== Building lobby-service ==="
    (cd "$LOBBY_SERVICE_DIR" && pnpm run build)
fi

# ── Assemble staging directories ────────────────────────────────────

# Portable millisecond nonce. macOS `date +%s%3N` leaves a literal "3N".
if command -v python3 >/dev/null 2>&1; then
  BUILD_NONCE=$(python3 -c 'import time; print(int(time.time() * 1000))')
else
  BUILD_NONCE=$(node -e 'process.stdout.write(String(Date.now()))')
fi
echo "=== Build nonce: $BUILD_NONCE ==="

echo "=== Assembling player app staging directory ==="
GAME_SERVE="$FE_DIR/serve"
# Write the new nonce tree first, flip build-meta, then prune old nonces so a
# running static server never serves a half-deleted deploy.
mkdir -p "$GAME_SERVE/app/$BUILD_NONCE"
cp "$FE_DIR/public/index.html" "$GAME_SERVE/index.html"
if [ -f "$FE_DIR/public/favicon.svg" ]; then
    cp "$FE_DIR/public/favicon.svg" "$GAME_SERVE/favicon.svg"
fi
GAME_NONCE_DIR="$GAME_SERVE/app/$BUILD_NONCE"
cp "$FE_DIR/dist/js/index-rollup.js" "$GAME_NONCE_DIR/index.js"
cp "$FE_DIR/dist/js/index-rollup.js.map" "$GAME_NONCE_DIR/index-rollup.js.map"
cp "$FE_DIR/dist/css/index.css" "$GAME_NONCE_DIR/index.css"
cp "$FE_DIR/dist/chia_gaming_wasm.js" "$GAME_NONCE_DIR/chia_gaming_wasm.js"
cp "$FE_DIR/dist/chia_gaming_wasm_bg.wasm" "$GAME_NONCE_DIR/chia_gaming_wasm_bg.wasm"
echo '{"version":3,"sources":[],"mappings":""}' > "$GAME_NONCE_DIR/chia_gaming_wasm_bg.wasm.map"
echo "{\"tracker\": \"http://localhost:$TRACKER_PORT\"}" > "$GAME_NONCE_DIR/urls"
(cd "$CLSP_DIR" && find . \( -name '*.hex' -o -name '*.dat' \) | while read -r f; do
    mkdir -p "$GAME_NONCE_DIR/clsp/$(dirname "$f")"
    cp "$f" "$GAME_NONCE_DIR/clsp/$f"
done)
if [ -d "$FE_DIR/public/images" ]; then
    cp -r "$FE_DIR/public/images" "$GAME_NONCE_DIR/images"
fi
echo "{\"basePath\":\"/app/$BUILD_NONCE/\"}" > "$GAME_SERVE/build-meta.json"
for old in "$GAME_SERVE/app"/*; do
    [ -d "$old" ] || continue
    [ "$(basename "$old")" = "$BUILD_NONCE" ] && continue
    rm -rf "$old"
done

echo "=== Assembling lobby-frontend staging directory ==="
LOBBY_SERVE="$LOBBY_FRONTEND_DIR/serve"
mkdir -p "$LOBBY_SERVE/app/$BUILD_NONCE"
cp "$LOBBY_FRONTEND_DIR/public/index.html" "$LOBBY_SERVE/index.html"
LOBBY_NONCE_DIR="$LOBBY_SERVE/app/$BUILD_NONCE"
cp "$LOBBY_FRONTEND_DIR/public/index.js" "$LOBBY_NONCE_DIR/index.js"
cp "$LOBBY_FRONTEND_DIR/dist/css/index.css" "$LOBBY_NONCE_DIR/index.css"
echo "{\"basePath\":\"/app/$BUILD_NONCE/\"}" > "$LOBBY_SERVE/build-meta.json"
for old in "$LOBBY_SERVE/app"/*; do
    [ -d "$old" ] || continue
    [ "$(basename "$old")" = "$BUILD_NONCE" ] && continue
    rm -rf "$old"
done

# ── Start services ──────────────────────────────────────────────────

# Keep the previous stack available while building and staging so already-open
# browser pages do not accumulate reconnect backoff during a long build.
# Use -sTCP:LISTEN to avoid killing the browsers themselves.
echo "=== Stopping previous services ==="
PREVIOUS_PIDS=()
for p in $GAME_PORT $TRACKER_PORT $SIM_PORT; do
    pids=$(lsof -ti:"$p" -sTCP:LISTEN 2>/dev/null || true)
    if [ -n "$pids" ]; then
        PREVIOUS_PIDS+=($pids)
    fi
done
stop_processes "previous services" "${PREVIOUS_PIDS[@]}"

echo "=== Starting simulator (port $SIM_PORT) ==="
SIM_BIN="${CARGO_TARGET_DIR:-$SCRIPT_DIR/target}/debug/chia-gaming-sim"
RUST_LOG=debug "$SIM_BIN" &
PIDS+=($!)

echo "=== Waiting for simulator ==="
for i in $(seq 1 5); do
    if curl -s -X POST "http://localhost:$SIM_PORT/health" >/dev/null 2>&1; then
        echo "Simulator ready"
        break
    fi
    sleep 1
done

if ! curl -s -X POST "http://localhost:$SIM_PORT/health" >/dev/null 2>&1; then
    echo "Simulator failed to start within 5 seconds"
    exit 1
fi

echo "=== Starting player app static server (port $GAME_PORT) ==="
node "$SCRIPT_DIR/static-server.js" "$GAME_SERVE" "$GAME_PORT" &
PIDS+=($!)

echo "=== Starting tracker (lobby-service + lobby-frontend on port $TRACKER_PORT) ==="
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

echo ""
echo "════════════════════════════════════════════════════════"
echo "  All services running:"
echo "    Player app: http://localhost:$GAME_PORT"
echo "    Tracker:    http://localhost:$TRACKER_PORT"
echo "    Simulator:  http://localhost:$SIM_PORT"
echo ""
echo "  Press Ctrl-C to stop all services."
echo "════════════════════════════════════════════════════════"
echo ""

while true; do
    sleep 3600
done
