#!/bin/bash

./clean-all.sh

(cd wasm && cargo build)
(cd ./resources/gaming-fe && yarn install)
./build-docker-images.sh


