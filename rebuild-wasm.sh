#!/bin/bash
# Rebuild the WASM module and output to gaming-fe/dist/.
# Run from the repo root after editing wasm/src/ or src/.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WASM_DIR="$SCRIPT_DIR/wasm"
FE_DIR="$SCRIPT_DIR/front-end"

# macOS wasm32 clang workaround
if [ -x /opt/homebrew/opt/llvm/bin/clang ]; then
    export CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang
    export AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/llvm-ar
elif [ -x /usr/local/opt/llvm/bin/clang ]; then
    export CC_wasm32_unknown_unknown=/usr/local/opt/llvm/bin/clang
    export AR_wasm32_unknown_unknown=/usr/local/opt/llvm/bin/llvm-ar
fi

echo "=== Building WASM (web target) ==="
(cd "$WASM_DIR" && wasm-pack build --out-dir="$FE_DIR/dist" --dev --target=web)
touch "$FE_DIR/dist/.wasm-stamp"
echo "=== Done ==="
