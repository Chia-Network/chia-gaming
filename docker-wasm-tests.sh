#!/bin/bash -x

set -e
docker build -t chia-gaming-test .
docker run -t chia-gaming-test /app/test.sh
