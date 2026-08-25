#!/bin/bash
set -e

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

STATE_FILE=".build-chialisp.state"
CURRENT_STATE=$(mktemp)
trap 'rm -f "$CURRENT_STATE"' EXIT

# GNU find errors if a named root is missing. Only search directories that exist.
find_chialisp() {
    local dirs=()
    [ -d clsp ] && dirs+=(clsp)
    [ -d games ] && dirs+=(games)
    if [ ${#dirs[@]} -eq 0 ]; then
        return 0
    fi
    find "${dirs[@]}" "$@"
}

clsp_sources() {
    {
        find_chialisp -type f \( -name '*.clsp' -o -name '*.clinc' \) -print
        for file in \
            build.rs Cargo.toml Cargo.lock chialisp.toml \
            games/registry.json \
            tools/build-chialisp.sh
        do
            [ -f "$file" ] && printf '%s\n' "$file"
        done
    } | LC_ALL=C sort
}

clsp_hex() {
    find_chialisp -type f -name '*.hex' -print | LC_ALL=C sort
}

clsp_binary() {
    clsp_hex | while IFS= read -r file; do
        binary="${file%.hex}.clvm.bin"
        [ -f "$binary" ] && printf '%s\n' "$binary"
    done
}

write_state() {
    local destination=$1
    {
        echo "version 2"
        clsp_sources | while IFS= read -r file; do
            printf 'input %s  %s\n' "$(git hash-object "$file")" "$file"
        done
        clsp_hex | while IFS= read -r file; do
            printf 'output %s  %s\n' "$(git hash-object "$file")" "$file"
        done
        clsp_binary | while IFS= read -r file; do
            printf 'output %s  %s\n' "$(git hash-object "$file")" "$file"
        done
    } > "$destination"
}

echo "=== Building chialisp (via cargo build.rs) ==="

write_state "$CURRENT_STATE"
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "GitHub Actions detected; forcing Chialisp build"
elif [ -f "$STATE_FILE" ] && cmp -s "$CURRENT_STATE" "$STATE_FILE"; then
    echo "Chialisp is up to date (skipping build)"
    exit 0
fi

SECONDS=0
clsp_hex | while IFS= read -r file; do
    rm -f "${file%.hex}.clvm.bin"
done
find_chialisp -name '*.hex' -delete

# CHIALISP_COMPILE is deliberately unique. Cargo tracks it as a build-script
# input, so this forces one Chialisp compile without deleting Cargo's package
# cache. Ordinary cargo commands leave it unset and never compile Chialisp.
CHIALISP_COMPILE="$(date +%s)-$$-${RANDOM:-0}" cargo build --features sim-server

if ! { find_chialisp -type f -name '*.hex' -print | head -n 1 | grep -q .; }; then
    echo "Error: Chialisp build produced no .hex files" >&2
    exit 1
fi

clsp_hex | while IFS= read -r file; do
    xxd -r -p "$file" "${file%.hex}.clvm.bin"
done

if ! { find_chialisp -type f -name '*.clvm.bin' -print | head -n 1 | grep -q .; }; then
    echo "Error: Chialisp build produced no binary CLVM files" >&2
    exit 1
fi

write_state "$CURRENT_STATE"
mv "$CURRENT_STATE" "$STATE_FILE"
echo "Build took: ${SECONDS} seconds"
