use hex::FromHex;
use std::{cell::RefCell, collections::HashMap};

use clvmr::serde::node_from_bytes;
use clvmr::NodePtr;

use crate::common::types::Error;
use crate::common::types::IntoErr;
use crate::common::types::{AllocEncoder, Puzzle};

thread_local! {
    pub static PRESET_FILES: RefCell<HashMap<String, Vec<u8>>> = RefCell::default();
}

pub fn wasm_deposit_file(name: &str, data: &[u8]) {
    PRESET_FILES.with(|p| {
        p.borrow_mut().insert(name.to_string(), data.to_vec());
    });
}

pub fn hex_to_sexp(allocator: &mut AllocEncoder, hex_data: &str) -> Result<NodePtr, Error> {
    let hex_stream = Vec::<u8>::from_hex(hex_data.trim()).into_gen()?;
    node_from_bytes(allocator.allocator(), &hex_stream).into_gen()
}

/// Load a file deposited via `wasm_deposit_file`, falling back to disk.
pub fn read_preset_or_file(name: &str) -> Result<Vec<u8>, Error> {
    if let Some(data) = PRESET_FILES.with(|p| p.borrow().get(name).cloned()) {
        return Ok(data);
    }
    std::fs::read(name).map_err(|_| Error::StrErr(format!("Couldn't read filename {name}")))
}

pub fn read_hex_puzzle(allocator: &mut AllocEncoder, name: &str) -> Result<Puzzle, Error> {
    let raw = read_preset_or_file(name)?;
    let hex_data = std::str::from_utf8(&raw)
        .map_err(|e| Error::StrErr(format!("non-UTF8 hex file {name}: {e}")))?;
    let hex_sexp = hex_to_sexp(allocator, hex_data)?;
    Puzzle::from_nodeptr(allocator, hex_sexp)
}

/// Load a binary CLVM-serialized file (not hex-encoded) into the allocator.
pub fn read_binary_puzzle(allocator: &mut AllocEncoder, name: &str) -> Result<NodePtr, Error> {
    let raw = read_preset_or_file(name)?;
    node_from_bytes(allocator.allocator(), &raw).into_gen()
}

/// Load the krunk dict .dat file: 48-byte BLS pubkey + CLVM-serialized tree.
/// Returns (pubkey_node, tree_node).
pub fn read_krunk_dict_dat(
    allocator: &mut AllocEncoder,
    name: &str,
) -> Result<(NodePtr, NodePtr), Error> {
    let raw = read_preset_or_file(name)?;
    if raw.len() < 48 {
        return Err(Error::StrErr(format!("{name}: too short for pubkey")));
    }
    let pubkey_node = allocator.allocator().new_atom(&raw[..48]).into_gen()?;
    let tree_node = node_from_bytes(allocator.allocator(), &raw[48..]).into_gen()?;
    Ok((pubkey_node, tree_node))
}
