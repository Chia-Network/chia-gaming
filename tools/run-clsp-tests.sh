#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
python3 "$SCRIPT_DIR/build_chialisp.py"

cargo build
cargo test chialisp
cargo test calpoker_validation
cargo test calpoker_handlers
