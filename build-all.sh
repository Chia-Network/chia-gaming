#!/bin/bash
# See also script ./clean-all.sh

set -e

(cd wasm && cargo build)
(cd ./resources/gaming-fe && yarn install)

./build-docker-images.sh


