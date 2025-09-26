#!/bin/bash -x

cargo build

export RUST_LOG=debug CHIALISP_NOCOMPILE=1
echo
echo
echo
echo
echo
echo
echo
echo "    --------------------------- Starting tests -----------------------------"
# RUST_LOG=debug CHIALISP_NOCOMPILE=1 cargo test tests::peer::potato_handler::test_peer_smoke
#CHIALISP_NOCOMPILE=1 cargo test --features=sim-tests tests::peer::potato_handler::test_peer_smoke
#RUST_LOG=debug CHIALISP_NOCOMPILE=1 cargo test --features=sim-tests sim_test_with_peer_container_piss_off_peer_after_accept_complete

#RUST_LOG=debug CHIALISP_NOCOMPILE=1 cargo test --features=sim-tests \
#    tests::peer::potato_handler::test_peer_smoke
#RUST_LOG=debug CHIALISP_NOCOMPILE=1 cargo test --features=sim-tests \
#    tests::referee::test_referee_smoke

#cargo test --features=sim-tests piss_off_peer_complete 2>&1 | tee .cargo-test-log.txt

#(cd pytests; for t in test*py ; do python $t 2>&1 > /dev/null; echo "$t return: $?"; done)

#cargo test test_debug_game

#cargo test
#cargo test --features=sim-tests tests::calpoker::test_play_calpoker_happy_path

#from chia_gaming import chia_gaming; chia_gaming.run_simulation_tests()
#or
#from chia_gaming import chia_gaming; chia_gaming.run_simulation_tests(['pattern1', 'pattern2'])

#And the simulator service for the ui is started like this:
#from from chia_gaming import chia_gaming; chia_gaming.service_main()

#./tbl
set -e
maturin build --features=sim-tests
pip uninstall chia-gaming -y
pip install `find ./target -name \*.whl`
./run-sim-tests.py test_play_calpoker_end_game_reward_v1


