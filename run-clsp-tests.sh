#!/bin/bash -x

find . -name '*.hex' | xargs rm
cargo test chialisp

if ! which uv; then
  echo "Please install uv. https://docs.astral.sh/uv/getting-started/installation/"
  echo "mac: brew install uv"
  echo "Linux: apt install uv"
  echo
  exit 1
fi

cd ./python
UV_VENV_CLEAR=1 uv venv --python 3.12 --clear
PY_MINOR=$(.venv/bin/python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
if [[ ! "$PY_MINOR" =~ ^3\.(9|10|11|12)$ ]]; then
  echo "Unsupported Python version in .venv: $PY_MINOR"
  echo "Recreating venv with Python 3.12..."
  UV_VENV_CLEAR=1 uv venv --python 3.12 --clear
  PY_MINOR=$(.venv/bin/python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  if [[ ! "$PY_MINOR" =~ ^3\.(9|10|11|12)$ ]]; then
    echo "Still unsupported after recreate: $PY_MINOR"
    exit 1
  fi
fi
source .venv/bin/activate
uv pip install .
cd tests

uv run python3 compute_hashes.py
uv run python3 ./test_calpoker_validation.py
uv run python3 ./test_calpoker_handlers.py

