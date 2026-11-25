#!/bin/bash
# Build the relocatable player-app bundle into front-end/dist/app.
#
# Builds the Rue puzzle artifacts, the release WASM engine, and the React
# bundle, in that order. The output directory is position-independent: it
# contains no absolute paths and no page shell, so each consumer stages it its
# own way.
#
#   tools/build-deploy.sh    copies it under /app/<nonce>/ and adds the web
#                            index.html plus build-meta.json.
#   tools/build-electron.sh  hands it to desktop/scripts/stage-renderer.mjs,
#                            which lays it out flat with the desktop entry point.
#
# Usage:
#   tools/build-player-bundle.sh [--dev] [--debug]
set -e

FRONTEND_ARGS=()
BUNDLE_DIR=app
for arg in "$@"; do
    case "$arg" in
        --dev) FRONTEND_ARGS+=(--dev); BUNDLE_DIR=app-dev ;;
        --debug) set -x ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

if ! command -v node &>/dev/null; then
    if [ -f ~/.nvm/nvm.sh ]; then
        source ~/.nvm/nvm.sh
        nvm install 24
        nvm use 24
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

# ── 1. Rue puzzles ───────────────────────────────────────────────────

echo "=== Building Rue puzzles (.hex files) ==="
"$SCRIPT_DIR/build-rue.sh"

# ── 2. WASM (release, browser target) ────────────────────────────────

echo "=== Building WASM (web target, release) ==="
# shellcheck source=tools/wasm-toolchain.sh
. "$SCRIPT_DIR/wasm-toolchain.sh"
configure_wasm_toolchain
(
    cd "$WASM_DIR"
    # wasm-pack runs Cargo metadata before building; validate the lockfile first.
    cargo metadata --locked --format-version 1 > /dev/null
    wasm-pack build --out-dir="$FE_DIR/dist" --release --target=web -- --locked
)

# ── 3. Player app ────────────────────────────────────────────────────

echo "=== Installing JavaScript workspace deps ==="
pnpm --dir "$ROOT_DIR" install --frozen-lockfile

echo "=== Building player app ==="
CLSP_DIR="$CLSP_DIR" WASM_OUT_DIR="$FE_DIR/dist" pnpm --dir "$ROOT_DIR" --filter chia-gaming-fe run bundle "${FRONTEND_ARGS[@]}"

echo "=== Player app bundle ready in $FE_DIR/dist/$BUNDLE_DIR ==="
