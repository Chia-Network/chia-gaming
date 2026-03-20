#!/bin/bash
# Rebuild the gaming-fe frontend and ensure serve/ symlinks are current.
# Run this after editing src/ files. No server restart needed — the
# serve/ directory already symlinks to dist/, so a browser reload picks
# up the new bundle immediately.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FE_DIR="$SCRIPT_DIR"
CLSP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)/clsp"

echo "=== Building gaming-fe ==="
(cd "$FE_DIR" && ./node_modules/.bin/tsc --project . && \
 ./node_modules/.bin/esbuild dist/js/index.js --bundle --outfile=dist/js/index-rollup.js && \
 npx @tailwindcss/cli -i ./src/index.css -o ./dist/css/index.css)

echo "=== Ensuring serve/ symlinks ==="
SERVE="$FE_DIR/serve"
mkdir -p "$SERVE"

link_if_missing() {
    local name="$1" target="$2"
    if [ ! -e "$SERVE/$name" ]; then
        ln -sf "$target" "$SERVE/$name"
        echo "  linked $name"
    fi
}

link_if_missing index.js      "$FE_DIR/dist/js/index-rollup.js"
link_if_missing index.css     "$FE_DIR/dist/css/index.css"
link_if_missing index.html    "$FE_DIR/public/index.html"
link_if_missing chia_gaming_wasm.js       "$FE_DIR/dist/chia_gaming_wasm.js"
link_if_missing chia_gaming_wasm_bg.wasm  "$FE_DIR/dist/chia_gaming_wasm_bg.wasm"
link_if_missing clsp          "$CLSP_DIR"
[ -d "$FE_DIR/public/images" ] && link_if_missing images "$FE_DIR/public/images"

echo "=== Done — reload the browser ==="
