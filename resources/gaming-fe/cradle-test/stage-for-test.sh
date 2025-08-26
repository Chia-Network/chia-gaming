#!/bin/sh

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
cp -r ../../../wasm/Cargo.lock ../../../wasm/Cargo.toml ../../../wasm/src rust/wasm

docker build -t chia-host-test .
