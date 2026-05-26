#!/bin/bash
# Compile only Krunk chialisp targets, one at a time, via build-script only.
# Avoids `cargo build --lib` which re-links the full crate and OOMs on 16GB RAM.
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_ROOT="$PWD"

BACKUP="$REPO_ROOT/chialisp.toml.full-backup"
if [[ ! -f "$BACKUP" ]]; then
    cp "$REPO_ROOT/chialisp.toml" "$BACKUP"
fi

restore() {
    if [[ -f "$BACKUP" ]]; then
        cp "$BACKUP" "$REPO_ROOT/chialisp.toml"
    fi
    rm -f "$REPO_ROOT/build.rs"
}
trap restore EXIT

cp "$REPO_ROOT/build.rs.disabled" "$REPO_ROOT/build.rs"

find_build_script() {
    find "$REPO_ROOT/target/debug/build" -path '*chia_gaming-*/build-script-build' -type f 2>/dev/null | head -1
}

ensure_build_script() {
    local bs
    bs="$(find_build_script || true)"
    if [[ -z "$bs" ]]; then
        echo "=== Building build-script binary (CHIALISP_NOCOMPILE=1, no lib link) ==="
        ulimit -s unlimited 2>/dev/null || true
        CHIALISP_NOCOMPILE=1 CARGO_BUILD_JOBS=1 RUSTFLAGS="-C debuginfo=0" \
            cargo build -q --features sim-server --lib
        bs="$(find_build_script || true)"
    fi
    if [[ -z "$bs" ]]; then
        echo "error: could not find chia_gaming build-script-build" >&2
        exit 1
    fi
    echo "$bs"
}

compile_one() {
    local name="$1"
    local path="$2"
    cat > "$REPO_ROOT/chialisp.toml" <<EOF
[compile]
$name = "$path"
EOF
    echo "=== Compiling $name ==="
    ulimit -s unlimited 2>/dev/null || true
    RUST_MIN_STACK=134217728 \
        "$BUILD_SCRIPT"
    echo "=== Done: $name ==="
}

BUILD_SCRIPT="$(ensure_build_script)"
echo "Using build-script: $BUILD_SCRIPT"
echo "=== Compiling Krunk chialisp only (build-script, sequential) ==="

# helpers already compiled if hex present; recompile only if missing
if [[ ! -f clsp/games/krunk/krunk_helpers_list_contains.hex ]]; then
    compile_one krunk-helpers "clsp/games/krunk/krunk_helpers.clsp"
else
    echo "=== Skipping krunk-helpers (hex present) ==="
fi

compile_one krunk-validator-commit "clsp/games/krunk/onchain/commit.clsp"
compile_one krunk-validator-guess "clsp/games/krunk/onchain/guess.clsp"
compile_one krunk-validator-clue "clsp/games/krunk/onchain/clue.clsp"
compile_one krunk-generate "clsp/games/krunk/krunk_include.clsp"

echo "=== Krunk chialisp compile done ==="
