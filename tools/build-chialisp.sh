#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

CACHE_FILE=".build-chialisp.cache"

# Collect .clsp files listed in chialisp.toml (the ones that produce .hex output)
clsp_files() {
    grep '\.clsp"' chialisp.toml | sed 's/.*= *"//;s/"//'
}

# Build current timestamps for comparison
current_stamps() {
    clsp_files | while read -r f; do
        if [ -f "$f" ]; then
            echo "$f $(stat -f '%m' "$f" 2>/dev/null || stat -c '%Y' "$f" 2>/dev/null)"
        fi
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

if [ "$needs_build" -eq 1 ]; then
    SECONDS=0
    cp build.rs.disabled build.rs
    cargo build
    echo "Build took: ${SECONDS} seconds"
    current_stamps > "$CACHE_FILE"
else
    echo "Chialisp is up to date (skipping build)"
fi
