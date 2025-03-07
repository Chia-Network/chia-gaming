use serde::{Deserialize, Serialize};

use rand::distributions::Standard;
use rand::prelude::*;

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;

use crate::common::types::Hash;

/// Puzzle hash
#[derive(Default, Clone, Eq, PartialEq, Debug, Serialize, Deserialize, Hash)]
pub struct PuzzleHash(Hash);

impl PuzzleHash {
    pub fn from_bytes(by: [u8; 32]) -> PuzzleHash {
        PuzzleHash(Hash::from_bytes(by))
    }
    pub fn from_hash(h: Hash) -> PuzzleHash {
        PuzzleHash(h)
    }
    pub fn bytes(&self) -> &[u8] {
        self.0.bytes()
    }
    pub fn hash(&self) -> &Hash {
        &self.0
    }
}

impl Distribution<PuzzleHash> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> PuzzleHash {
        PuzzleHash::from_hash(rng.gen())
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for PuzzleHash {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        encoder.encode_atom(clvm_traits::Atom::Borrowed(&self.0 .0))
    }
}
