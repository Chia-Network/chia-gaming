use clvm_traits::ToClvm;

use crate::common::load_clvm::read_hex_puzzle;
use crate::common::types::{AllocEncoder, Error, IntoErr, Program};
use crate::session_phases::types::GameFactory;

pub const FACTORY_HEX: &str = "games/spacepoker/clsp/factory_spacepoker_factory.hex";

pub fn prepared_factory(allocator: &mut AllocEncoder) -> Result<GameFactory, Error> {
    let factory = read_hex_puzzle(allocator, FACTORY_HEX)?;
    Ok(GameFactory {
        program: Some(factory.to_program()),
    })
}

/// Canonical probe: 1-mojo stake, 1-mojo unit, sender goes first.
pub fn probe_parameters(allocator: &mut AllocEncoder) -> Result<Program, Error> {
    let node = (1u64, (1u64, (1u64, ()))).to_clvm(allocator).into_gen()?;
    Program::from_nodeptr(allocator, node)
}

#[cfg(test)]
pub mod tests;
