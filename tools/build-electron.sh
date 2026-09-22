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
#   tools/build-electron.sh [--platform=mac|win|linux]
#                           [--arch=x64|arm64|universal]
#                           [--release-version=X.Y.Z[-PRERELEASE]] [--debug]
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
ARCH=""
RELEASE_VERSION=""
BUNDLE_ARGS=()
for arg in "$@"; do
    case "$arg" in
        --debug) set -x; BUNDLE_ARGS+=(--debug) ;;
        --platform=*) PLATFORM="${arg#--platform=}" ;;
        --arch=*) ARCH="${arg#--arch=}" ;;
        --release-version=*) RELEASE_VERSION="${arg#--release-version=}" ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

PACKAGE_ARGS=()
case "$PLATFORM" in
    mac)   PACKAGE_ARGS+=(--mac) ;;
    win)   PACKAGE_ARGS+=(--win) ;;
    linux) PACKAGE_ARGS+=(--linux) ;;
    "") ;;
    *) echo "Unknown platform: $PLATFORM (expected mac|win|linux)"; exit 1 ;;
esac

case "$ARCH" in
    x64|arm64|universal) PACKAGE_ARGS+=("--$ARCH") ;;
    "") ;;
    *) echo "Unknown architecture: $ARCH (expected x64|arm64|universal)"; exit 1 ;;
esac

if [ "$ARCH" = "universal" ] && [ "$PLATFORM" != "mac" ]; then
    echo "Universal architecture is supported only for macOS"
    exit 1
fi

if [ -n "$RELEASE_VERSION" ]; then
    if ! [[ "$RELEASE_VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$ ]]; then
        echo "Invalid release version: $RELEASE_VERSION"
        exit 1
    fi
    PACKAGE_ARGS+=("--release-version=$RELEASE_VERSION")
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ── 1. Player app bundle ─────────────────────────────────────────────

"$SCRIPT_DIR/build-player-bundle.sh" "${BUNDLE_ARGS[@]}"

# ── 2. Electron package ──────────────────────────────────────────────

# ELECTRON_RUN_AS_NODE makes the Electron binary behave as plain Node, which
# breaks both electron-builder and any launch of the app itself.
echo "=== Packaging Electron app ${PACKAGE_ARGS[*]} ==="
env -u ELECTRON_RUN_AS_NODE pnpm --dir "$ROOT_DIR" --filter chia-gaming-desktop run package "${PACKAGE_ARGS[@]}"

ABORTED=0
