#!/bin/bash
set -e
cargo build --features sim-tests "$@"
