#!/bin/bash

set -x
./clean-all.sh

(cd wasm && cargo build)
(cd ./resources/gaming-fe && yarn install)

. ./venv/bin/activate
maturin build --features=simulator
pip uninstall chia-gaming
pip install `find ./target -name \*.whl`

./build-docker-images.sh
