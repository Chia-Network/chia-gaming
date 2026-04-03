#!/bin/bash
set -e
SECONDS=0
cargo test --lib --no-run --features sim-server "$@"
echo "Build completed in ${SECONDS}s"
