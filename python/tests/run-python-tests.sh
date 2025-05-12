#!/bin/bash

set -e

# TODO: check that we are in 'python/tests' dir

python compute_hashes.py
python ./test_validation_pass.py
python ./test_handlers.py

