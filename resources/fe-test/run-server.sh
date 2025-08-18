#!/bin/sh

docker kill chia-gaming-test
docker rm chia-gaming-test
docker run --name chia-gaming-test -p 127.0.0.1:3000:3000 -p 127.0.0.1:3001:3001 -p 127.0.0.1:5800:5800 \
  chia-gaming-test
