#!/bin/bash -x

# calpoker_onchain_tests
# install chia_gaming into .venv
cd python
uv venv
source .venv/bin/activate
uv pip install -e .
cd tests

# Note: 'cargo build' must have been run
uv run compute_hashes.py
uv run ./test_calpoker_validation.py
uv run ./test_calpoker_handlers.py

