#!/bin/bash -x

set -e
docker kill chia-gaming-test || true
docker rm chia-gaming-test || true

docker build --platform linux/amd64 -t chia-gaming-test .

docker run --platform linux/amd64 --name chia-gaming-test -t chia-gaming-test /bin/bash -x -c "export RUST_BACKTRACE=1; export RUST_LOG=info; cd /app/rust && cargo test --features sim-tests -- sim_tests $@ --nocapture"
