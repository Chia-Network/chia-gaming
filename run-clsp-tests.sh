#!/bin/bash -x

cargo test chialisp

if ! which uv; then
  echo "Please install uv. https://docs.astral.sh/uv/getting-started/installation/"
  echo "mac: brew install uv"
  echo "Linux: apt install uv"
  echo
  exit 1
fi

cd ~/chia-gaming/python
uv venv
source .venv/bin/activate
uv pip install .
cd tests

uv run compute_hashes.py
uv run ./test_calpoker_validation.py
uv run ./test_calpoker_handlers.py

