#!/bin/bash

# TODO: Check directory we are running in, and output a helpful diagnostic msg
python compute_hashes.py
python ./test_handlers.py
python ./test_validation_pass.py
