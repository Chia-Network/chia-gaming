# Ports to check
$ports = @(3000, 3001, 5800)

foreach ($port in $ports) {
    # Get container ID using this port
    $containerId = docker ps --filter "publish=$port" --format "{{.ID}}"

    if ($containerId) {
        Write-Host "Port $port is in use by container $containerId. Stopping it..."
        docker stop $containerId | Out-Null
        Write-Host "Container $containerId stopped."
    }
}

# Step 1: Build the frontend
cd resources/gaming-fe
yarn build
cd ../../

# Step 2: Run the Docker container with volume mounts
docker run -p 3000:3000 -p 3001:3001 -p 5800:5800 `
    -v "${PWD}\resources\gaming-fe\dist\js:/app/dist/js" `
    -v "${PWD}\resources\gaming-fe\dist\css:/app/dist/css" `
    -v "${PWD}\resources\gaming-fe\public:/app/public" `
    calpoker:latest
