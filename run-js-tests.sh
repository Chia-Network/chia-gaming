#!/bin/bash

set -e

if [ -s "$HOME/.nvm/nvm.sh" ]; then
    . "$HOME/.nvm/nvm.sh"
elif [ -s "$(brew --prefix nvm 2>/dev/null)/nvm.sh" ]; then
    export NVM_DIR="$HOME/.nvm"
    . "$(brew --prefix nvm)/nvm.sh"
else
    echo "nvm not found; install via https://github.com/nvm-sh/nvm or brew install nvm" >&2
    exit 1
fi
nvm use 20.19.0


SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FE_DIR="$SCRIPT_DIR/resources/gaming-fe"
WASM_DIR="$SCRIPT_DIR/wasm"
SIM_PID=""

cleanup() {
    if [ -n "$SIM_PID" ] && kill -0 "$SIM_PID" 2>/dev/null; then
        echo "Stopping simulator (pid $SIM_PID)"
        kill "$SIM_PID" 2>/dev/null || true
        wait "$SIM_PID" 2>/dev/null || true
    fi
}
trap cleanup EXIT

# Build WASM for Node.js (used by Jest tests)
# Apple's system clang lacks the wasm32 backend; use Homebrew LLVM if available
if [ -x /opt/homebrew/opt/llvm/bin/clang ]; then
    export CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang
    export AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/llvm-ar
elif [ -x /usr/local/opt/llvm/bin/clang ]; then
    export CC_wasm32_unknown_unknown=/usr/local/opt/llvm/bin/clang
    export AR_wasm32_unknown_unknown=/usr/local/opt/llvm/bin/llvm-ar
fi

"$SCRIPT_DIR/tools/build-chialisp.sh"

echo "=== Building WASM (nodejs target) ==="
(cd "$WASM_DIR" && wasm-pack build --out-dir="$FE_DIR/node-pkg" --release --target=nodejs)

# Install frontend dependencies
echo "=== Installing frontend dependencies ==="
(cd "$FE_DIR" && yarn install)

# Build the simulator binary (separate from starting it, so compile time
# doesn't eat into the startup timeout)
echo "=== Building simulator ==="
cargo build --features sim-tests,sim-server --bin chia-gaming-sim

# Start the Rust simulator in the background
echo "=== Starting simulator ==="
SIM_BIN="${CARGO_TARGET_DIR:-$SCRIPT_DIR/target}/debug/chia-gaming-sim"
RUST_LOG=error "$SIM_BIN" &
SIM_PID=$!

# Wait for the simulator to be ready on port 5800
echo "=== Waiting for simulator on port 5800 ==="
for i in $(seq 1 30); do
    if curl -s http://localhost:5800/get_peak >/dev/null 2>&1; then
        echo "Simulator ready"
        break
    fi
    if ! kill -0 "$SIM_PID" 2>/dev/null; then
        echo "Simulator process died"
        exit 1
    fi
    sleep 1
done

if ! curl -s http://localhost:5800/get_peak >/dev/null 2>&1; then
    echo "Simulator failed to start within 30 seconds"
    exit 1
fi

# Run the Jest tests
echo "=== Running JS/WASM tests ==="
(cd "$FE_DIR" && yarn test)

echo "=== JS/WASM tests passed ==="
