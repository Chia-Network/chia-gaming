use chia_protocol::Bytes;
use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;

use crate::common::load_clvm::{read_binary_clvm, read_binary_puzzle};
use crate::common::types::{AllocEncoder, Error, IntoErr, Program};
use crate::session_phases::types::GameFactory;
use crate::utils::proper_list;

pub mod dict_tree;

pub const FACTORY_BINARY: &str = "games/krunk/clsp/factory_krunk_factory.clvm.bin";
pub const DICT_BINARY: &str = "games/krunk/clsp/krunk_signed_dict_tree.clvm.bin";

/// Loads the krunk dictionary from `krunkwords.txt`, embedded at compile time.
pub fn dictionary() -> Vec<Bytes> {
    include_str!("../clsp/krunkwords.txt")
        .lines()
        .filter(|l| l.len() == 5)
        .map(|w| Bytes::from(w.as_bytes().to_vec()))
        .collect()
}

pub fn prepared_factory(allocator: &mut AllocEncoder) -> Result<GameFactory, Error> {
    let factory_raw = read_binary_puzzle(allocator, FACTORY_BINARY)?;
    let dict_package = read_binary_clvm(allocator, DICT_BINARY)?;
    let dict_fields = proper_list(allocator.allocator(), dict_package, true)
        .ok_or_else(|| Error::StrErr(format!("{DICT_BINARY}: expected a proper list")))?;
    if dict_fields.len() != 2 {
        return Err(Error::StrErr(format!(
            "{DICT_BINARY}: expected public key and dictionary tree"
        )));
    }
    let dict_pubkey = dict_fields[0];
    let dict_tree = dict_fields[1];
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
