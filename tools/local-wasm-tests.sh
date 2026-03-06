#!/bin/bash -x

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

FE_DIR="$REPO_ROOT/resources/gaming-fe"
WASM_DIR="$REPO_ROOT/wasm"
LOBBY_CONN_DIR="$REPO_ROOT/resources/lobby-connection"

SKIP_BUILD=0
for arg in "$@"; do
    case "$arg" in
        --skip-build) SKIP_BUILD=1 ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

cleanup() {
    if [ -n "$SIM_PID" ]; then
        kill "$SIM_PID" 2>/dev/null || true
        wait "$SIM_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# macOS wasm32 clang workaround
if [ -x /opt/homebrew/opt/llvm/bin/clang ]; then
    export CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang
    export AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/llvm-ar
elif [ -x /usr/local/opt/llvm/bin/clang ]; then
    export CC_wasm32_unknown_unknown=/usr/local/opt/llvm/bin/clang
    export AR_wasm32_unknown_unknown=/usr/local/opt/llvm/bin/llvm-ar
fi

if [ "$SKIP_BUILD" -eq 0 ]; then
    echo "=== Building WASM (nodejs target for tests) ==="
    (cd "$WASM_DIR" && wasm-pack build --out-dir="$FE_DIR/node-pkg" --release --target=nodejs)

    echo "=== Building lobby-connection ==="
    (cd "$LOBBY_CONN_DIR" && yarn install && yarn build)

    echo "=== Installing gaming-fe deps ==="
    (cd "$FE_DIR" && yarn install)

    echo "=== Building simulator ==="
    cargo build --features sim-tests
fi

echo "=== Starting simulator ==="
SIM_BIN="${CARGO_TARGET_DIR:-$REPO_ROOT/target}/debug/chia-gaming-sim"
RUST_LOG=debug "$SIM_BIN" &
SIM_PID=$!

echo "=== Waiting for simulator ==="
for i in $(seq 1 10); do
    if curl -s -X POST http://localhost:5800/get_peak >/dev/null 2>&1; then
        echo "Simulator ready"
        break
    fi
    sleep 1
done

if ! curl -s -X POST http://localhost:5800/get_peak >/dev/null 2>&1; then
    echo "Simulator failed to start"
    exit 1
fi

echo "=== Running tests ==="
cd "$FE_DIR"
yarn test
