#!/bin/bash
# Rebuild the gaming frontend. Run from the repo root after editing
# front-end/src/. No server restart needed — the serve/
# directory symlinks to dist/, so a browser reload picks up the new bundle.
set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
FE_DIR="$SCRIPT_DIR/front-end"

echo "=== Building gaming frontend ==="
(cd "$FE_DIR" && yarn build)
touch "$FE_DIR/dist/.fe-stamp"
echo "=== Done — reload the browser ==="
