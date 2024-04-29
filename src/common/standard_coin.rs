use std::io;
use std::fs::read_to_string;

use clvmr::allocator::{Allocator, NodePtr};
use clvmr::reduction::EvalErr;

use clvm_tools_rs::classic::clvm::syntax_error::SyntaxErr;
use clvm_tools_rs::classic::clvm::__type_compatibility__::{Bytes, Stream, UnvalidatedBytesFromType};
use clvm_tools_rs::classic::clvm::serialize::{sexp_from_stream, SimpleCreateCLVMObject};

pub trait ErrToString {
    fn into_str(&self) -> String;
}

impl ErrToString for EvalErr {
    fn into_str(&self) -> String {
        format!("{self:?}")
    }
}

impl ErrToString for SyntaxErr {
    fn into_str(&self) -> String {
        format!("{self:?}")
    }
}

impl ErrToString for io::Error {
    fn into_str(&self) -> String {
        format!("{self:?}")
    }
}

pub trait IntoErr<X> {
    fn into_estr(self) -> Result<X, String>;
}

impl<X, E> IntoErr<X> for Result<X, E> where E: ErrToString {
    fn into_estr(self) -> Result<X, String> {
        self.map_err(|e| e.into_str())
    }
}

pub fn hex_to_sexp(allocator: &mut Allocator, hex_data: String) -> Result<NodePtr, String> {
    let mut hex_stream = Stream::new(Some(Bytes::new_validated(Some(UnvalidatedBytesFromType::Hex(hex_data.to_string()))).into_estr()?));
    sexp_from_stream(
        allocator,
        &mut hex_stream,
        Box::new(SimpleCreateCLVMObject {})
    ).map(|x| x.1).into_estr()
}

fn get_standard_coin_puzzle(allocator: &mut Allocator) -> Result<NodePtr, String> {
    let hex_data = read_to_string("resources/p2_delegated_puzzle_or_hidden_puzzle.clsp.hex").into_estr()?;
    hex_to_sexp(allocator, hex_data)
}
