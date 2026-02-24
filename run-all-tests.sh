#!/bin/bash

set -x

err() {
    echo "Tests FAILED"
    exit 1
}
trap err ERR

export CARGO_TARGET_DIR="${CARGO_TARGET_DIR:-$(pwd)/target}"
cargo test
cargo test --features sim-tests -- sim_tests --nocapture
./run-clsp-tests.sh
./run-js-tests.sh

echo
echo "---------"
echo "Tests OK!"
