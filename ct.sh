#!/bin/bash
set -e
SECONDS=0
trap 'echo "Total time: ${SECONDS} seconds"' EXIT

echo "=== Building rust ==="
rm -f build.rs
cargo build --features sim-tests
echo "Build took: ${SECONDS} seconds"

echo "=== Building chialisp ==="
cp build.rs.disabled build.rs
cargo build
echo "Build took: ${SECONDS} seconds"

if [ "$1" = "-o" ] && [ -n "$2" ]; then
    export SIM_TEST_ONLY="$2"
elif [ -n "$1" ]; then
    export SIM_TEST_FROM="$1"
fi
echo "=== Running rust tests ==="
cargo test --lib --features sim-tests -- --nocapture

echo "=== Running JS tests ==="
./run-js-tests.sh

echo "=== Running WASM tests ==="
./tools/local-wasm-tests.sh
