use serde::{Deserialize, Serialize};

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::allocator::{NodePtr, SExp};
use clvmr::Allocator;

use crate::common::types::error::Error;

pub struct AllocEncoder(pub Allocator);
impl Default for AllocEncoder {
    fn default() -> Self {
        AllocEncoder(Allocator::new())
    }
}

impl AllocEncoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn allocator(&mut self) -> &mut Allocator {
        &mut self.0
    }
}

impl ToClvm<AllocEncoder> for NodePtr {
    fn to_clvm(&self, _encoder: &mut AllocEncoder) -> Result<NodePtr, ToClvmError> {
        Ok(*self)
    }
}

impl ClvmEncoder for AllocEncoder {
    type Node = NodePtr;

    fn encode_atom(&mut self, bytes: clvm_traits::Atom<'_>) -> Result<Self::Node, ToClvmError> {
        self.0
            .new_atom(&bytes)
            .map_err(|e| ToClvmError::Custom(format!("{e:?}")))
    }

    fn encode_pair(
        &mut self,
        first: Self::Node,
        rest: Self::Node,
    ) -> Result<Self::Node, ToClvmError> {
        self.0
            .new_pair(first, rest)
            .map_err(|e| ToClvmError::Custom(format!("{e:?}")))
    }
}

use sha2::{Digest, Sha256};
#[derive(Clone, Eq, PartialEq, Serialize, Deserialize, Hash, Default)]
pub struct Hash(pub [u8; 32]);
#[derive(Debug)]
pub enum Sha256Input<'a> {
    Bytes(&'a [u8]),
    Hashed(Vec<Sha256Input<'a>>),
    Hash(&'a Hash),
    Array(Vec<Sha256Input<'a>>),
}

impl Sha256Input<'_> {
    fn update(&self, hasher: &mut Sha256) {
        match self {
            Sha256Input::Bytes(b) => {
                hasher.update(b);
            }
            Sha256Input::Hash(hash) => {
                hasher.update(hash.bytes());
            }
            Sha256Input::Hashed(input) => {
                let mut new_hasher = Sha256::new();
                for i in input.iter() {
                    i.update(&mut new_hasher);
                }
                let result = new_hasher.finalize();
                hasher.update(&result[..]);
            }
            Sha256Input::Array(inputs) => {
                for i in inputs.iter() {
                    i.update(hasher);
                }
            }
        }
    }

    pub fn hash(&self) -> Hash {
        let mut hasher = Sha256::new();
        self.update(&mut hasher);
        let result = hasher.finalize();
        Hash::from_slice(&result[..])
    }
}
pub fn atom_from_clvm(allocator: &mut AllocEncoder, n: NodePtr) -> Option<Vec<u8>> {
    if matches!(allocator.allocator().sexp(n), SExp::Atom) {
        Some(allocator.allocator().atom(n).to_vec())
    } else {
        None
    }
}

impl Hash {
    pub fn new(by: &[u8]) -> Hash {
        Sha256Input::Bytes(by).hash()
    }
    pub fn from_bytes(by: [u8; 32]) -> Hash {
        Hash(by)
    }
    pub fn from_slice(by: &[u8]) -> Hash {
        let mut fixed: [u8; 32] = [0; 32];
        for (i, b) in by.iter().enumerate().take(32) {
            fixed[i % 32] = *b;
        }
        Hash::from_bytes(fixed)
    }
    pub fn from_nodeptr(allocator: &mut AllocEncoder, n: NodePtr) -> Result<Hash, Error> {
        if let Some(bytes) = atom_from_clvm(allocator, n) {
            return Ok(Hash::from_slice(&bytes));
        }

        Err(Error::StrErr("can't convert node to hash".to_string()))
    }
    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

/// CoinID
#[derive(Default, Clone, Debug, Serialize, Deserialize, Eq, PartialEq, Hash)]
pub struct CoinID(pub Hash);

impl CoinID {
    pub fn new(h: Hash) -> CoinID {
        CoinID(h)
    }
    pub fn bytes(&self) -> &[u8] {
        self.0.bytes()
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for CoinID {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}
