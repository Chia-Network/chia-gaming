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

# Copy necessary typescript
mkdir -p ./src
mkdir -p ./src/types
mkdir -p ./src/hooks
cp -r ../../../wasm/Cargo.lock ../../../wasm/Cargo.toml ../../../wasm/src rust/wasm
cp ../src/types/ChiaGaming.ts ./src/types
cp ../src/hooks/WasmBlobWrapper.ts ../src/hooks/useFullNode.ts ./src/hooks
cp ../src/util.ts ./src/

CMD="docker build -t chia-host-test"
if /bin/test $(uname -s) == "Linux" ; then
    :
else
    CMD="$CMD --platform linux/amd64"
fi
exec sh -c "$CMD ."
