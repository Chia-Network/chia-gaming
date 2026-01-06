#!/bin/bash

set -x
set -e

# ---------------------------
# Install deps (Yarn Berry)
# ---------------------------
yarn install

# ---------------------------
# Cleanup handler (ALWAYS runs)
# ---------------------------
cleanup() {
  docker kill chia-gaming-test || true
  docker rm chia-gaming-test || true
}
trap cleanup EXIT

# ---------------------------
# Start container
# ---------------------------
docker run --name chia-gaming-test \
  -p 127.0.0.1:3000:3000 \
  -p 127.0.0.1:3001:3001 \
  -p 127.0.0.1:3002:3002 \
  -p 127.0.0.1:5800:5800 \
  "${@}" -t chia-gaming-test \
  /bin/bash -c "/app/test_env.sh rewrite" &

# ---------------------------
# Firefox detection
# ---------------------------
if [ -z "$FIREFOX" ]; then
  case "$(uname)" in
    Darwin)
      export FIREFOX=/Applications/Firefox.app/Contents/MacOS/firefox
      ;;
    Linux)
      export FIREFOX=$(command -v firefox || true)
      ;;
  esac
fi

if [ -z "$FIREFOX" ]; then
  echo "WARNING: FIREFOX not found – browser tests may fail"
else
  echo "Using FIREFOX=${FIREFOX}"
fi

# ---------------------------
# Wait for services
# ---------------------------
wait_for_port() {
  local url="$1"
  until curl -fsS "$url" >/dev/null; do
    sleep 1
  done
}

wait_for_port http://localhost:3000
wait_for_port http://localhost:3001

# ---------------------------
# Enable coinset rewriting (non-fatal)
# ---------------------------
curl --retry 5 --retry-delay 1 --retry-all-errors \
  -H "Content-Type: text/plain" \
  -d http://localhost:3002 \
  http://localhost:3000/coinset || true

# ---------------------------
# Run tests (PnP-safe)
# ---------------------------
echo 'running tests'

if yarn jest; then
  STATUS=0
else
  STATUS=1
fi

# ---------------------------
# Wait for container process
# ---------------------------
wait "$CONTAINER_PID" || true

exit ${STATUS}
