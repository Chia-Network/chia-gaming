#!/bin/bash
set -e
if [ -n "$1" ]; then
    export SIM_TEST_FROM="$1"
fi
cargo test --features sim-tests -- --nocapture
