#!/bin/bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

cp build.rs.disabled build.rs
trap 'rm -f "$REPO_ROOT/build.rs"' EXIT

pytest tools/test_build_chialisp.py --full-build "$@"
