#!/bin/bash -x

cargo build  # Rebuild root-generated .hex artifacts
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
cargo build --manifest-path ../Cargo.toml  # Ensure root .hex files exist


PY_MINOR=$(.venv/bin/python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
if [[ ! "$PY_MINOR" =~ ^3\.(11|12|13)$ ]]; then
  echo "Unsupported Python version for chia_rs in .venv: $PY_MINOR"
  echo "See https://github.com/Chia-Network/chia_rs/tree/main/wheel"
  echo "Recreating venv with Python 3.12..."
  UV_VENV_CLEAR=1 uv venv --python 3.12 --clear
  PY_MINOR=$(.venv/bin/python -c 'import sys; print(f"{sys.version_info.major}.{sys.version_info.minor}")')
  if [[ ! "$PY_MINOR" =~ ^3\.(11|12|13)$ ]]; then
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

