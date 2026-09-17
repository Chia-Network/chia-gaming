#!/bin/bash
set -u

LOG_FILE="$(mktemp "${TMPDIR:-/tmp}/chia-gaming-tests.XXXXXX")"

cleanup() {
    rm -f "$LOG_FILE"
}
trap cleanup EXIT INT TERM

if ./ct.sh >"$LOG_FILE" 2>&1; then
    echo "All tests passed"
else
    STATUS=$?
    cat "$LOG_FILE" >&2
    exit "$STATUS"
fi
