#!/bin/bash -x

set -e
docker kill chia-gaming-test || true
docker rm chia-gaming-test || true

docker build --platform linux/amd64 -t chia-gaming-test .

docker run --name chia-gaming-test -t chia-gaming-test /bin/bash -x -c "export RUST_BACKTRACE=1; export RUST_LOG=debug; /usr/bin/python3 -m venv /app/test && cd /app && . ./test/bin/activate && python3 -c 'import sys; from chia_gaming import chia_gaming; chia_gaming.run_simulation_tests(sys.argv[1:])' $@"

#2>&1 | grep -v "updating the mempool using the slow-path"'

# --platform linux/amd64
