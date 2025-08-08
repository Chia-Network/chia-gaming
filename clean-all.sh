#!/bin/bash
set -x

rm -rf ./resources/gaming-fe/node_modules
rm -rf ./wasm/node_modules
rm -rf ./wasm/tests/node_modules
rm -rf ./wasm/target
rm -rf ./target

(cd wasm && cargo clean)
cargo clean

