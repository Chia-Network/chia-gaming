#!/bin/sh -x

# clean
rm -rf $(ls -1 ./src | grep -v -e '^lib$')

# Set up directories
mkdir -p ./rust
mkdir -p ./resources

# Copy clsp stuff
cp -r ../../../clsp clsp
cp -r ../../../resources/*.hex ./resources

# Copy rust code
cp ../../../Cargo.lock ../../../Cargo.toml rust
cp -r ../../../src rust
mkdir -p rust/wasm
mkdir -p ./src
mkdir -p ./src/types
cp -r ../../../wasm/Cargo.lock ../../../wasm/Cargo.toml ../../../wasm/src rust/wasm
cp ../src/types/ChiaGaming.ts ./src/types
cp ../src/util.ts ./src/

docker build --platform linux/amd64 -t chia-host-test .
