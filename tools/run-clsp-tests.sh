#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
"$SCRIPT_DIR/build-rue.sh"

cargo build
cargo test tests::rue::
cargo test calpoker_validation
cargo test calpoker_handlers
