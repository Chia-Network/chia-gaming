use crate::common::standard_coin::read_hex_puzzle;

use crate::common::types::{AllocEncoder, Error, Puzzle};

pub fn read_unroll_metapuzzle(allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
    read_hex_puzzle(allocator, "clsp/unroll/unroll_meta_puzzle.hex")
}

pub fn read_unroll_puzzle(allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
    read_hex_puzzle(
        allocator,
        "clsp/unroll/unroll_puzzle_state_channel_unrolling.hex",
    )
}
