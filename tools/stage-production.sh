#!/bin/bash
# Build production deploy artifacts and stage them for local production testing.
#
# This is the production counterpart to run-local-demo.sh: it uses the release
# build path (tools/build-deploy.sh) rather than the dev path, and it does not
# start the simulator. After staging, run tools/run-production.sh to start the
# player app and hub services.
#
# Outputs:
#   deploy_player_app/chia-gaming-*.tgz/.zip
#   deploy_hub/chia-gaming-hub-*.tgz/.zip
#   .stage-player/  — extracted player app, with gzipped static assets
#   .stage-hub/     — extracted hub frontend + service

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PLAYER_STAGE="${PLAYER_STAGE:-$ROOT_DIR/.stage-player}"
HUB_STAGE="${HUB_STAGE:-$ROOT_DIR/.stage-hub}"

echo "=== Wiping old deploy artifacts and stages ==="
rm -rf "$ROOT_DIR/deploy_player_app" "$ROOT_DIR/deploy_hub" "$PLAYER_STAGE" "$HUB_STAGE"

echo "=== Running production build ==="
cd "$ROOT_DIR"
./tools/build-deploy.sh

echo "=== Extracting player app ==="
mkdir -p "$PLAYER_STAGE"
PLAYER_TGZ=$(ls -t "$ROOT_DIR/deploy_player_app"/chia-gaming-*.tgz | head -1)
tar -xzf "$PLAYER_TGZ" -C "$PLAYER_STAGE"

echo "=== Extracting hub ==="
mkdir -p "$HUB_STAGE"
HUB_TGZ=$(ls -t "$ROOT_DIR/deploy_hub"/chia-gaming-hub-*.tgz | head -1)
tar -xzf "$HUB_TGZ" -C "$HUB_STAGE"

echo "=== Compressing player app static assets ==="
# Pre-compress assets so static-server.js can serve .gz files to clients that
# accept gzip. The original files are kept for clients that do not.
# Use gzip -c (stdout) rather than -k/--keep because BSD gzip on macOS does
# not support -k. -n omits the filename/timestamp header for reproducibility.
while IFS= read -r -d '' f; do
    gzip -c -n -f "$f" > "$f.gz" || exit 1
  done < <(find "$PLAYER_STAGE" -type f \
    \( -name '*.html' -o -name '*.js' -o -name '*.mjs' -o -name '*.css' \
       -o -name '*.json' -o -name '*.wasm' -o -name '*.hex' -o -name '*.dat' \
       -o -name '*.svg' \) -print0)

echo "=== Sanity-checking Krunk files ==="
for f in \
    "clsp/games/krunk/krunk_include_krunk_factory.hex" \
    "clsp/games/krunk/krunk_signed_dict_tree.dat"
do
    if [ ! -f "$PLAYER_STAGE/$f" ]; then
        echo "ERROR: missing $f in player staging"
        exit 1
    fi
    echo "  ok: $f"
done

echo ""
echo "════════════════════════════════════════════════════════"
echo "  Staged for production run:"
echo "    Player app: $PLAYER_STAGE"
echo "    Hub:        $HUB_STAGE"
echo ""
echo "  Run ./tools/run-production.sh to start the services."
echo "════════════════════════════════════════════════════════"
