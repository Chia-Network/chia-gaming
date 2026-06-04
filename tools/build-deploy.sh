#!/bin/bash
# Build all deployable artifacts and package them into tarballs.
#
# Outputs (in the repo root):
#   chia-gaming-YYYYMMDD-HASH.tgz/.zip       — player app (static files)
#   chia-gaming-lobby-YYYYMMDD-HASH.tgz/.zip — lobby frontend + service
#
# The player-app static bundle is produced by tools/build-static-bundle.sh
# (shared with tools/build-electron.sh).
#
# See DEVELOPMENT.md for the full build/deploy guide.
set -e

SELF="$(basename "$0")"
ARGS="$*"
ABORTED=1
on_exit() {
    if [ "$ABORTED" -eq 1 ]; then
        echo "$SELF aborted."
    else
        echo "$SELF $ARGS complete."
    fi
}
trap on_exit EXIT

PLATFORM=""
BUNDLE_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --debug) set -x; BUNDLE_ARGS+=(--debug) ;;
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
LOBBY_DIR="$ROOT_DIR/lobby"
LOBBY_FRONTEND_DIR="$LOBBY_DIR/lobby-frontend"
LOBBY_SERVICE_DIR="$LOBBY_DIR/lobby-service"

DATE=$(date +%Y%m%d)
HASH=$(git -C "$ROOT_DIR" rev-parse --short=6 HEAD)
TAG="${PLATFORM:+${PLATFORM}-}${DATE}-${HASH}"
GAME_TARBALL="chia-gaming-${TAG}.tgz"
GAME_ZIP="chia-gaming-${TAG}.zip"
LOBBY_TARBALL="chia-gaming-lobby-${TAG}.tgz"
LOBBY_ZIP="chia-gaming-lobby-${TAG}.zip"

# ── 1. Player app static bundle ──────────────────────────────────────

GAME_STAGE=$(mktemp -d)
"$SCRIPT_DIR/build-static-bundle.sh" --dest="$GAME_STAGE" "${BUNDLE_ARGS[@]}"

# Web deployments ship a small static test server alongside the bundle.
cp "$ROOT_DIR/local-static-test-server.js" "$GAME_STAGE/local-static-test-server.js"

echo "=== Creating $GAME_TARBALL and $GAME_ZIP ==="
mkdir -p "$ROOT_DIR/deploy_player_app"
tar -czf "$ROOT_DIR/deploy_player_app/$GAME_TARBALL" -C "$GAME_STAGE" .
(cd "$GAME_STAGE" && zip -rq "$ROOT_DIR/deploy_player_app/$GAME_ZIP" .)
rm -rf "$GAME_STAGE"

# ── 2. Lobby frontend ────────────────────────────────────────────────

echo "=== Building lobby frontend ==="
# --ignore-scripts: skip native build scripts (esbuild, @parcel/watcher) that
# pnpm 10+ blocks by default. These packages ship pre-built binaries, so the
# scripts are unnecessary and their absence avoids ERR_PNPM_IGNORED_BUILDS.
(cd "$LOBBY_DIR" && pnpm install --frozen-lockfile --ignore-scripts)
(cd "$LOBBY_DIR" && pnpm --filter chia-gaming-lobby-frontend run build)

# ── 3. Lobby service ─────────────────────────────────────────────────

echo "=== Building lobby service ==="
(cd "$LOBBY_DIR" && pnpm --filter chia-gaming-lobby-service run build)

# ── Assemble lobby staging tree ──────────────────────────────────────

BUILD_NONCE=$(date +%s%3N)
echo "=== Assembling lobby (nonce: $BUILD_NONCE) ==="

LOBBY_STAGE=$(mktemp -d)
LOBBY_NONCE_DIR="$LOBBY_STAGE/app/$BUILD_NONCE"
mkdir -p "$LOBBY_NONCE_DIR"

cp "$LOBBY_FRONTEND_DIR/public/index.html" "$LOBBY_STAGE/index.html"
echo "{\"basePath\":\"/app/$BUILD_NONCE/\"}" > "$LOBBY_STAGE/build-meta.json"

cp "$LOBBY_FRONTEND_DIR/public/index.js"       "$LOBBY_NONCE_DIR/index.js"
cp "$LOBBY_FRONTEND_DIR/dist/css/index.css"    "$LOBBY_NONCE_DIR/index.css"

cp "$LOBBY_SERVICE_DIR/dist/index-rollup.cjs"  "$LOBBY_STAGE/service.js"

echo "=== Creating $LOBBY_TARBALL and $LOBBY_ZIP ==="
mkdir -p "$ROOT_DIR/deploy_tracker"
tar -czf "$ROOT_DIR/deploy_tracker/$LOBBY_TARBALL" -C "$LOBBY_STAGE" .
(cd "$LOBBY_STAGE" && zip -rq "$ROOT_DIR/deploy_tracker/$LOBBY_ZIP" .)
rm -rf "$LOBBY_STAGE"

# ── Done ─────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Artifacts:"
echo "    $ROOT_DIR/deploy_player_app/$GAME_TARBALL"
echo "    $ROOT_DIR/deploy_player_app/$GAME_ZIP"
echo "    $ROOT_DIR/deploy_tracker/$LOBBY_TARBALL"
echo "    $ROOT_DIR/deploy_tracker/$LOBBY_ZIP"
echo "════════════════════════════════════════════════════════"

ABORTED=0
