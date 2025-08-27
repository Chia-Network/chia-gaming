#!/bin/bash
# See also script ./clean-all.sh

set -x -e
./clean-all.sh

(cd wasm && cargo build)
(cd ./resources/gaming-fe && yarn install)

. ./venv/bin/activate
maturin build --features=sim-tests
pip uninstall chia-gaming
pip install `find ./target -name \*.whl`

./build-docker-images.sh
