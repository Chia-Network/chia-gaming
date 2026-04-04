#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

APPLY=0
INCLUDE_RUST=0

usage() {
    cat <<'EOF'
Usage: tools/clean-js-cruft.sh [--apply] [--include-rust]

Default mode is dry-run: prints what would be removed.

Options:
  --apply         Actually delete generated artifacts
  --include-rust  Also delete ./target, ./wasm/target, and wasm node_modules
  --help          Show this help
EOF
}

for arg in "$@"; do
    case "$arg" in
        --apply) APPLY=1 ;;
        --include-rust) INCLUDE_RUST=1 ;;
        --help|-h)
            usage
            exit 0
            ;;
        *)
            echo "Unknown argument: $arg" >&2
            usage
            exit 2
            ;;
    esac
done

EXCLUDE_DIRS=(
    "chia-blockchain"
)

TARGETS=(
    "front-end/node_modules"
    "lobby/lobby-frontend/node_modules"
    "lobby/lobby-service/node_modules"
    "front-end/dist"
    "lobby/lobby-frontend/dist"
    "lobby/lobby-service/dist"
    "front-end/serve"
    "lobby/lobby-frontend/serve"
)

if [ "$INCLUDE_RUST" -eq 1 ]; then
    TARGETS+=(
        "target"
        "wasm/target"
        "wasm/node_modules"
        "wasm/tests/node_modules"
    )
fi

is_excluded() {
    local p="$1"
    for ex in "${EXCLUDE_DIRS[@]}"; do
        case "$p" in "$ex"|"$ex/"*) return 0 ;; esac
    done
    return 1
}

echo "=== Candidate cleanup targets ==="
TOTAL_BYTES=0
PRESENT=0
for path in "${TARGETS[@]}"; do
    if is_excluded "$path"; then
        echo "  $path  (SKIPPED — inside excluded dir)"
        continue
    fi
    if [ -e "$path" ]; then
        PRESENT=1
        SIZE_BYTES="$(du -sk "$path" 2>/dev/null | awk '{print $1 * 1024}')"
        TOTAL_BYTES=$((TOTAL_BYTES + SIZE_BYTES))
        SIZE_HUMAN="$(du -sh "$path" 2>/dev/null | awk '{print $1}')"
        echo "  $path  ($SIZE_HUMAN)"
    fi
done

if [ "$PRESENT" -eq 0 ]; then
    echo "Nothing to clean."
    exit 0
fi

TOTAL_MB=$((TOTAL_BYTES / 1024 / 1024))
echo ""
echo "Estimated reclaimable space: ~${TOTAL_MB} MiB"

if [ "$APPLY" -ne 1 ]; then
    echo ""
    echo "Dry-run only. Re-run with --apply to delete."
    exit 0
fi

echo ""
echo "=== Removing targets ==="
for path in "${TARGETS[@]}"; do
    if is_excluded "$path"; then continue; fi
    if [ -e "$path" ]; then
        rm -rf "$path"
        echo "  removed $path"
    fi
done

echo "Cleanup complete."
