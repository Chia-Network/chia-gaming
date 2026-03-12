#!/bin/bash
set -e

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

CACHE_FILE=".build-chialisp.cache"

# Track all chialisp source files (entry points + imports + includes)
current_stamps() {
    find clsp -name '*.clsp' -o -name '*.clinc' | while read -r f; do
        echo "$f $(stat -f '%m' "$f" 2>/dev/null || stat -c '%Y' "$f" 2>/dev/null)"
    done | sort
}

needs_build=0

if [ ! -f "$CACHE_FILE" ]; then
    needs_build=1
else
    if [ "$(current_stamps)" != "$(sort "$CACHE_FILE")" ]; then
        needs_build=1
    fi
fi

echo "=== Building chialisp (via cargo build.rs) ==="

if [ "$needs_build" -eq 1 ]; then
    SECONDS=0
    find clsp -name '*.hex' -delete
    cp build.rs.disabled build.rs
    trap 'rm -f "$REPO_ROOT/build.rs"' EXIT
    cargo build
    echo "Build took: ${SECONDS} seconds"
    current_stamps > "$CACHE_FILE"
else
    echo "Chialisp is up to date (skipping build)"
fi
