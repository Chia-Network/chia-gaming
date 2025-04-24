use std::rc::Rc;

use clvm_traits::{ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;

use crate::common::types::{AllocEncoder, Error, Hash, Program, ProgramRef, Sha256tree};
use serde::{Deserialize, Serialize};

/// Represents a validation program, as opposed to validation info or any of the
/// other kinds of things that are related.
///
/// This can give a validation program hash or a validation info hash, given state.
#[derive(Debug, Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct StateUpdateProgram {
    state_update_program: ProgramRef,
    state_update_program_hash: Hash,
}

impl StateUpdateProgram {
    pub fn new(allocator: &mut AllocEncoder, state_update_program: Rc<Program>) -> Self {
        let state_update_program_hash = state_update_program.sha256tree(allocator).hash().clone();
        StateUpdateProgram {
            state_update_program: state_update_program.into(),
            state_update_program_hash,
        }
    }

    pub fn new_hash(state_update_program: Rc<Program>, state_update_program_hash: Hash) -> Self {
        StateUpdateProgram {
            state_update_program: state_update_program.into(),
            state_update_program_hash,
        }
    }

    pub fn to_program(&self) -> Rc<Program> {
        self.state_update_program.p()
    }

    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        self.state_update_program.to_nodeptr(allocator)
    }

    pub fn hash(&self) -> &Hash {
        &self.state_update_program_hash
    }
}

impl ToClvm<AllocEncoder> for StateUpdateProgram {
    fn to_clvm(&self, encoder: &mut AllocEncoder) -> Result<NodePtr, ToClvmError> {
        self.state_update_program.to_clvm(encoder)
    }
}
