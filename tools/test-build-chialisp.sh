#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TEST_ROOT=$(mktemp -d)
trap 'rm -rf "$TEST_ROOT"' EXIT

REPO="$TEST_ROOT/repo"
FAKE_BIN="$TEST_ROOT/bin"
LOG="$TEST_ROOT/cargo.log"
mkdir -p "$REPO/tools" "$REPO/clsp" "$REPO/games" "$FAKE_BIN"
cp "$SCRIPT_DIR/build-chialisp.sh" "$REPO/tools/build-chialisp.sh"
printf '%s\n' '{}' > "$REPO/games/registry.json"
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

printf '%s\n' corrupted > "$REPO/clsp/example.hex"
run_build
assert_count 6

printf '%s\n' 'fn main() { println!("changed"); }' > "$REPO/build.rs"
run_build
assert_count 7

echo "build-chialisp regression tests passed"
