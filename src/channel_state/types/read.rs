#[cfg(test)]
use crate::common::load_clvm::read_binary_puzzle;
#[cfg(test)]
use crate::common::types::{AllocEncoder, Error, Puzzle};

#[cfg(test)]
pub fn read_unroll_puzzle(allocator: &mut AllocEncoder) -> Result<Puzzle, Error> {
    read_binary_puzzle(
        allocator,
        "clsp/unroll/unroll_puzzle_state_channel_unrolling.clvm.bin",
    )
}
