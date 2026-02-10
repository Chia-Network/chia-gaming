#!/bin/bash

err() {
    echo "Tests FAILED"
}
trap err ERR

cargo test
./run-clsp-tests.sh
./run-python-tests.sh
./docker-sim-tests.sh
./docker-wasm-tests.sh
./docker-js-tests.sh

echo
echo "---------"
echo "Tests OK!"
