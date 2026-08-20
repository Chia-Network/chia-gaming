use chia_protocol::Bytes;
use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;

use crate::common::load_clvm::{read_hex_puzzle, read_krunk_dict_dat};
use crate::common::types::{AllocEncoder, Error, IntoErr, Program};
use crate::session_phases::types::GameFactory;

pub mod dict_tree;

pub const FACTORY_HEX: &str = "games/krunk/clsp/factory_krunk_factory.hex";
pub const DICT_DAT: &str = "games/krunk/clsp/krunk_signed_dict_tree.dat";

/// Loads the krunk dictionary from `krunkwords.txt`, embedded at compile time.
pub fn dictionary() -> Vec<Bytes> {
    include_str!("../clsp/krunkwords.txt")
        .lines()
        .filter(|l| l.len() == 5)
        .map(|w| Bytes::from(w.as_bytes().to_vec()))
        .collect()
}

pub fn prepared_factory(allocator: &mut AllocEncoder) -> Result<GameFactory, Error> {
    let factory_raw = read_hex_puzzle(allocator, FACTORY_HEX)?;
    let (dict_pubkey, dict_tree) = read_krunk_dict_dat(allocator, DICT_DAT)?;
    let factory_node = CurriedProgram {
        program: factory_raw,
        args: clvm_curried_args!(dict_pubkey, dict_tree),
    }
    .to_clvm(allocator)
    .into_gen()?;
    let factory = Program::from_nodeptr(allocator, factory_node)?;
    Ok(GameFactory {
        program: Some(factory.into()),
    })
}

/// Canonical probe: 100-mojo stake (a valid Krunk multiple of 100).
pub fn probe_parameters(allocator: &mut AllocEncoder) -> Result<Program, Error> {
    let node = 100u64.to_clvm(allocator).into_gen()?;
    Program::from_nodeptr(allocator, node)
}

#[cfg(test)]
pub mod tests;
