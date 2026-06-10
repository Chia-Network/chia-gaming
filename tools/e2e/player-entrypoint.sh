#!/bin/bash
set -euo pipefail

/opt/bin/entry_point.sh &
SELENIUM_PID=$!

cleanup() {
  kill "$SELENIUM_PID" 2>/dev/null || true
  wait "$SELENIUM_PID" 2>/dev/null || true
}
trap cleanup EXIT

echo "=== Waiting for Selenium hub ==="
for i in $(seq 1 90); do
  if curl -sf http://127.0.0.1:4444/wd/hub/status >/dev/null 2>&1; then
    echo "Selenium hub ready"
    break
  fi
  sleep 1
done

if ! curl -sf http://127.0.0.1:4444/wd/hub/status >/dev/null 2>&1; then
  echo "Selenium hub failed to start within 90 seconds"
  exit 1
fi

cd /opt/e2e
node play.mjs
EXIT=$?
exit "$EXIT"
