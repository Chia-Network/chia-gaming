use std::rc::Rc;

use clvm_traits::{ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;

use serde::{Deserialize, Serialize};

use crate::common::types::{AllocEncoder, Error, Program};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ReadableMove(Rc<Program>);

impl ReadableMove {
    pub fn from_nodeptr(allocator: &mut AllocEncoder, n: NodePtr) -> Result<Self, Error> {
        Ok(ReadableMove(Rc::new(Program::from_nodeptr(allocator, n)?)))
    }

    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        self.0.to_nodeptr(allocator)
    }

    pub fn from_program(p: Rc<Program>) -> Self {
        ReadableMove(p)
    }

    pub fn to_program(&self) -> &Program {
        &self.0
    }
}

impl ToClvm<AllocEncoder> for ReadableMove {
    fn to_clvm(&self, encoder: &mut AllocEncoder) -> Result<NodePtr, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}
