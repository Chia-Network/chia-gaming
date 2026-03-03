use std::rc::Rc;

use crate::channel_handler::types::StateUpdateProgram;
use crate::common::types::{AllocEncoder, Hash, Program, Sha256Input, Sha256tree};

/// The pair of state and validation program is the source of the validation hash
#[derive(Clone, Debug, Eq)]
pub enum ValidationInfo {
    FromStateUpdate {
        game_state: Rc<Program>,
        state_update_program: StateUpdateProgram,
        hash: Hash,
    },
    FromHash {
        hash: Hash,
    },
}

impl PartialEq for ValidationInfo {
    fn eq(&self, other: &Self) -> bool {
        self.hash() == other.hash()
    }
}

impl ValidationInfo {
    pub fn new_state_update(
        allocator: &mut AllocEncoder,
        state_update_program: StateUpdateProgram,
        game_state: Rc<Program>,
    ) -> Self {
        let hash = Sha256Input::Array(vec![
            Sha256Input::Hash(state_update_program.hash()),
            Sha256Input::Hash(game_state.sha256tree(allocator).hash()),
        ])
        .hash();
        ValidationInfo::FromStateUpdate {
            game_state,
            state_update_program,
            hash,
        }
    }
    pub fn new_hash(hash: Hash) -> Self {
        ValidationInfo::FromHash { hash }
    }
    pub fn hash(&self) -> &Hash {
        match self {
            ValidationInfo::FromStateUpdate { hash, .. } | ValidationInfo::FromHash { hash } => {
                hash
            }
        }
    }
}
