#!/bin/bash
# Rebuild the gaming-fe frontend and assemble serve/ with real copies.
# Run this after editing src/ files. No server restart needed — a
# browser reload picks up the new bundle (after the browser fetches the
# updated build-meta.json which points to the new nonce subdir).
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FE_DIR="$SCRIPT_DIR"
CLSP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/clsp"

echo "=== Building gaming-fe ==="
(cd "$FE_DIR" && pnpm exec tsc --project . && \
 pnpm exec esbuild dist/js/index.js --bundle --outfile=dist/js/index-rollup.js && \
 pnpm exec tailwindcss -i ./src/index.css -o ./dist/css/index.css)

echo "=== Assembling serve/ with build nonce ==="
SERVE="$FE_DIR/serve"
BUILD_NONCE=$(date +%s%3N)
echo "  nonce: $BUILD_NONCE"

rm -rf "$SERVE"
mkdir -p "$SERVE/app/$BUILD_NONCE"

# Root-level files (not versioned)
cp "$FE_DIR/public/index.html" "$SERVE/index.html"
[ -f "$FE_DIR/public/favicon.svg" ] && cp "$FE_DIR/public/favicon.svg" "$SERVE/favicon.svg"

NONCE_DIR="$SERVE/app/$BUILD_NONCE"

cp "$FE_DIR/dist/js/index-rollup.js" "$NONCE_DIR/index.js"
cp "$FE_DIR/dist/css/index.css" "$NONCE_DIR/index.css"
cp "$FE_DIR/dist/chia_gaming_wasm.js" "$NONCE_DIR/chia_gaming_wasm.js"
cp "$FE_DIR/dist/chia_gaming_wasm_bg.wasm" "$NONCE_DIR/chia_gaming_wasm_bg.wasm"
(cd "$CLSP_DIR" && find . -name '*.hex' | while read -r f; do
    mkdir -p "$NONCE_DIR/clsp/$(dirname "$f")"
    cp "$f" "$NONCE_DIR/clsp/$f"
done)
[ -d "$FE_DIR/public/images" ] && cp -r "$FE_DIR/public/images" "$NONCE_DIR/images"

# Update build-meta.json so the bootstrap loader picks up the new nonce
echo "{\"basePath\":\"/app/$BUILD_NONCE/\"}" > "$SERVE/build-meta.json"

echo "=== Done — reload the browser ==="
