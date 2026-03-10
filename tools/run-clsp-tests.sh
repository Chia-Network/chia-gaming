#!/bin/bash -x

cargo build
cargo test chialisp
cargo test calpoker_validation
cargo test calpoker_handlers
