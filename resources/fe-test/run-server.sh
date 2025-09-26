#!/bin/sh

docker kill chia-gaming-sim
docker rm chia-gaming-sim
docker run --name chia-gaming-sim -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 \
  chia-gaming-sim
