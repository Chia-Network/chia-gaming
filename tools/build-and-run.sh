#!/bin/bash

set -e
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Step 1: Stop containers using specific ports
ports=(3000 3001 5800)

for port in "${ports[@]}"; do
    # Get container ID using this port
    containerId=$(docker ps --filter "publish=$port" --format "{{.ID}}")

    if [ "$containerId" ]; then
        echo "Port $port is in use by container $containerId. Stopping it..."
        docker stop "$containerId" > /dev/null
        echo "Container $containerId stopped."
    fi
done

# Step 2: Build the frontend (using yarn)
cd "$REPO_ROOT/resources/gaming-fe"
yarn build
cd "$REPO_ROOT/resources/lobby-view"
yarn build


# Step 3: Run the Docker container with volume mounts
docker run -p 3000:3000 -p 3001:3001 -p 5800:5800 \
    -v "$(pwd)/resources/gaming-fe/dist/js:/app/dist/js" \
    -v "$(pwd)/resources/gaming-fe/dist/css:/app/dist/css" \
    -v "$(pwd)/resources/gaming-fe/public:/app/public" \
    -v "$(pwd)/resources/lobby-view/public:/app/lobby-view/public" \
    -v "$(pwd)/resources/lobby-view/dist:/app/lobby-view/dist" \
    chia-gaming-test:latest
