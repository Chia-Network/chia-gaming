use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;
use std::rc::Rc;

use crate::common::types::{AllocEncoder, Error, Program};

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct Evidence(Rc<Program>);

impl Evidence {
    pub fn new(program: Rc<Program>) -> Self {
        Evidence(program)
    }
    pub fn from_nodeptr(allocator: &mut AllocEncoder, n: NodePtr) -> Result<Evidence, Error> {
        Ok(Evidence(Rc::new(Program::from_nodeptr(allocator, n)?)))
    }

    pub fn nil() -> Result<Evidence, Error> {
        Ok(Evidence(Rc::new(Program::from_hex("80")?)))
    }

    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        self.0.to_nodeptr(allocator)
    }

    pub fn to_program(&self) -> Rc<Program> {
        self.0.clone()
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Evidence {
    fn to_clvm(&self, encoder: &mut E) -> Result<NodePtr, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}
