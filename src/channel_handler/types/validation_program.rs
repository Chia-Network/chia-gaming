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
pub struct ValidationProgram {
    validation_program: ProgramRef,
    validation_program_hash: Hash,
}

impl ValidationProgram {
    pub fn new(allocator: &mut AllocEncoder, validation_program: Rc<Program>) -> Self {
        let validation_program_hash = validation_program.sha256tree(allocator).hash().clone();
        ValidationProgram {
            validation_program: validation_program.into(),
            validation_program_hash,
        }
    }

    pub fn new_hash(validation_program: Rc<Program>, validation_program_hash: Hash) -> Self {
        ValidationProgram {
            validation_program: validation_program.into(),
            validation_program_hash,
        }
    }

    pub fn to_program(&self) -> Rc<Program> {
        self.validation_program.p()
    }

    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        self.validation_program.to_nodeptr(allocator)
    }

    pub fn hash(&self) -> &Hash {
        &self.validation_program_hash
    }
}

impl ToClvm<AllocEncoder> for ValidationProgram {
    fn to_clvm(&self, encoder: &mut AllocEncoder) -> Result<NodePtr, ToClvmError> {
        self.validation_program.to_clvm(encoder)
    }
}
