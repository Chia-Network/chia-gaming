#!/bin/bash

wait_for_port() {
  url="$1"
  curl --connect-timeout 5 \
    --max-time 10 \
    --retry 10 \
    --retry-delay 0 \
    --retry-max-time 40 \
    --retry-all-errors \
    ${url}
}

set -x
. /app/test/bin/activate

(node ./dist/lobby-rollup.cjs --self http://localhost:3001 &)
wait_for_port http://localhost:3001

(ALLOW_REWRITING=1 node ./dist/server-rollup.cjs --self http://localhost:3000 --tracker http://localhost:3001 &)
wait_for_port http://localhost:3000

python3 run_simulator.py

