use std::io::Cursor;

use serde::de::{self, SeqAccess, Visitor};
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use clvmr::allocator::{NodePtr, SExp};
use clvmr::serde::{node_from_bytes, node_from_stream};
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
        match self.to_clvm(allocator) {
            Ok(node) => PuzzleHash::from_bytes(tree_hash(allocator.allocator(), node).into()),
            Err(e) => panic!("sha256tree: ToClvm encoding failed: {e:?}"),
        }
    }
}

#[derive(Clone, PartialEq, Eq)]
pub struct Program(Vec<u8>);

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
        Program::from_bytes(v).map_err(E::custom)
    }

    fn visit_byte_buf<E>(self, v: Vec<u8>) -> Result<Self::Value, E>
    where
        E: de::Error,
    {
        Program::from_bytes(&v).map_err(E::custom)
    }

    fn visit_seq<A>(self, mut seq: A) -> Result<Self::Value, A::Error>
    where
        A: SeqAccess<'de>,
    {
        let mut bytes = Vec::new();
        while let Some(b) = seq.next_element::<u8>()? {
            bytes.push(b);
        }
        Program::from_bytes(&bytes).map_err(<A::Error as de::Error>::custom)
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
    pub fn nil() -> Program {
        Program(vec![0x80])
    }

    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        clvmr::serde::node_from_bytes(allocator.allocator(), &self.0).into_gen()
    }
    pub fn from_nodeptr(allocator: &AllocEncoder, n: NodePtr) -> Result<Program, Error> {
        let bytes = clvmr::serde::node_to_bytes(allocator.allocator_ref(), n).into_gen()?;
        Ok(Program(bytes))
    }

    pub fn from_hex(s: &str) -> Result<Program, Error> {
        let bytes = hex::decode(s.trim()).into_gen()?;
        Program::from_bytes(&bytes)
    }

    pub fn from_bytes(by: &[u8]) -> Result<Program, Error> {
        let mut allocator = Allocator::new();
        let mut cursor = Cursor::new(by);
        node_from_stream(&mut allocator, &mut cursor).into_gen()?;
        if cursor.position() != by.len() as u64 {
            return Err(Error::StrErr(
                "trailing bytes after serialized CLVM".to_string(),
            ));
        }
        Ok(Program(by.to_vec()))
    }

    pub fn bytes(&self) -> &[u8] {
        &self.0
    }

    pub fn is_nil(&self) -> bool {
        self.0 == [0x80]
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
    use serde::{Serialize, Serializer};

    use super::Program;

    struct RawBytes(Vec<u8>);

    impl Serialize for RawBytes {
        fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
        where
            S: Serializer,
        {
            serializer.serialize_bytes(&self.0)
        }
    }

    #[test]
    fn program_round_trips() {
        let p = Program::from_bytes(&[0xff, 0x01, 0x80]).expect("valid program");
        let bytes = bencodex::to_vec(&p).expect("should serialize");
        let back: Program = bencodex::from_slice(&bytes).expect("should deserialize");
        assert_eq!(back.0, p.0);
    }

    #[test]
    fn rejects_empty_bytes() {
        assert!(Program::from_bytes(&[]).is_err());
    }

    #[test]
    fn rejects_malformed_and_trailing_bytes() {
        assert!(Program::from_bytes(&[0xff]).is_err());
        assert!(Program::from_bytes(&[0x80, 0x80]).is_err());
    }

    #[test]
    fn canonical_nil_is_nil() {
        assert!(Program::from_bytes(&[0x80])
            .expect("canonical nil")
            .is_nil());
    }

    #[test]
    fn invalid_empty_value_cannot_be_recognized_as_nil() {
        assert!(Program::from_bytes(&[]).is_err());
    }

    #[test]
    fn bencodex_rejects_invalid_program_bytes() {
        let encoded = bencodex::to_vec(&RawBytes(vec![0x80, 0x80])).expect("should encode bytes");
        assert!(bencodex::from_slice::<Program>(&encoded).is_err());
    }
}
