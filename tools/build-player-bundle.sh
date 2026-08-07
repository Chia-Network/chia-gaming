#!/bin/bash
# Build the relocatable player-app bundle into front-end/dist/app.
#
# Produces the chialisp .hex files, the release WASM engine, and the bundled
# React app, in that order. The output directory is position-independent: it
# contains no absolute paths and no page shell, so each consumer stages it its
# own way.
#
#   tools/build-deploy.sh    copies it under /app/<nonce>/ and adds the web
#                            index.html plus build-meta.json.
#   tools/build-electron.sh  hands it to desktop/scripts/stage-renderer.mjs,
#                            which lays it out flat with the desktop entry point.
#
# Usage:
#   tools/build-player-bundle.sh [--debug]
set -e

for arg in "$@"; do
    case "$arg" in
        --debug) set -x ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

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
"$SCRIPT_DIR/build-chialisp.sh"

# ── 2. WASM (release, browser target) ────────────────────────────────

echo "=== Building WASM (web target, release) ==="
(cd "$WASM_DIR" && wasm-pack build --out-dir="$FE_DIR/dist" --release --target=web)

# ── 3. Player app ────────────────────────────────────────────────────

echo "=== Installing JavaScript workspace deps ==="
pnpm --dir "$ROOT_DIR" install --frozen-lockfile

echo "=== Building player app ==="
CLSP_DIR="$CLSP_DIR" WASM_OUT_DIR="$FE_DIR/dist" pnpm --dir "$ROOT_DIR" --filter chia-gaming-fe run bundle

echo "=== Player app bundle ready in $FE_DIR/dist/app ==="
