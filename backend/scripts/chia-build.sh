#!/bin/sh

set -e

THISDIR=$(dirname "$0")

# Compile test_handcalc.clsp
./scripts/clspc.sh -i .. -o test_handcalc.hex ../test_handcalc.clsp
