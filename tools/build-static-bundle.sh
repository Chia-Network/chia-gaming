#!/bin/bash
# Build the static player-app bundle and stage it into a destination tree.
#
# This is the single source of truth for producing the player app's static
# assets (chialisp .hex, WASM, JS/CSS bundle) and laying them out in the
# canonical serve layout:
#
#   <dest>/index.html
#   <dest>/favicon.svg
#   <dest>/build-meta.json          -> { "basePath": "/app/<nonce>/" }
#   <dest>/app/<nonce>/index.js
#   <dest>/app/<nonce>/index.css
#   <dest>/app/<nonce>/chia_gaming_wasm.js
#   <dest>/app/<nonce>/chia_gaming_wasm_bg.wasm
#   <dest>/app/<nonce>/images/...
#   <dest>/app/<nonce>/clsp/**/*.hex
#
# Both tools/build-deploy.sh (web tarball) and tools/build-electron.sh
# (Electron package) consume this script.
#
# Usage:
#   tools/build-static-bundle.sh --dest=DIR [--debug]
set -e

DEST=""
for arg in "$@"; do
    case "$arg" in
        --debug) set -x ;;
        --dest=*) DEST="${arg#--dest=}" ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

if [ -z "$DEST" ]; then
    echo "Error: --dest=DIR is required"
    exit 1
fi

if ! command -v node &>/dev/null; then
    if [ -f ~/.nvm/nvm.sh ]; then
        source ~/.nvm/nvm.sh
        nvm install 22.13
        nvm use 22.13
    else
        echo "Error: node not found and nvm not available"
        exit 1
    fi
fi

if ! command -v pnpm &>/dev/null; then
    corepack enable
    corepack prepare pnpm@10.33.0 --activate
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
FE_DIR="$ROOT_DIR/front-end"
WASM_DIR="$ROOT_DIR/wasm"
CLSP_DIR="$ROOT_DIR/clsp"

# macOS wasm32 clang workaround
if [ -x /opt/homebrew/opt/llvm/bin/clang ]; then
    export CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang
    export AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/llvm-ar
elif [ -x /usr/local/opt/llvm/bin/clang ]; then
    export CC_wasm32_unknown_unknown=/usr/local/opt/llvm/bin/clang
    export AR_wasm32_unknown_unknown=/usr/local/opt/llvm/bin/llvm-ar
fi

# ── 1. Chialisp ──────────────────────────────────────────────────────

echo "=== Building chialisp (.hex files) ==="
find "$CLSP_DIR" -name '*.hex' -delete
cp "$ROOT_DIR/build.rs.disabled" "$ROOT_DIR/build.rs"
(cd "$ROOT_DIR" && cargo build)

# ── 2. WASM (release, browser target) ────────────────────────────────

echo "=== Building WASM (web target, release) ==="
(cd "$WASM_DIR" && wasm-pack build --out-dir="$FE_DIR/dist" --release --target=web)

# ── 3. Player app ────────────────────────────────────────────────────

echo "=== Building player app ==="
(cd "$FE_DIR" && pnpm install --frozen-lockfile && pnpm run build)

# ── 4. Assemble staging tree ─────────────────────────────────────────

BUILD_NONCE=$(date +%s%3N)
echo "=== Assembling player app into $DEST (nonce: $BUILD_NONCE) ==="

NONCE_DIR="$DEST/app/$BUILD_NONCE"
mkdir -p "$NONCE_DIR"

cp "$FE_DIR/public/index.html" "$DEST/index.html"
[ -f "$FE_DIR/public/favicon.svg" ] && cp "$FE_DIR/public/favicon.svg" "$DEST/favicon.svg"
echo "{\"basePath\":\"/app/$BUILD_NONCE/\"}" > "$DEST/build-meta.json"

cp "$FE_DIR/dist/js/index-rollup.js"          "$NONCE_DIR/index.js"
cp "$FE_DIR/dist/css/index.css"                "$NONCE_DIR/index.css"
cp "$FE_DIR/dist/chia_gaming_wasm.js"          "$NONCE_DIR/chia_gaming_wasm.js"
cp "$FE_DIR/dist/chia_gaming_wasm_bg.wasm"     "$NONCE_DIR/chia_gaming_wasm_bg.wasm"
[ -f "$FE_DIR/dist/js/index-rollup.js.map" ] && cp "$FE_DIR/dist/js/index-rollup.js.map" "$NONCE_DIR/index-rollup.js.map"
[ -d "$FE_DIR/public/images" ] && cp -r "$FE_DIR/public/images" "$NONCE_DIR/images"

mkdir -p "$NONCE_DIR/clsp"
find "$CLSP_DIR" -name '*.hex' | while read -r hex; do
    rel="${hex#"$CLSP_DIR/"}"
    mkdir -p "$NONCE_DIR/clsp/$(dirname "$rel")"
    cp "$hex" "$NONCE_DIR/clsp/$rel"
done

echo "=== Static bundle staged in $DEST ==="
