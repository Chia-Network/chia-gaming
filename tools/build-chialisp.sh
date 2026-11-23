#!/bin/bash
set -e

cd "$(dirname "${BASH_SOURCE[0]}")/.."
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

export GAMING_PUZZLE_COMPILER=${GAMING_PUZZLE_COMPILER:-rue}
case "$GAMING_PUZZLE_COMPILER" in
    rue|chialisp) ;;
    *) echo "Unknown puzzle compiler: $GAMING_PUZZLE_COMPILER" >&2; exit 1 ;;
esac

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
        if [ "$GAMING_PUZZLE_COMPILER" = rue ]; then
            find rue games -type f \( -name '*.rue' -o -name 'compiler.toml' \) -print
            echo tools/build-rue.py
            echo tools/rue_metadata.rs
        else
            find_chialisp -type f \( -name '*.clsp' -o -name '*.clinc' \) -print
        fi
        find_chialisp -type f -name 'factory_args.clvm.bin' -print
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

clsp_debug() {
    {
        clsp_binary
        find_chialisp -type f -name 'factory_prepared.clvm.bin' -print
    } | while IFS= read -r file; do
        debug="${file%.clvm.bin}.debug.clvm.bin"
        [ -f "$debug" ] && printf '%s\n' "$debug"
    done | LC_ALL=C sort
}

prepared_packages() {
    find_chialisp -type f -name 'factory_prepared.clvm.bin' -print | LC_ALL=C sort
    [ -f games/package_manifest.json ] && printf '%s\n' games/package_manifest.json
}

write_state() {
    local destination=$1
    {
        echo "version 5 $GAMING_PUZZLE_COMPILER"
        clsp_sources | while IFS= read -r file; do
            printf 'input %s  %s\n' "$(git hash-object "$file")" "$file"
        done
        clsp_hex | while IFS= read -r file; do
            printf 'output %s  %s\n' "$(git hash-object "$file")" "$file"
        done
        clsp_binary | while IFS= read -r file; do
            printf 'output %s  %s\n' "$(git hash-object "$file")" "$file"
        done
        clsp_debug | while IFS= read -r file; do
            printf 'output %s  %s\n' "$(git hash-object "$file")" "$file"
        done
        prepared_packages | while IFS= read -r file; do
            printf 'output %s  %s\n' "$(git hash-object "$file")" "$file"
        done
    } > "$destination"
}

echo "=== Building puzzles with $GAMING_PUZZLE_COMPILER ==="

write_state "$CURRENT_STATE"
if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "GitHub Actions detected; forcing Chialisp build"
elif [ -f "$STATE_FILE" ] && cmp -s "$CURRENT_STATE" "$STATE_FILE"; then
    echo "Chialisp is up to date (skipping build)"
    exit 0
fi

if [ "$GAMING_PUZZLE_COMPILER" = rue ] && ! command -v rue >/dev/null; then
    rue_root="$REPO_ROOT/target/rue-cli"
    rue_version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' rue/compiler.toml)
    cargo install --locked --version "=$rue_version" --root "$rue_root" rue-cli
    export PATH="$rue_root/bin:$PATH"
fi

SECONDS=0
prepared_packages | while IFS= read -r file; do
    rm -f "$file"
done
find_chialisp -type f -name '*.clvm.bin' ! -name 'factory_args.clvm.bin' -delete
find_chialisp -name '*.hex' -delete

# CHIALISP_COMPILE is deliberately unique. Cargo tracks it as a build-script
# input, so this forces one Chialisp compile without deleting Cargo's package
# cache. Ordinary cargo commands leave it unset and never compile Chialisp.
CHIALISP_COMPILE="$(date +%s)-$$-${RANDOM:-0}" cargo build --locked --features sim-server

if [ -z "$(find_chialisp -type f -name '*.hex' -print)" ]; then
    echo "Error: Chialisp build produced no .hex files" >&2
    exit 1
fi

if [ -z "$(clsp_binary)" ]; then
    echo "Error: Chialisp build produced no binary CLVM files" >&2
    exit 1
fi

{
    clsp_binary
    find_chialisp -type f -name 'factory_prepared.clvm.bin' -print
} | while IFS= read -r file; do
    debug="${file%.clvm.bin}.debug.clvm.bin"
    if [ ! -f "$debug" ]; then
        echo "Error: missing Chialisp debug sidecar $debug" >&2
        exit 1
    fi
done

write_state "$CURRENT_STATE"
mv "$CURRENT_STATE" "$STATE_FILE"
echo "Build took: ${SECONDS} seconds"
