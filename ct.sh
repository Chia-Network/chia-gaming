#!/bin/bash
set -e
export CI=true
SECONDS=0
trap 'echo "Total time: ${SECONDS} seconds"' EXIT

if [ "$1" = "-o" ] && [ -n "$2" ]; then
    export SIM_TEST_ONLY="$2"
    RUN_AUX_TESTS=0
elif [ -n "$1" ]; then
    export SIM_TEST_FROM="$1"
    RUN_AUX_TESTS=1
else
    RUN_AUX_TESTS=1
fi

echo "=== Building chialisp ==="
./tools/build-chialisp.sh

echo "=== Building simulator ==="
cargo build --bin chia-gaming-sim --features sim-server
echo "Build took: ${SECONDS} seconds"

echo "=== Running rust tests ==="
cargo test --lib --features sim-server -- --nocapture

if [ "$RUN_AUX_TESTS" -eq 1 ]; then
    echo "=== Running JS/WASM tests ==="
    ./tools/local-wasm-tests.sh --skip-native
else
    echo "=== Skipping JS/WASM tests for -o targeted run ==="
fi
