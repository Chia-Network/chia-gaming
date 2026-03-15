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

# ── Incremental build helpers ─────────────────────────────────────────

# Returns 0 (needs build) if any file under the watched dirs is newer
# than the stamp file, or if the stamp doesn't exist yet.
needs_build() {
    local stamp="$1"; shift
    [ ! -f "$stamp" ] && return 0
    for dir in "$@"; do
        if [ -f "$dir" ]; then
            [ "$dir" -nt "$stamp" ] && return 0
        elif [ -d "$dir" ]; then
            if find "$dir" -newer "$stamp" -print -quit 2>/dev/null | grep -q .; then
                return 0
            fi
        fi
    done
    return 1
}

# ── Build (skip with --skip-build) ──────────────────────────────────

if [ "$SKIP_BUILD" -eq 0 ]; then
    echo "=== Building simulator + chialisp (if needed) ==="
    cargo build --features sim-tests,sim-server --bin chia-gaming-sim

    WASM_STAMP="$FE_DIR/dist/.wasm-stamp"
    if needs_build "$WASM_STAMP" "$WASM_DIR/src" "$WASM_DIR/Cargo.toml" "$SCRIPT_DIR/src" "$SCRIPT_DIR/Cargo.toml"; then
        echo "=== Building WASM (web target) ==="
        (cd "$WASM_DIR" && wasm-pack build --out-dir="$FE_DIR/dist" --release --target=web)
        touch "$WASM_STAMP"
    else
        echo "=== WASM is up to date ==="
    fi

    if needs_build "$LOBBY_CONN_DIR/dist/.build-stamp" "$LOBBY_CONN_DIR/src" "$LOBBY_CONN_DIR/package.json"; then
        echo "=== Building lobby-connection ==="
        (cd "$LOBBY_CONN_DIR" && yarn install && yarn build)
        touch "$LOBBY_CONN_DIR/dist/.build-stamp"
    else
        echo "=== lobby-connection is up to date ==="
    fi

    if needs_build "$FE_DIR/dist/.fe-stamp" "$FE_DIR/src" "$FE_DIR/package.json" "$WASM_STAMP"; then
        echo "=== Building gaming frontend ==="
        (cd "$FE_DIR" && yarn install && yarn build)
        touch "$FE_DIR/dist/.fe-stamp"
    else
        echo "=== gaming-fe is up to date ==="
    fi

    if needs_build "$LOBBY_VIEW_DIR/dist/.build-stamp" "$LOBBY_VIEW_DIR/src" "$LOBBY_VIEW_DIR/package.json"; then
        echo "=== Building lobby-view ==="
        (cd "$LOBBY_VIEW_DIR" && yarn install && yarn build)
        touch "$LOBBY_VIEW_DIR/dist/.build-stamp"
    else
        echo "=== lobby-view is up to date ==="
    fi

    if needs_build "$LOBBY_SERVICE_DIR/dist/.build-stamp" "$LOBBY_SERVICE_DIR/src" "$LOBBY_SERVICE_DIR/package.json"; then
        echo "=== Building lobby-service ==="
        (cd "$LOBBY_SERVICE_DIR" && yarn install && yarn build)
        touch "$LOBBY_SERVICE_DIR/dist/.build-stamp"
    else
        echo "=== lobby-service is up to date ==="
    fi

    if needs_build "$WC_DIR/dist/.build-stamp" "$WC_DIR/src" "$WC_DIR/package.json"; then
        echo "=== Building wc-stub ==="
        (cd "$WC_DIR" && yarn install && yarn build)
        touch "$WC_DIR/dist/.build-stamp"
    else
        echo "=== wc-stub is up to date ==="
    fi
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
(cd "$WC_DIR" && PORT=$WC_PORT node --disable-warning=DEP0169 ./dist/index.js) &
PIDS+=($!)

echo "=== Starting lobby-service (port $LOBBY_SERVICE_PORT) ==="
(cd "$LOBBY_SERVICE_DIR" && PORT=$LOBBY_SERVICE_PORT node ./dist/index-rollup.cjs --self "http://localhost:$LOBBY_PORT") &
PIDS+=($!)

echo "=== Waiting for static file server ==="
for i in $(seq 1 10); do
    if curl -s "http://localhost:$LOBBY_PORT/" >/dev/null 2>&1; then
        echo "Static file server ready"
        break
    fi
    sleep 1
done

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
echo "  Press any key (or Ctrl-C) to stop all services."
echo "════════════════════════════════════════════════════════"
echo ""

read -r -s -n 1
