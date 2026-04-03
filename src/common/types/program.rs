use serde::de::{self, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

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

#[derive(Clone, PartialEq, Eq)]
pub struct Program(pub Vec<u8>);

impl Serialize for Program {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_bytes(&self.0)
    }
}

struct ProgramVisitor;

impl<'de> Visitor<'de> for ProgramVisitor {
    type Value = Program;

    fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("a clvm program encoded as raw bytes")
    }

    fn visit_bytes<E>(self, v: &[u8]) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Program(v.to_vec()))
    }

    fn visit_byte_buf<E>(self, v: Vec<u8>) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Ok(Program(v))
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut bytes = Vec::new();
        while let Some(b) = seq.next_element::<u8>()? {
            bytes.push(b);
        }
        Ok(Program(bytes))
    }
}

impl<'de> Deserialize<'de> for Program {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        deserializer.deserialize_bytes(ProgramVisitor)
    }
}

impl std::fmt::Debug for Program {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(f, "Program({})", hex::encode(&self.0))
    }
}

impl Program {
    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        clvmr::serde::node_from_bytes(allocator.allocator(), &self.0).into_gen()
    }
    pub fn from_nodeptr(allocator: &AllocEncoder, n: NodePtr) -> Result<Program, Error> {
        let bytes = clvmr::serde::node_to_bytes(allocator.allocator_ref(), n).into_gen()?;
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

#[cfg(test)]
mod tests {
    use super::Program;

    #[test]
    fn program_serializes_to_bson_binary() {
        let p = Program::from_bytes(&[0xff, 0x01, 0x80]);
        let bson = bson::to_bson(&p).expect("program should serialize");
        match bson {
            bson::Bson::Binary(bin) => assert_eq!(bin.bytes, vec![0xff, 0x01, 0x80]),
            other => panic!("expected bson binary, got {other:?}"),
        }
    }
}
