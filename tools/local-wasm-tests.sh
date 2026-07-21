#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

if [ -s "$HOME/.nvm/nvm.sh" ]; then
    . "$HOME/.nvm/nvm.sh"
    if ! nvm use --lts >/dev/null 2>&1; then
        nvm install --lts --no-progress
        nvm use --lts >/dev/null
    fi
elif [ -s "$(brew --prefix nvm 2>/dev/null)/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    . "$(brew --prefix nvm)/nvm.sh"
    if ! nvm use --lts >/dev/null 2>&1; then
        nvm install --lts --no-progress
        nvm use --lts >/dev/null
    fi
elif ! command -v node >/dev/null 2>&1 || ! command -v pnpm >/dev/null 2>&1; then
    echo "node/pnpm not found and nvm is unavailable; install Node.js and pnpm" >&2
    exit 1
fi

FE_DIR="$REPO_ROOT/front-end"
WASM_DIR="$REPO_ROOT/wasm"
HUB_FRONTEND_DIR="$REPO_ROOT/hub/hub-frontend"

SKIP_BUILD=0
SKIP_NATIVE=0
# CI builds the wasm with --release; default here is --dev for fast local
# iteration.  Pass --release to reproduce CI's build profile (panic/optimization
# behavior differs, which matters for chasing CI-only failures).
WASM_PROFILE=--dev
for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=1 ;;
        --skip-native) SKIP_NATIVE=1 ;;
        --release) WASM_PROFILE=--release ;;
        --dev) WASM_PROFILE=--dev ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

cleanup() {
    if [ -n "$SIM_PID" ]; then
        kill "$SIM_PID" 2>/dev/null || true
        wait "$SIM_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT INT TERM

# macOS wasm32 clang workaround
if [ -x /opt/homebrew/opt/llvm/bin/clang ]; then
    export CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang
    export AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/llvm-ar
elif [ -x /usr/local/opt/llvm/bin/clang ]; then
    export CC_wasm32_unknown_unknown=/usr/local/opt/llvm/bin/clang
    export AR_wasm32_unknown_unknown=/usr/local/opt/llvm/bin/llvm-ar
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
    if [ "$SKIP_NATIVE" -eq 0 ]; then
        "$SCRIPT_DIR/build-chialisp.sh"
    fi

    echo "=== Building WASM (nodejs target for tests, profile $WASM_PROFILE) ==="
    (cd "$WASM_DIR" && wasm-pack build --out-dir="$FE_DIR/node-pkg" "$WASM_PROFILE" --target=nodejs)

    echo "=== Installing hub workspace deps ==="
    (cd "$REPO_ROOT/hub" && pnpm install --frozen-lockfile)
    echo "=== Building hub-frontend ==="
    (cd "$HUB_FRONTEND_DIR" && pnpm run build)

    echo "=== Installing gaming-fe deps ==="
    (cd "$FE_DIR" && pnpm install --frozen-lockfile)

    if [ "$SKIP_NATIVE" -eq 0 ]; then
        echo "=== Building simulator ==="
        cargo build --bin chia-gaming-sim --features sim-server
    fi
fi

echo "=== Running hub-service tests ==="
(cd "$REPO_ROOT/hub/hub-service" && pnpm run test)

# Use a per-run port so a browser connected to the development simulator cannot
# reconnect to the test simulator and submit transactions from unrelated state.
SIM_PORT="${CHIA_GAMING_SIM_PORT:-$((20000 + $$ % 20000))}"
export CHIA_GAMING_SIM_LISTEN_ADDR="[::]:$SIM_PORT"
export CHIA_GAMING_SIM_URL="http://127.0.0.1:$SIM_PORT"
export CHIA_GAMING_SIM_WS_URL="ws://127.0.0.1:$SIM_PORT/ws"

# Kill any stale simulator on our selected port before starting a fresh one.
lsof -ti:"$SIM_PORT" -sTCP:LISTEN | xargs kill 2>/dev/null || true
sleep 0.5

echo "=== Starting simulator ==="
SIM_BIN="${CARGO_TARGET_DIR:-$REPO_ROOT/target}/debug/chia-gaming-sim"
RUST_LOG=error "$SIM_BIN" &
SIM_PID=$!

echo "=== Waiting for simulator ==="
for i in $(seq 1 10); do
    if curl -s -X POST "$CHIA_GAMING_SIM_URL/health" >/dev/null 2>&1; then
        echo "Simulator ready"
        break
    fi
    sleep 1
done

if ! curl -s -X POST "$CHIA_GAMING_SIM_URL/health" >/dev/null 2>&1; then
    echo "Simulator failed to start"
    exit 1
fi

echo "=== Running tests ==="
cd "$FE_DIR"
if [[ "$(node --help)" == *"--no-experimental-webstorage"* ]]; then
    export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-experimental-webstorage"
fi
# We just guaranteed the sim is up; a "no sim" skip here would hide a broken
# harness, so make it a hard failure to match CI.
export LOAD_WASM_REQUIRE_SIM=1
pnpm run test
