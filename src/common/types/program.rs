use serde::{Deserialize, Serialize};

use clvmr::allocator::{NodePtr, SExp};
use clvmr::serde::node_from_bytes;
use clvmr::Allocator;

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvm_utils::tree_hash;

use crate::common::types::{AllocEncoder, Error, IntoErr, PuzzleHash};

pub trait ToQuotedProgram {
    fn to_quoted_program(&self, allocator: &mut AllocEncoder) -> Result<Program, Error>;
}

impl ToQuotedProgram for NodePtr {
    fn to_quoted_program(&self, allocator: &mut AllocEncoder) -> Result<Program, Error> {
        let pair = allocator.0.new_pair(allocator.0.one(), *self).into_gen()?;
        Program::from_nodeptr(allocator, pair)
    }
}

pub trait Sha256tree {
    fn sha256tree(&self, allocator: &mut AllocEncoder) -> PuzzleHash;
}

impl<X: ToClvm<AllocEncoder>> Sha256tree for X {
    fn sha256tree(&self, allocator: &mut AllocEncoder) -> PuzzleHash {
        self.to_clvm(allocator)
            .map(|node| PuzzleHash::from_bytes(tree_hash(allocator.allocator(), node).into()))
            .unwrap_or_default()
    }
}

#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct Program(pub Vec<u8>);

impl std::fmt::Debug for Program {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(f, "Program({})", hex::encode(&self.0))
    }
}

impl Program {
    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        clvmr::serde::node_from_bytes(allocator.allocator(), &self.0).into_gen()
    }
    pub fn from_nodeptr(allocator: &mut AllocEncoder, n: NodePtr) -> Result<Program, Error> {
        let bytes = clvmr::serde::node_to_bytes(allocator.allocator(), n).into_gen()?;
        Ok(Program(bytes))
    }

    pub fn from_hex(s: &str) -> Result<Program, Error> {
        let bytes = hex::decode(s.trim()).into_gen()?;
        Ok(Program::from_bytes(&bytes))
    }

    pub fn from_bytes(by: &[u8]) -> Program {
        Program(by.to_vec())
    }

    pub fn bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn to_hex(&self) -> String {
        hex::encode(&self.0)
    }
}

fn clone_to_encoder<E: ClvmEncoder<Node = NodePtr>>(
    encoder: &mut E,
    source_allocator: &Allocator,
    node: <E as ClvmEncoder>::Node,
) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
    match source_allocator.sexp(node) {
        SExp::Atom => {
            let buf = source_allocator.atom(node);
            encoder.encode_atom(buf)
        }
        SExp::Pair(a, b) => {
            let ac = clone_to_encoder(encoder, source_allocator, a)?;
            let bc = clone_to_encoder(encoder, source_allocator, b)?;
            encoder.encode_pair(ac, bc)
        }
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Program {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        let mut allocator = Allocator::new();
        let result = node_from_bytes(&mut allocator, &self.0)
            .map_err(|e| ToClvmError::Custom(format!("{e:?}")))?;
        clone_to_encoder(encoder, &allocator, result)
    }
}
