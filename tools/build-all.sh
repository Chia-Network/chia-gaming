#!/bin/bash
# See also script ./tools/clean-all.sh

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

(cd wasm && cargo build)
(cd ./resources/gaming-fe && yarn install)

"$SCRIPT_DIR/build-docker-images.sh"


