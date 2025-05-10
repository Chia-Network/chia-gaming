
from load_clvm_hex import load_clvm_hex
from util import clsp_dir

ref = load_clvm_hex(
    clsp_dir / "referee/onchain/referee-v1.hex"
)


"""
Args format:
(@ all_args ((MOVER_PUZZLE_HASH WAITER_PUZZLE_HASH TIMEOUT AMOUNT MOD_HASH NONCE
        MOVE MAX_MOVE_SIZE INFOHASH_B MOVER_SHARE INFOHASH_A) . args)
"""

def test_dry_run():
    print()
    #ref.run

test_dry_run()
