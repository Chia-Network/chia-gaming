use std::rc::Rc;

use clvm_traits::{ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;

use crate::common::types::{AllocEncoder, Error, Hash, Program, ProgramRef, Sha256tree};
use serde::{Deserialize, Serialize};

/// Represents a validation program, as opposed to validation info or any of the
/// other kinds of things that are related.
///
/// This can give a validation program hash or a validation info hash, given state.
#[derive(Clone, Serialize, Deserialize, Eq, PartialEq)]
pub struct StateUpdateProgram {
    name: String,
    state_update_program: ProgramRef,
    state_update_program_hash: Hash,
}

impl std::fmt::Debug for StateUpdateProgram {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(formatter, "StateUpdateProgram\n    name={}\n    hash={:?}\n",
        self.name,
        self.state_update_program_hash,
    )
    }
}

impl StateUpdateProgram {
    pub fn new(
        allocator: &mut AllocEncoder,
        name: &str,
        state_update_program: Rc<Program>,
    ) -> Self {
        let state_update_program_hash = state_update_program.sha256tree(allocator).hash().clone();
        StateUpdateProgram {
            name: name.to_string(),
            state_update_program: state_update_program.into(),
            state_update_program_hash,
        }
    }

    pub fn new_hash(
        state_update_program: Rc<Program>,
        name: &str,
        state_update_program_hash: Hash,
    ) -> Self {
        StateUpdateProgram {
            name: name.to_string(),
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

pub trait HasStateUpdateProgram {
    fn p(&self) -> StateUpdateProgram;
    fn name(&self) -> String {
        self.p().name.clone()
    }
}

impl HasStateUpdateProgram for StateUpdateProgram {
    fn p(&self) -> StateUpdateProgram {
        self.clone()
    }
}
