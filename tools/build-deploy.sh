#!/bin/bash
# Build all deployable artifacts and package them into tarballs.
#
# Outputs (in the repo root):
#   chia-gaming-YYYYMMDD-HASH.tgz/.zip       — player app (static files)
#   chia-gaming-hub-YYYYMMDD-HASH.tgz/.zip — hub frontend + service
#
# See DEVELOPMENT.md for the full build/deploy guide.
set -e

SELF="$(basename "$0")"
ARGS="$*"
ABORTED=1
on_exit() {
    # Remove the build.rs we copy in from build.rs.disabled so it never lingers
    # as an untracked file after the run (mirrors tools/build-chialisp.sh).
    [ -n "$ROOT_DIR" ] && rm -f "$ROOT_DIR/build.rs"
    if [ "$ABORTED" -eq 1 ]; then
        echo "$SELF aborted."
    else
        echo "$SELF $ARGS complete."
    fi
}
trap on_exit EXIT

PLATFORM=""
for arg in "$@"; do
    case "$arg" in
        --debug) set -x ;;
        --platform=*) PLATFORM="${arg#--platform=}" ;;
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
HUB_DIR="$ROOT_DIR/hub"
HUB_FRONTEND_DIR="$HUB_DIR/hub-frontend"
HUB_SERVICE_DIR="$HUB_DIR/hub-service"
CLSP_DIR="$ROOT_DIR/clsp"

DATE=$(date +%Y%m%d)
HASH=$(git -C "$ROOT_DIR" rev-parse --short=6 HEAD)
TAG="${PLATFORM:+${PLATFORM}-}${DATE}-${HASH}"
GAME_TARBALL="chia-gaming-${TAG}.tgz"
GAME_ZIP="chia-gaming-${TAG}.zip"
HUB_TARBALL="chia-gaming-hub-${TAG}.tgz"
HUB_ZIP="chia-gaming-hub-${TAG}.zip"

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
(cd "$FE_DIR" && pnpm install --frozen-lockfile && CLSP_DIR="$CLSP_DIR" WASM_OUT_DIR="$FE_DIR/dist" pnpm run bundle)

# ── 4. Lobby frontend ────────────────────────────────────────────────

echo "=== Building hub frontend ==="
# --ignore-scripts: skip native build scripts (esbuild, @parcel/watcher) that
# pnpm 10+ blocks by default. These packages ship pre-built binaries, so the
# scripts are unnecessary and their absence avoids ERR_PNPM_IGNORED_BUILDS.
(cd "$HUB_DIR" && pnpm install --frozen-lockfile --ignore-scripts)
(cd "$HUB_DIR" && pnpm --filter chia-gaming-hub-frontend run build:deploy)

# ── 5. Lobby service ─────────────────────────────────────────────────

echo "=== Building hub service ==="
(cd "$HUB_DIR" && pnpm --filter chia-gaming-hub-service run build)

# ── Assemble player app staging tree ─────────────────────────────────

BUILD_NONCE=$(date +%s%3N)
echo "=== Assembling player app (nonce: $BUILD_NONCE) ==="

GAME_STAGE=$(mktemp -d)
NONCE_DIR="$GAME_STAGE/app/$BUILD_NONCE"
mkdir -p "$NONCE_DIR"

# Relocatable bundle: verbatim copy of the clean dir produced by `pnpm run bundle`.
cp -r "$FE_DIR/dist/app/." "$NONCE_DIR/"

# Framing files at the staging root (small, fixed, structural set).
cp "$FE_DIR/public/index.html" "$GAME_STAGE/index.html"
[ -f "$FE_DIR/public/favicon.svg" ] && cp "$FE_DIR/public/favicon.svg" "$GAME_STAGE/favicon.svg"
cp "$ROOT_DIR/static-server.js" "$GAME_STAGE/static-server.js"
echo "{\"basePath\":\"/app/$BUILD_NONCE/\"}" > "$GAME_STAGE/build-meta.json"

node "$ROOT_DIR/tools/verify-stage.mjs" "$GAME_STAGE"

echo "=== Creating $GAME_TARBALL and $GAME_ZIP ==="
mkdir -p "$ROOT_DIR/deploy_player_app"
tar -czf "$ROOT_DIR/deploy_player_app/$GAME_TARBALL" -C "$GAME_STAGE" .
rm -f "$ROOT_DIR/deploy_player_app/$GAME_ZIP"
(cd "$GAME_STAGE" && zip -rq "$ROOT_DIR/deploy_player_app/$GAME_ZIP" .)
rm -rf "$GAME_STAGE"

# ── Assemble hub staging tree ──────────────────────────────────────

echo "=== Assembling hub (nonce: $BUILD_NONCE) ==="

HUB_STAGE=$(mktemp -d)
HUB_NONCE_DIR="$HUB_STAGE/app/$BUILD_NONCE"
mkdir -p "$HUB_NONCE_DIR"

# Relocatable bundle: verbatim copy of the clean dir produced by build:deploy.
cp -r "$HUB_FRONTEND_DIR/dist/app/." "$HUB_NONCE_DIR/"

# Framing/root files: page shell, generated nonce, and the node service.
cp "$HUB_FRONTEND_DIR/public/index.html" "$HUB_STAGE/index.html"
echo "{\"basePath\":\"/app/$BUILD_NONCE/\"}" > "$HUB_STAGE/build-meta.json"
cp "$HUB_SERVICE_DIR/dist/index-rollup.cjs"  "$HUB_STAGE/service.js"

node "$ROOT_DIR/tools/verify-stage.mjs" "$HUB_STAGE"

echo "=== Creating $HUB_TARBALL and $HUB_ZIP ==="
mkdir -p "$ROOT_DIR/deploy_hub"
tar -czf "$ROOT_DIR/deploy_hub/$HUB_TARBALL" -C "$HUB_STAGE" .
rm -f "$ROOT_DIR/deploy_hub/$HUB_ZIP"
(cd "$HUB_STAGE" && zip -rq "$ROOT_DIR/deploy_hub/$HUB_ZIP" .)
rm -rf "$HUB_STAGE"

# ── Done ─────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Artifacts:"
echo "    $ROOT_DIR/deploy_player_app/$GAME_TARBALL"
echo "    $ROOT_DIR/deploy_player_app/$GAME_ZIP"
echo "    $ROOT_DIR/deploy_hub/$HUB_TARBALL"
echo "    $ROOT_DIR/deploy_hub/$HUB_ZIP"
echo "════════════════════════════════════════════════════════"

ABORTED=0
