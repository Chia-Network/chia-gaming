
#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

rm -rf ./resources/gaming-fe/node_modules
rm -rf ./wasm/node_modules
rm -rf ./wasm/tests/node_modules
rm -rf ./wasm/target
rm -rf ./target

(cd wasm && cargo clean)
cargo clean

