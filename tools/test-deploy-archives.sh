#!/bin/bash
# Verify deploy archives produced by tools/build-deploy.sh.
#
# Usage: ./tools/test-deploy-archives.sh [--platform=linux|macos|windows]
#
# Run after build-deploy.sh. Extracts tgz/zip pairs, validates structure,
# compares formats, and smoke-tests HTTP serving.

set -e

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

PLATFORM=""
for arg in "$@"; do
    case "$arg" in
        --platform=*) PLATFORM="${arg#--platform=}" ;;
        *) echo "Unknown argument: $arg"; exit 1 ;;
    esac
done

ARGS=()
if [ -n "$PLATFORM" ]; then
    ARGS+=(--platform="$PLATFORM")
fi

node "$ROOT_DIR/tools/verify-deploy-archives.mjs" "${ARGS[@]}"
