#!/bin/bash
# Build the standalone Electron player app.
#
# Produces native installers in player-electron/dist/ (.dmg/.zip on macOS,
# .exe on Windows, .AppImage/.deb on Linux).
#
# Steps:
#   1. Build + stage the static player-app bundle into player-electron/app/
#      (via the shared tools/build-static-bundle.sh).
#   2. Install Electron tooling and run electron-builder. The build output
#      goes to a non-iCloud-synced dir under $TMPDIR to keep codesign happy
#      (iCloud File Provider stamps xattrs codesign rejects as "detritus").
#   3. Copy the finished installers from $TMPDIR into player-electron/dist/.
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
PE_DIR="$ROOT_DIR/player-electron"
APP_STAGE="$PE_DIR/app"

# ── 1. Static player-app bundle ──────────────────────────────────────

echo "=== Staging static bundle into $APP_STAGE ==="
rm -rf "$APP_STAGE"
mkdir -p "$APP_STAGE"
"$SCRIPT_DIR/build-static-bundle.sh" --dest="$APP_STAGE" "${BUNDLE_ARGS[@]}"

# ── 2. Electron package ──────────────────────────────────────────────
# Build into a non-iCloud-synced dir. The repo may live under ~/Documents,
# which iCloud manages via File Provider; it stamps com.apple.FinderInfo
# xattrs on the .app that codesign rejects as "detritus". $TMPDIR
# (/var/folders/...) is never synced, so signing stays clean.

echo "=== Installing Electron tooling ==="
(cd "$PE_DIR" && pnpm install)

case "$PLATFORM" in
    mac)   DIST_FLAG="--mac" ;;
    win)   DIST_FLAG="--win" ;;
    linux) DIST_FLAG="--linux" ;;
    "")    DIST_FLAG="" ;;
    *) echo "Unknown platform: $PLATFORM (expected mac|win|linux)"; exit 1 ;;
esac

OUT_DIR="${TMPDIR:-/tmp}/chia-gaming-electron-dist"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

echo "=== Running electron-builder ${DIST_FLAG} (output: $OUT_DIR) ==="
(cd "$PE_DIR" && pnpm exec electron-builder --config electron-builder.yml $DIST_FLAG \
    -c.directories.output="$OUT_DIR")

# ── 3. Collect installers back into the repo ─────────────────────────
# The finished installers are sealed (already signed internally); iCloud
# stamping them after the fact is harmless.

echo "=== Copying installers into $PE_DIR/dist ==="
mkdir -p "$PE_DIR/dist"
shopt -s nullglob
copied=0
for f in "$OUT_DIR"/*.dmg "$OUT_DIR"/*.zip "$OUT_DIR"/*.AppImage "$OUT_DIR"/*.deb "$OUT_DIR"/*.exe; do
    cp "$f" "$PE_DIR/dist/"
    copied=$((copied + 1))
done
shopt -u nullglob
[ "$copied" -eq 0 ] && echo "  (no installer artifacts found in $OUT_DIR)"

# ── Done ─────────────────────────────────────────────────────────────

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Build dir (not synced): $OUT_DIR"
echo "  Installers copied to:   $PE_DIR/dist/"
echo "════════════════════════════════════════════════════════"

ABORTED=0
