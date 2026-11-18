#!/bin/bash
# Assemble the project landing page and a production player archive for Pages.
# Usage: ./tools/build-pages.sh <player-archive.tgz> <empty-output-directory> [release-url]
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ARCHIVE="${1:?Pass the production player archive}"
OUTPUT="${2:?Pass an empty output directory}"
mkdir -p "$OUTPUT"
if [ -n "$(ls -A "$OUTPUT")" ]; then
    echo "Pages output directory must be empty: $OUTPUT" >&2
    exit 1
fi
mkdir "$OUTPUT/player"
tar -xzf "$ARCHIVE" -C "$OUTPUT/player"
rm "$OUTPUT/player/static-server.js"
cp -R "$ROOT_DIR/project-page/." "$OUTPUT/"
cp "$ROOT_DIR/front-end/public/favicon.svg" "$OUTPUT/favicon.svg"
if [[ -n "${3:-}" ]]; then
    python3 - "$OUTPUT/index.html" "$3" <<'PYTHON'
import sys
from html import escape
from pathlib import Path

page = Path(sys.argv[1])
page.write_text(page.read_text().replace(
    'href="https://github.com/Chia-Network/chia-gaming/releases"',
    f'href="{escape(sys.argv[2], quote=True)}"',
))
PYTHON
fi
echo "Pages site ready: $OUTPUT (player app at player/)"
