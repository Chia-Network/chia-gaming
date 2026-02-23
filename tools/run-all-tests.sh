#!/bin/bash

set -x
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

err() {
    echo "Tests FAILED"
    exit 1
}
trap err ERR

cargo build
cargo test
"$SCRIPT_DIR/run-clsp-tests.sh"
"$SCRIPT_DIR/docker-sim-tests.sh"
"$SCRIPT_DIR/docker-wasm-tests.sh"
"$SCRIPT_DIR/docker-js-tests.sh"

echo
echo "---------"
echo "Tests OK!"
