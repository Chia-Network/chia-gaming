#!/bin/bash

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
cd resources/gaming-fe
yarn build
# cd ../
# cd lobby-view
# yarn build
cd ../../

# Step 3: Run the Docker container with volume mounts
docker run -p 3000:3000 -p 3001:3001 -p 5800:5800 \
    -v "$(pwd)/resources/gaming-fe/dist/js:/app/dist/js" \
    -v "$(pwd)/resources/gaming-fe/dist/css:/app/dist/css" \
    -v "$(pwd)/resources/gaming-fe/public:/app/public" \
    calpoker:latest
