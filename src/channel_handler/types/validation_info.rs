use clvmr::allocator::NodePtr;

use crate::channel_handler::types::StateUpdateProgram;
use crate::common::types::{AllocEncoder, Hash, Node, Sha256Input, Sha256tree};

/// The pair of state and validation program is the source of the validation hash
#[derive(Clone, Debug, Eq)]
pub enum ValidationInfo {
    FromProgram {
        game_state: NodePtr,
        state_update_program: StateUpdateProgram,
        hash: Hash,
    },
    FromProgramHash {
        game_state: NodePtr,
        state_update_program_hash: Hash,
        hash: Hash,
    },
    FromHash {
        hash: Hash,
    },
}

impl PartialEq<Self> for ValidationInfo {
    fn eq(&self, other: &Self) -> bool {
        self.hash() == other.hash()
    }
}

impl ValidationInfo {
    pub fn new(
        allocator: &mut AllocEncoder,
        state_update_program: StateUpdateProgram,
        game_state: NodePtr,
    ) -> Self {
        let hash = Sha256Input::Array(vec![
            Sha256Input::Hash(state_update_program.hash()),
            Sha256Input::Hash(Node(game_state).sha256tree(allocator).hash()),
        ])
        .hash();
        ValidationInfo::FromProgram {
            game_state,
            state_update_program,
            hash,
        }
    }
    pub fn new_hash(hash: Hash) -> Self {
        ValidationInfo::FromHash { hash }
    }
    pub fn new_from_state_update_program_hash_and_state(
        allocator: &mut AllocEncoder,
        state_update_program_hash: Hash,
        game_state: NodePtr,
    ) -> Self {
        let hash = Sha256Input::Array(vec![
            Sha256Input::Hash(&state_update_program_hash),
            Sha256Input::Hash(Node(game_state).sha256tree(allocator).hash()),
        ])
        .hash();
        ValidationInfo::FromProgramHash {
            game_state,
            state_update_program_hash,
            hash,
        }
    }
    pub fn hash(&self) -> &Hash {
        match self {
            ValidationInfo::FromProgramHash { hash, .. }
            | ValidationInfo::FromProgram { hash, .. }
            | ValidationInfo::FromHash { hash } => hash,
        }
    }
}
