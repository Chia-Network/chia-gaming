#!/bin/bash
set -e
if [ -n "$1" ]; then
    export SIM_TEST_FROM="$1"
fi
SECONDS=0
cargo test --features sim-tests -- --nocapture
echo "Total time: ${SECONDS}s"
