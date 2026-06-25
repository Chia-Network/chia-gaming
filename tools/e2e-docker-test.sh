#!/bin/bash
# Run Docker Compose E2E test against deploy tarballs from build-deploy.sh.
#
# Usage: ./tools/e2e-docker-test.sh [--platform=linux|macos]
#
# Requires deploy archives in deploy_player_app/ and deploy_tracker/.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
COMPOSE_FILE="$SCRIPT_DIR/e2e/docker-compose.yml"

PLATFORM=""
for arg in "$@"; do
  case "$arg" in
    --platform=*) PLATFORM="${arg#--platform=}" ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

player_prefix() {
  if [ -n "$PLATFORM" ]; then
    echo "chia-gaming-${PLATFORM}-"
  else
    echo "chia-gaming-"
  fi
}

lobby_prefix() {
  if [ -n "$PLATFORM" ]; then
    echo "chia-gaming-lobby-${PLATFORM}-"
  else
    echo "chia-gaming-lobby-"
  fi
}

find_one_archive() {
  local dir="$1"
  local prefix="$2"
  local ext="$3"
  local count=0
  local result=""
  for f in "$dir"/${prefix}*${ext}; do
    [ -e "$f" ] || continue
    result="$f"
    count=$((count + 1))
  done
  if [ "$count" -eq 0 ]; then
    echo "e2e-docker-test: no ${prefix}*${ext} in ${dir}" >&2
    exit 1
  fi
  if [ "$count" -gt 1 ]; then
    echo "e2e-docker-test: ambiguous ${prefix}*${ext} in ${dir}:" >&2
    ls -1 "$dir"/${prefix}*${ext} >&2
    exit 1
  fi
  echo "${result#${ROOT_DIR}/}"
}

PLAYER_TGZ="$(find_one_archive "$ROOT_DIR/deploy_player_app" "$(player_prefix)" ".tgz")"
LOBBY_TGZ="$(find_one_archive "$ROOT_DIR/deploy_tracker" "$(lobby_prefix)" ".tgz")"

export PLAYER_TGZ LOBBY_TGZ

echo "e2e-docker-test: player archive: $PLAYER_TGZ"
echo "e2e-docker-test: lobby archive:  $LOBBY_TGZ"

if ! command -v docker >/dev/null 2>&1; then
  echo "e2e-docker-test: docker not found" >&2
  exit 1
fi

COMPOSE=(docker compose -f "$COMPOSE_FILE")
if docker compose version >/dev/null 2>&1; then
  :
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE=(docker-compose -f "$COMPOSE_FILE")
else
  echo "e2e-docker-test: docker compose not available" >&2
  exit 1
fi

cleanup() {
  "${COMPOSE[@]}" down -v --remove-orphans 2>/dev/null || true
}
trap cleanup EXIT

echo "e2e-docker-test: building images"
"${COMPOSE[@]}" build server alice bob

echo "e2e-docker-test: starting server"
"${COMPOSE[@]}" up -d server

echo "e2e-docker-test: waiting for server health"
for i in $(seq 1 60); do
  status="$("${COMPOSE[@]}" ps --format json server 2>/dev/null | head -1 || true)"
  if "${COMPOSE[@]}" ps server 2>/dev/null | grep -q "(healthy)"; then
    echo "e2e-docker-test: server healthy"
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "e2e-docker-test: server failed to become healthy" >&2
    "${COMPOSE[@]}" logs server >&2 || true
    exit 1
  fi
  sleep 5
done

echo "e2e-docker-test: running alice and bob in parallel"
set +e
"${COMPOSE[@]}" run --rm --no-deps alice &
ALICE_PID=$!
"${COMPOSE[@]}" run --rm --no-deps bob &
BOB_PID=$!

wait "$ALICE_PID"
ALICE_EXIT=$?
wait "$BOB_PID"
BOB_EXIT=$?
set -e

if [ "$ALICE_EXIT" -ne 0 ] || [ "$BOB_EXIT" -ne 0 ]; then
  echo "e2e-docker-test: FAIL (alice=$ALICE_EXIT bob=$BOB_EXIT)" >&2
  "${COMPOSE[@]}" logs server >&2 || true
  exit 1
fi

echo "e2e-docker-test: PASS"
