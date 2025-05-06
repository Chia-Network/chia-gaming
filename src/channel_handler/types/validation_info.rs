use clvmr::allocator::NodePtr;

use crate::channel_handler::types::StateUpdateProgram;
use crate::common::types::{AllocEncoder, Hash, Node, Sha256Input, Sha256tree};

/// The pair of state and validation program is the source of the validation hash
#[derive(Clone, Debug, Eq)]
pub enum ValidationInfo<StateT: Sha256tree> {
    FromProgram {
        game_state: StateT,
        state_update_program: StateUpdateProgram,
        hash: Hash,
    },
    FromProgramHash {
        game_state: StateT,
        state_update_program_hash: Hash,
        hash: Hash,
    },
    FromHash {
        hash: Hash,
    },
}

impl<StateT: Sha256tree> PartialEq<Self> for ValidationInfo<StateT>
{
    fn eq(&self, other: &Self) -> bool {
        self.hash() == other.hash()
    }
}

impl<StateT: Sha256tree> ValidationInfo<StateT> {
    pub fn new(
        allocator: &mut AllocEncoder,
        state_update_program: StateUpdateProgram,
        game_state: StateT,
    ) -> Self {
        let hash = Sha256Input::Array(vec![
            Sha256Input::Hash(state_update_program.hash()),
            Sha256Input::Hash(game_state.sha256tree(allocator).hash()),
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
        game_state: StateT,
    ) -> Self {
        let hash = Sha256Input::Array(vec![
            Sha256Input::Hash(&state_update_program_hash),
            Sha256Input::Hash(game_state.sha256tree(allocator).hash()),
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
