#!/bin/bash
set -e
SECONDS=0
cargo build --features sim-tests "$@"
echo "Build completed in ${SECONDS}s"
