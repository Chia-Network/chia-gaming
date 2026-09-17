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
    for pid in "${WASM_PIDS[@]}"; do
        kill "$pid" 2>/dev/null || true
        wait "$pid" 2>/dev/null || true
    done
    if [ -n "$HUB_TEST_PID" ]; then
        kill "$HUB_TEST_PID" 2>/dev/null || true
        wait "$HUB_TEST_PID" 2>/dev/null || true
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

    echo "=== Installing JavaScript workspace deps ==="
    pnpm install --frozen-lockfile
    echo "=== Building hub-frontend ==="
    pnpm --filter chia-gaming-hub-frontend run build

    if [ "$SKIP_NATIVE" -eq 0 ]; then
        echo "=== Building simulator ==="
        cargo build --bin chia-gaming-sim --features sim-server
    fi
fi

echo "=== Running hub-service tests ==="
pnpm --filter chia-gaming-hub-service run test &
HUB_TEST_PID=$!
WASM_PIDS=()

SIM_BIN="${CARGO_TARGET_DIR:-$REPO_ROOT/target}/debug/chia-gaming-sim"

echo "=== Running tests ==="
if [[ "$(node --help)" == *"--no-experimental-webstorage"* ]]; then
    export NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--no-experimental-webstorage"
fi

FRONTEND_STATUS=0
if pnpm --filter chia-gaming-fe run generate:games &&
   pnpm --filter chia-gaming-fe exec tsc -p tsconfig.json --noEmit &&
   pnpm --filter chia-gaming-fe exec jest --testPathIgnorePatterns=load_wasm \
       --silent=false --verbose --useStderr --ci --forceExit; then
    :
else
    FRONTEND_STATUS=$?
fi

run_wasm_shard() (
    local shard="$1"
    local shard_count="$2"
    local ready_file
    local sim_log
    local sim_pid=

    ready_file="$(mktemp "${TMPDIR:-/tmp}/chia-gaming-sim-ready.XXXXXX")"
    sim_log="$(mktemp "${TMPDIR:-/tmp}/chia-gaming-sim-log.XXXXXX")"
    rm -f "$ready_file"

    cleanup_shard() {
        if [ -n "$sim_pid" ]; then
            kill "$sim_pid" 2>/dev/null || true
            wait "$sim_pid" 2>/dev/null || true
        fi
        rm -f "$ready_file" "$sim_log"
    }
    trap cleanup_shard EXIT INT TERM

    export CHIA_GAMING_SIM_LISTEN_ADDR="[::]:0"
    export CHIA_GAMING_SIM_READY_FILE="$ready_file"
    RUST_LOG=error "$SIM_BIN" >"$sim_log" 2>&1 &
    sim_pid=$!

    for _ in $(seq 1 30); do
        if [ -s "$ready_file" ]; then
            break
        fi
        if ! kill -0 "$sim_pid" 2>/dev/null; then
            echo "WASM shard $shard simulator exited during startup" >&2
            cat "$sim_log" >&2
            exit 1
        fi
        sleep 1
    done
    if [ ! -s "$ready_file" ]; then
        echo "WASM shard $shard simulator did not report its address" >&2
        cat "$sim_log" >&2
        exit 1
    fi

    local sim_addr
    local sim_port
    sim_addr="$(cat "$ready_file")"
    sim_port="${sim_addr##*:}"
    case "$sim_port" in
        ''|*[!0-9]*|0)
            echo "WASM shard $shard simulator reported invalid address: $sim_addr" >&2
            cat "$sim_log" >&2
            exit 1
            ;;
    esac

    export CHIA_GAMING_SIM_URL="http://127.0.0.1:$sim_port"
    export CHIA_GAMING_SIM_WS_URL="ws://127.0.0.1:$sim_port/ws"
    export CHIA_GAMING_TEST_SIMULATOR_OWNED=1
    export LOAD_WASM_REQUIRE_SIM=1

    for _ in $(seq 1 10); do
        if curl -s -X POST "$CHIA_GAMING_SIM_URL/health" >/dev/null 2>&1; then
            break
        fi
        sleep 1
    done
    if ! curl -s -X POST "$CHIA_GAMING_SIM_URL/health" >/dev/null 2>&1; then
        echo "WASM shard $shard simulator failed its health check" >&2
        cat "$sim_log" >&2
        exit 1
    fi

    echo "=== WASM/Jest shard $shard/$shard_count on port $sim_port ==="
    if ! pnpm --filter chia-gaming-fe exec jest --runInBand \
        --shard="$shard/$shard_count" --testPathPatterns=load_wasm \
        --silent=false --verbose --useStderr --ci --forceExit; then
        cat "$sim_log" >&2
        exit 1
    fi
)

if [ "$FRONTEND_STATUS" -eq 0 ]; then
    WASM_SHARD_COUNT=3
    for shard in $(seq 1 "$WASM_SHARD_COUNT"); do
        run_wasm_shard "$shard" "$WASM_SHARD_COUNT" &
        WASM_PIDS+=("$!")
    done
    for pid in "${WASM_PIDS[@]}"; do
        if ! wait "$pid"; then
            FRONTEND_STATUS=1
        fi
    done
    WASM_PIDS=()
fi

HUB_STATUS=0
if wait "$HUB_TEST_PID"; then
    :
else
    HUB_STATUS=$?
fi
HUB_TEST_PID=

if [ "$FRONTEND_STATUS" -ne 0 ]; then
    exit "$FRONTEND_STATUS"
fi
if [ "$HUB_STATUS" -ne 0 ]; then
    exit "$HUB_STATUS"
fi
