#!/bin/bash
set -e
if [ "$1" = "-o" ] && [ -n "$2" ]; then
    export SIM_TEST_ONLY="$2"
elif [ -n "$1" ]; then
    export SIM_TEST_FROM="$1"
fi
SECONDS=0
cargo test --lib --features sim-tests -- --nocapture
echo "Total time: ${SECONDS}s"
