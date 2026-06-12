#!/bin/bash
# Build all deployable artifacts and package them into tarballs.
#
# Outputs (in the repo root):
#   chia-gaming-YYYYMMDD-HASH.tgz/.zip       — player app (static files)
#   chia-gaming-lobby-YYYYMMDD-HASH.tgz/.zip — lobby frontend + service
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
LOBBY_DIR="$ROOT_DIR/lobby"
LOBBY_FRONTEND_DIR="$LOBBY_DIR/lobby-frontend"
LOBBY_SERVICE_DIR="$LOBBY_DIR/lobby-service"
CLSP_DIR="$ROOT_DIR/clsp"

DATE=$(date +%Y%m%d)
HASH=$(git -C "$ROOT_DIR" rev-parse --short=6 HEAD)
TAG="${PLATFORM:+${PLATFORM}-}${DATE}-${HASH}"
GAME_TARBALL="chia-gaming-${TAG}.tgz"
GAME_ZIP="chia-gaming-${TAG}.zip"
LOBBY_TARBALL="chia-gaming-lobby-${TAG}.tgz"
LOBBY_ZIP="chia-gaming-lobby-${TAG}.zip"

# Convert a path for handoff to Windows-native tools (node.exe) when running
# under Git Bash / MSYS. No-op elsewhere.
native_path() {
    if command -v cygpath &>/dev/null; then
        cygpath -w "$1"
    else
        echo "$1"
    fi
}

# Create a zip of the current contents of a directory. Uses `zip` when
# available; falls back to 7-Zip on Windows (Git Bash has no `zip`, and
# 7z produces forward-slash entry names, unlike PowerShell Compress-Archive).
make_zip() {
    local src_dir="$1"
    local out_zip="$2"
    rm -f "$out_zip"
    if command -v zip &>/dev/null; then
        (cd "$src_dir" && zip -rq "$out_zip" .)
    elif command -v 7z &>/dev/null; then
        (cd "$src_dir" && 7z a -tzip -bso0 -bsp0 "$(native_path "$out_zip")" .)
    else
        echo "Error: neither 'zip' nor '7z' found on PATH" >&2
        exit 1
    fi
}

# macOS wasm32 clang workaround
if [ -x /opt/homebrew/opt/llvm/bin/clang ]; then
    export CC_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/clang
    export AR_wasm32_unknown_unknown=/opt/homebrew/opt/llvm/bin/llvm-ar
elif [ -x /usr/local/opt/llvm/bin/clang ]; then
    export CC_wasm32_unknown_unknown=/usr/local/opt/llvm/bin/clang
    export AR_wasm32_unknown_unknown=/usr/local/opt/llvm/bin/llvm-ar
elif ! command -v clang &>/dev/null && [ -x "/c/Program Files/LLVM/bin/clang.exe" ]; then
    # Windows (Git Bash): MSVC cl.exe cannot target wasm32, so C deps (blst)
    # need clang. Pick up an LLVM install that is not on PATH (winget's
    # default). GitHub Windows runners already have clang on PATH.
    export CC_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/clang.exe"
    export AR_wasm32_unknown_unknown="C:/Program Files/LLVM/bin/llvm-ar.exe"
fi

# Windows (Git Bash): package.json scripts use POSIX syntax (rm -rf,
# VAR=val cmd), but npm/pnpm default to cmd.exe as the script shell.
# Point them at this bash instead.
if [ -n "$MSYSTEM" ] && command -v cygpath &>/dev/null; then
    export npm_config_script_shell="$(cygpath -w "$(command -v bash)")"
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

echo "=== Building lobby frontend ==="
# --ignore-scripts: skip native build scripts (esbuild, @parcel/watcher) that
# pnpm 10+ blocks by default. These packages ship pre-built binaries, so the
# scripts are unnecessary and their absence avoids ERR_PNPM_IGNORED_BUILDS.
(cd "$LOBBY_DIR" && pnpm install --frozen-lockfile --ignore-scripts)
(cd "$LOBBY_DIR" && pnpm --filter chia-gaming-lobby-frontend run build:deploy)

# ── 5. Lobby service ─────────────────────────────────────────────────

echo "=== Building lobby service ==="
(cd "$LOBBY_DIR" && pnpm --filter chia-gaming-lobby-service run build)

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

node "$ROOT_DIR/tools/verify-stage.mjs" "$(native_path "$GAME_STAGE")"

echo "=== Creating $GAME_TARBALL and $GAME_ZIP ==="
mkdir -p "$ROOT_DIR/deploy_player_app"
tar -czf "$ROOT_DIR/deploy_player_app/$GAME_TARBALL" -C "$GAME_STAGE" .
make_zip "$GAME_STAGE" "$ROOT_DIR/deploy_player_app/$GAME_ZIP"
rm -rf "$GAME_STAGE"

# ── Assemble lobby staging tree ──────────────────────────────────────

echo "=== Assembling lobby (nonce: $BUILD_NONCE) ==="

LOBBY_STAGE=$(mktemp -d)
LOBBY_NONCE_DIR="$LOBBY_STAGE/app/$BUILD_NONCE"
mkdir -p "$LOBBY_NONCE_DIR"

# Relocatable bundle: verbatim copy of the clean dir produced by build:deploy.
cp -r "$LOBBY_FRONTEND_DIR/dist/app/." "$LOBBY_NONCE_DIR/"

# Framing/root files: page shell, generated nonce, and the node service.
cp "$LOBBY_FRONTEND_DIR/public/index.html" "$LOBBY_STAGE/index.html"
echo "{\"basePath\":\"/app/$BUILD_NONCE/\"}" > "$LOBBY_STAGE/build-meta.json"
cp "$LOBBY_SERVICE_DIR/dist/index-rollup.cjs"  "$LOBBY_STAGE/service.js"

node "$ROOT_DIR/tools/verify-stage.mjs" "$(native_path "$LOBBY_STAGE")"

echo "=== Creating $LOBBY_TARBALL and $LOBBY_ZIP ==="
mkdir -p "$ROOT_DIR/deploy_tracker"
tar -czf "$ROOT_DIR/deploy_tracker/$LOBBY_TARBALL" -C "$LOBBY_STAGE" .
make_zip "$LOBBY_STAGE" "$ROOT_DIR/deploy_tracker/$LOBBY_ZIP"
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
