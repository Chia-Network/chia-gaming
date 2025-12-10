#!/bin/bash

echo "🛑 Stopping containers..."
docker compose down --rmi all --volumes --remove-orphans

echo "🧹 Pruning Docker system..."
docker system prune -af --volumes

echo "🔨 Rebuilding with no cache..."
docker compose build --no-cache

echo "🚀 Starting containers..."
docker compose up -d

echo "✅ Clean rebuild complete!"
