#!/bin/bash -x

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

docker build -t chia-gaming-test .
docker run -t chia-gaming-test /app/test.sh
