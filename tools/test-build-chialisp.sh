#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT

REPO="$TEST_ROOT/repo"
FAKE_BIN="$TEST_ROOT/bin"
LOG="$TEST_ROOT/cargo.log"
mkdir -p "$REPO/tools" "$REPO/src" "$REPO/rue/onchain" "$REPO/clsp" "$REPO/games" "$FAKE_BIN"
cp "$SCRIPT_DIR/build-chialisp.sh" "$REPO/tools/build-chialisp.sh"
cp "$SCRIPT_DIR/puzzle_build.py" "$REPO/tools/puzzle_build.py"
cp "$SCRIPT_DIR/../rue/compiler.toml" "$REPO/rue/compiler.toml"
export GAMING_PUZZLE_COMPILER=chialisp
touch "$REPO/tools/build-rue.py" "$REPO/tools/rue_metadata.rs"
touch "$REPO/src/factory_abi.rs" "$REPO/src/game_package_key.rs"
printf '%s\n' '#!/bin/sh' 'exit 0' > "$FAKE_BIN/rue"
chmod +x "$FAKE_BIN/rue"
printf '%s\n' '{"production":[],"test":[]}' > "$REPO/games/registry.json"
# Reject GNU-only find early-exit usage (unsupported on macOS BSD find).
if grep -E '(^|[[:space:]])-quit([[:space:]]|$)' "$REPO/tools/build-chialisp.sh" >/dev/null; then
    echo "build-chialisp.sh must not use find's GNU-only early-exit primary" >&2
    exit 1
fi
printf '%s\n' '(mod ())' > "$REPO/clsp/example.clsp"
printf '%s\n' '[compile]' > "$REPO/chialisp.toml"
printf '%s\n' 'fn main() {}' > "$REPO/build.rs"
printf '%s\n' '[package]' > "$REPO/Cargo.toml"
printf '%s\n' '# lock' > "$REPO/Cargo.lock"
git -C "$REPO" init -q

cat > "$FAKE_BIN/cargo" <<'EOF'
#!/bin/bash
set -e
: "${CHIALISP_COMPILE:?build-chialisp.sh must explicitly request compilation}"
echo compile >> "$FAKE_CARGO_LOG"
git hash-object clsp/example.clsp > clsp/example.hex
printf '\200' > clsp/example.clvm.bin
printf 'debug:%s\n' "$(git hash-object clsp/example.clsp)" > clsp/example.debug.clvm.bin
cp games/registry.json games/package_manifest.json
# Simulate an edit after the compiler has already read its input.
if [ -f edit-during-build ]; then
    mv edit-during-build clsp/example.clsp
fi
EOF
chmod +x "$FAKE_BIN/cargo"

run_build() {
    (cd "$REPO" && GITHUB_ACTIONS= PATH="$FAKE_BIN:$PATH" FAKE_CARGO_LOG="$LOG" ./tools/build-chialisp.sh)
}

run_github_actions_build() {
    (cd "$REPO" && GITHUB_ACTIONS=true PATH="$FAKE_BIN:$PATH" FAKE_CARGO_LOG="$LOG" ./tools/build-chialisp.sh)
}

compile_count() {
    if [ -f "$LOG" ]; then
        wc -l < "$LOG" | tr -d ' '
    else
        echo 0
    fi
}

assert_count() {
    local expected=$1
    local actual
    actual=$(compile_count)
    if [ "$actual" != "$expected" ]; then
        echo "expected $expected Chialisp compile(s), got $actual" >&2
        exit 1
    fi
}

run_build
assert_count 1
[ -f "$REPO/clsp/example.clvm.bin" ] || {
    echo "build did not produce binary CLVM output" >&2
    exit 1
}
[ -f "$REPO/clsp/example.debug.clvm.bin" ] || {
    echo "build did not produce debug metadata sidecar" >&2
    exit 1
}

run_build
assert_count 1

run_github_actions_build
assert_count 2

printf '%s\n' '(mod (X) X)' > "$REPO/clsp/example.clsp"
run_build
assert_count 3

rm "$REPO/clsp/example.hex"
run_build
assert_count 4

rm "$REPO/clsp/example.clvm.bin"
run_build
assert_count 5

rm "$REPO/clsp/example.debug.clvm.bin"
run_build
assert_count 6

printf '%s\n' corrupted > "$REPO/clsp/example.debug.clvm.bin"
run_build
assert_count 7

printf '%s\n' corrupted > "$REPO/clsp/example.hex"
run_build
assert_count 8

printf '%s\n' 'fn main() { println!("changed"); }' > "$REPO/build.rs"
run_build
assert_count 9

printf '%s\n' 'fn main() -> Int { 1 }' > "$REPO/rue/onchain/example.rue"
GAMING_PUZZLE_COMPILER=rue run_build
assert_count 10
GAMING_PUZZLE_COMPILER=rue run_build
assert_count 10
GAMING_PUZZLE_COMPILER=chialisp run_build
assert_count 11
GAMING_PUZZLE_COMPILER=rue run_build
assert_count 12

printf '%s\n' '# new compiler build' >> "$FAKE_BIN/rue"
GAMING_PUZZLE_COMPILER=rue run_build
assert_count 13
printf '%s\n' '// changed package preparation' >> "$REPO/src/factory_abi.rs"
GAMING_PUZZLE_COMPILER=rue run_build
assert_count 14
printf '%s\n' stale > "$REPO/games/package_manifest.json"
GAMING_PUZZLE_COMPILER=rue run_build
assert_count 15

printf '%s\n' '(mod () 42)' > "$REPO/edit-during-build"
GAMING_PUZZLE_COMPILER=chialisp run_build
assert_count 17
[ "$(cat "$REPO/clsp/example.hex")" = "$(git hash-object "$REPO/clsp/example.clsp")" ]
GAMING_PUZZLE_COMPILER=chialisp run_build
assert_count 17

printf '\377' > "$REPO/.build-chialisp.state"
run_build &
first_build=$!
run_build &
second_build=$!
wait "$first_build"
wait "$second_build"
assert_count 18

echo "build-chialisp regression tests passed"
