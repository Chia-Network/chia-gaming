#!/bin/bash
# Rebuild the gaming-fe frontend and assemble serve/ with real copies.
# Run this after editing src/ files. No server restart needed — a
# browser reload picks up the new bundle (after the browser fetches the
# updated build-meta.json which points to the new nonce subdir).
#
# Assemble is additive: the new nonce directory is fully written before
# build-meta.json flips, then old nonce dirs are pruned. That avoids a
# window where the running static server has neither the old nor new tree.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FE_DIR="$SCRIPT_DIR"
CLSP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)/clsp"

# Portable millisecond nonce. macOS `date +%s%3N` leaves a literal "3N".
build_nonce() {
  if command -v python3 >/dev/null 2>&1; then
    python3 -c 'import time; print(int(time.time() * 1000))'
  else
    node -e 'process.stdout.write(String(Date.now()))'
  fi
}

echo "=== Building gaming-fe ==="
(cd "$FE_DIR" && pnpm exec tsc --project . && \
 pnpm exec esbuild dist/js/index.js --bundle --outfile=dist/js/index-rollup.js && \
 pnpm exec tailwindcss -i ./src/index.css -o ./dist/css/index.css)

echo "=== Assembling serve/ with build nonce ==="
SERVE="$FE_DIR/serve"
BUILD_NONCE=$(build_nonce)
echo "  nonce: $BUILD_NONCE"

mkdir -p "$SERVE/app/$BUILD_NONCE"
NONCE_DIR="$SERVE/app/$BUILD_NONCE"

# Root-level files (not versioned)
cp "$FE_DIR/public/index.html" "$SERVE/index.html"
[ -f "$FE_DIR/public/favicon.svg" ] && cp "$FE_DIR/public/favicon.svg" "$SERVE/favicon.svg"

cp "$FE_DIR/dist/js/index-rollup.js" "$NONCE_DIR/index.js"
cp "$FE_DIR/dist/css/index.css" "$NONCE_DIR/index.css"
cp "$FE_DIR/dist/chia_gaming_wasm.js" "$NONCE_DIR/chia_gaming_wasm.js"
cp "$FE_DIR/dist/chia_gaming_wasm_bg.wasm" "$NONCE_DIR/chia_gaming_wasm_bg.wasm"
# Match run-local-demo / assemble-bundle: games need both .hex and .dat (e.g. krunk tree).
(cd "$CLSP_DIR" && find . \( -name '*.hex' -o -name '*.dat' \) | while read -r f; do
    mkdir -p "$NONCE_DIR/clsp/$(dirname "$f")"
    cp "$f" "$NONCE_DIR/clsp/$f"
done)
[ -d "$FE_DIR/public/images" ] && cp -r "$FE_DIR/public/images" "$NONCE_DIR/images"

# Flip the pointer only after the new nonce tree is complete.
echo "{\"basePath\":\"/app/$BUILD_NONCE/\"}" > "$SERVE/build-meta.json"

# Prune previous nonce trees (best-effort; ignore races with in-flight fetches).
for old in "$SERVE/app"/*; do
  [ -d "$old" ] || continue
  [ "$(basename "$old")" = "$BUILD_NONCE" ] && continue
  rm -rf "$old"
done

echo "=== Done — reload the browser ==="
