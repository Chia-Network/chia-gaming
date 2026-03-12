#!/bin/bash
set -e
cd "$(dirname "${BASH_SOURCE[0]}")/.."
echo "=== Building chialisp (via cargo build.rs) ==="
cargo build
