#!/bin/bash -x

cargo build

export RUST_LOG=debug CHIALISP_NOCOMPILE=1
echo
echo
echo "    --------------------------- Starting tests -----------------------------"
set -e
rm -rf $(find ./target -name \*.whl)
maturin build --features=sim-tests
pip uninstall chia-gaming -y
pip install `find ./target -name \*.whl`
./run-sim-tests.py test_play_calpoker_end_game_reward_v1

