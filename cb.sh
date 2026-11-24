#!/bin/bash
set -e
SECONDS=0
./tools/build-rue.sh
cargo test --lib --no-run --features sim-server "$@"
echo "Build completed in ${SECONDS}s"
