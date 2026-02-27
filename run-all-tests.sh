#!/bin/bash

set -x

err() {
    echo "Tests FAILED"
    exit 1
}
trap err ERR

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$(pwd)/target}"
cargo test --features sim-tests -- --nocapture
./run-js-tests.sh

echo
echo "---------"
echo "Tests OK!"
