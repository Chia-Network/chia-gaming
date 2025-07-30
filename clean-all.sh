
rm -rf ./resources/gaming-fe/node_modules
rm -rf ./wasm/node_modules
rm -rf ./wasm/tests/node_modules

(cd wasm && cargo clean)
cargo clean

