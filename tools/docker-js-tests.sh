#!/bin/bash -x

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

docker kill chia-gaming-test || true
docker rm chia-gaming-test || true
docker build --platform linux/amd64 -t chia-gaming-test .

docker run --name chia-gaming-test -t chia-gaming-test /bin/bash -x -c 'export RUST_BACKTRACE=1; export RUST_LOG=debug; /usr/bin/python3 -m venv /app; . /app/venv; ./test.sh '

#2>&1 | grep -v "updating the mempool using the slow-path"'

# --platform linux/amd64
