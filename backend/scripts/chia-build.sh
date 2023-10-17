#!/bin/sh

set -e

THISDIR=$(dirname "$0")

mkdir -p clvm-hex
./scripts/clspc.sh -i .. -o clvm-hex/test_handcalc.hex ../test_handcalc.clsp
./scripts/clspc.sh -i .. -o clvm-hex/run_handcalc.hex test-content/run_handcalc.clsp
./scripts/clspc.sh -i .. -o clvm-hex/run_onehandcalc.hex test-content/run_onehandcalc.clsp

