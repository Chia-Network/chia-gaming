#!/bin/bash -x

cargo test chialisp

if ! which uv; then
  echo "Please install uv. https://docs.astral.sh/uv/getting-started/installation/"
  echo "mac: brew install uv"
  echo "Linux: apt install uv"
  echo
  exit 1
fi

cd ./python
if [ ! -d ./venv ]; then
  uv venv
fi
source .venv/bin/activate
uv pip install .
cd tests

uv run python3 compute_hashes.py
uv run python3 ./test_calpoker_validation.py
uv run python3 ./test_calpoker_handlers.py

