#!/bin/bash
set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Build Chia Gaming Docker image
exec docker build --platform linux/amd64 --progress=plain -t chia-gaming-test .

# Build Lobby Service Docker image
# (cd ./resources/gaming-fe/src/lobby; ls)

