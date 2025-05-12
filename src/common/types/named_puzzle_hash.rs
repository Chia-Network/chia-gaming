use serde::{Deserialize, Serialize};

use rand::distributions::Standard;
use rand::prelude::*;

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;

use crate::common::types::Hash;
use crate::common::types::PuzzleHash;


#[derive(Default, Clone, Eq, PartialEq, Serialize, Deserialize, Hash)]
pub struct NamedPuzzleHash {
    name: String,
    puzzle_hash: PuzzleHash,
}


impl NamedPuzzleHash {
    pub fn new(name: Sting, puzzle_hash: PuzzleHash) -> Self {
        NamedPuzzleHash{name, puzzle_hash}
    }
}

impl std::fmt::Debug for NamedPuzzleHash {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(formatter, "NamedPuzzleHash\n    name={}\n    hash={:?}\n",
        self.name,
        self.puzzle_hash,
    )
    }
}
