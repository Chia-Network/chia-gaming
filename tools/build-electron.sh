#!/bin/bash
# Build the standalone Electron player app.
#
# Produces native installers in desktop/release/ (.dmg/.zip on macOS, .exe on
# Windows, .AppImage/.deb on Linux).
#
# Steps:
#   1. Build the player-app bundle into front-end/dist/app, via the shared
#      tools/build-player-bundle.sh.
#   2. Typecheck and bundle the Electron main and preload processes, stage the
#      renderer, and run electron-builder.
#
# electron-builder writes to a directory under $TMPDIR rather than the
# repository; see desktop/scripts/package-app.mjs for why.
#
# Usage:
#   tools/build-electron.sh [--platform=mac|win|linux] [--debug]
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

case "$PLATFORM" in
    mac)   PLATFORM_FLAG="--mac" ;;
    win)   PLATFORM_FLAG="--win" ;;
    linux) PLATFORM_FLAG="--linux" ;;
    "")    PLATFORM_FLAG="" ;;
    *) echo "Unknown platform: $PLATFORM (expected mac|win|linux)"; exit 1 ;;
esac

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── 1. Player app bundle ─────────────────────────────────────────────

"$SCRIPT_DIR/build-player-bundle.sh" "${BUNDLE_ARGS[@]}"

# ── 2. Electron package ──────────────────────────────────────────────

# ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain Node, which
# breaks both electron-builder and any launch of the app itself.
echo "=== Packaging Electron app ${PLATFORM_FLAG} ==="
env -u ELECTRON_RUN_AS_NODE pnpm --dir "$ROOT_DIR" --filter chia-gaming-desktop run package $PLATFORM_FLAG

ABORTED=0
