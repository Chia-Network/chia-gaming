#!/bin/bash -x

docker kill chia-gaming-test 2>/dev/null || true

docker run --platform linux/amd64 -i \
  -p 127.0.0.1:3000:3000 \
  -p 127.0.0.1:3001:3001 \
  -p 127.0.0.1:5800:5800 \
  "${@}" -t chia-gaming-test 


