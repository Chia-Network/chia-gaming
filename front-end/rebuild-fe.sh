#!/bin/bash
# Rebuild the gaming-fe frontend and ensure serve/ symlinks are current.
# Run this after editing src/ files. No server restart needed — the
# serve/ directory already symlinks to dist/, so a browser reload picks
# up the new bundle immediately (after the browser fetches the updated
# build-meta.json which points to the new nonce subdir).
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FE_DIR="$SCRIPT_DIR"
CLSP_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)/clsp"

echo "=== Building gaming-fe ==="
(cd "$FE_DIR" && pnpm exec tsc --project . && \
 pnpm exec esbuild dist/js/index.js --bundle --outfile=dist/js/index-rollup.js && \
 pnpm exec tailwindcss -i ./src/index.css -o ./dist/css/index.css)

echo "=== Assembling serve/ with build nonce ==="
SERVE="$FE_DIR/serve"
BUILD_NONCE=$(date +%s%3N)
echo "  nonce: $BUILD_NONCE"

mkdir -p "$SERVE"

# Root-level files (not versioned)
link_if_missing() {
    local dest="$1" target="$2"
    if [ ! -e "$dest" ]; then
        ln -sf "$target" "$dest"
        echo "  linked $(basename "$dest")"
    fi
}
link_if_missing "$SERVE/index.html" "$FE_DIR/public/index.html"
[ -f "$FE_DIR/public/favicon.svg" ] && link_if_missing "$SERVE/favicon.svg" "$FE_DIR/public/favicon.svg"

# Clear old nonce directories and create fresh one
rm -rf "$SERVE/app"
NONCE_DIR="$SERVE/app/$BUILD_NONCE"
mkdir -p "$NONCE_DIR"

ln -sf "$FE_DIR/dist/js/index-rollup.js" "$NONCE_DIR/index.js"
ln -sf "$FE_DIR/dist/css/index.css" "$NONCE_DIR/index.css"
ln -sf "$FE_DIR/dist/chia_gaming_wasm.js" "$NONCE_DIR/chia_gaming_wasm.js"
ln -sf "$FE_DIR/dist/chia_gaming_wasm_bg.wasm" "$NONCE_DIR/chia_gaming_wasm_bg.wasm"
ln -sf "$CLSP_DIR" "$NONCE_DIR/clsp"
[ -d "$FE_DIR/public/images" ] && ln -sf "$FE_DIR/public/images" "$NONCE_DIR/images"

# Update build-meta.json so the bootstrap loader picks up the new nonce
echo "{\"basePath\":\"/app/$BUILD_NONCE/\"}" > "$SERVE/build-meta.json"

echo "=== Done — reload the browser ==="
