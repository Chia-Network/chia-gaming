use std::rc::Rc;

use serde::{Deserialize, Serialize};

use clvmr::allocator::NodePtr;

use clvmr::serde::node_to_bytes;

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};

use crate::common::types::{AllocEncoder, Error, IntoErr, Program, ProgramRef};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Puzzle(ProgramRef);

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Puzzle {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}

impl From<Program> for Puzzle {
    fn from(other: Program) -> Self {
        Puzzle(other.into())
    }
}

impl From<Rc<Program>> for Puzzle {
    fn from(other: Rc<Program>) -> Self {
        Puzzle(other.into())
    }
}

impl From<ProgramRef> for Puzzle {
    fn from(other: ProgramRef) -> Self {
        Puzzle(other)
    }
}

impl Puzzle {
    pub fn to_program(&self) -> Rc<Program> {
        self.0.p()
    }
    pub fn from_bytes(by: &[u8]) -> Puzzle {
        Puzzle(Program::from_bytes(by).into())
    }
    pub fn from_nodeptr(allocator: &mut AllocEncoder, node: NodePtr) -> Result<Puzzle, Error> {
        let bytes = node_to_bytes(allocator.allocator(), node).into_gen()?;
        Ok(Puzzle::from_bytes(&bytes))
    }
    pub fn to_hex(&self) -> String {
        self.to_program().to_hex()
    }
}
