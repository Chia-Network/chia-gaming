#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
HOOK_SOURCE="$REPO_ROOT/tools/git-hooks/pre-commit"
HOOK_TARGET="$REPO_ROOT/.git/hooks/pre-commit"

cd "$REPO_ROOT"

if [ ! -d ".git" ]; then
    echo "Error: .git directory not found; run this from a git checkout" >&2
    exit 1
fi

if [ ! -f "$HOOK_SOURCE" ]; then
    echo "Error: missing hook source: $HOOK_SOURCE" >&2
    exit 1
fi

mkdir -p "$REPO_ROOT/.git/hooks"
cp "$HOOK_SOURCE" "$HOOK_TARGET"
chmod +x "$HOOK_TARGET"

echo "Installed pre-commit hook at $HOOK_TARGET"
