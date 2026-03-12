#!/bin/bash
set -e
# TODO: Check directory we are running in, and output a helpful diagnostic msg if not in 'python/tests'
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/../../tools/build-chialisp.sh"

python compute_hashes.py
python ./test_calpoker_handlers.py
python ./test_calpoker_validation.py

