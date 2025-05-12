#!/bin/bash
set -e
# TODO: Check directory we are running in, and output a helpful diagnostic msg if not in 'python/tests'
python compute_hashes.py
python ./test_handlers.py
python ./test_validation_pass.py

