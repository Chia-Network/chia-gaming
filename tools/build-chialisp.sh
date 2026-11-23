#!/bin/bash
set -eu

cd "$(dirname "${BASH_SOURCE[0]}")/.."
export GAMING_PUZZLE_COMPILER=${GAMING_PUZZLE_COMPILER:-rue}
case "$GAMING_PUZZLE_COMPILER" in
    rue)
        if ! command -v rue >/dev/null; then
            rue_root="$PWD/target/rue-cli"
            rue_version=$(sed -n 's/^version = "\([^"]*\)"/\1/p' rue/compiler.toml)
            if [ ! -x "$rue_root/bin/rue" ] ||
                ! grep -Fq "\"rue-cli $rue_version (" "$rue_root/.crates.toml" 2>/dev/null; then
                cargo install --locked --version "=$rue_version" --root "$rue_root" rue-cli
            fi
            export PATH="$rue_root/bin:$PATH"
        fi
        ;;
    chialisp) ;;
    *) echo "Unknown puzzle compiler: $GAMING_PUZZLE_COMPILER" >&2; exit 1 ;;
esac
exec python3 tools/puzzle_build.py
