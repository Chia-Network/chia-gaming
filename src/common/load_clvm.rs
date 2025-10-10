use hex::FromHex;
use std::{cell::RefCell, collections::HashMap};

use clvmr::serde::node_from_bytes;
use clvmr::NodePtr;

use crate::common::types::Error;
use crate::common::types::IntoErr;
use crate::common::types::{AllocEncoder, Puzzle};

use std::fs::read_to_string;

thread_local! {
    pub static PRESET_FILES: RefCell<HashMap<String, String>> = RefCell::default();
}

pub fn wasm_deposit_file(name: &str, data: &str) {
    PRESET_FILES.with(|p| {
        p.borrow_mut().insert(name.to_string(), data.to_string());
    });
}

pub fn hex_to_sexp(allocator: &mut AllocEncoder, hex_data: &str) -> Result<NodePtr, Error> {
    let hex_stream = Vec::<u8>::from_hex(hex_data.trim()).into_gen()?;
    node_from_bytes(allocator.allocator(), &hex_stream).into_gen()
}

pub fn read_hex_puzzle(allocator: &mut AllocEncoder, name: &str) -> Result<Puzzle, Error> {
    let hex_data = if let Some(data) = PRESET_FILES.with(|p| p.borrow().get(name).cloned()) {
        data
    } else {
        read_to_string(name).map_err(|_| Error::StrErr(format!("Couldn't read filename {name}")))?
    };
    let hex_sexp = hex_to_sexp(allocator, &hex_data)?;
    Puzzle::from_nodeptr(allocator, hex_sexp)
}
