#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/build-chialisp.sh"

cargo build
cargo test chialisp
cargo test calpoker_validation
cargo test calpoker_handlers
