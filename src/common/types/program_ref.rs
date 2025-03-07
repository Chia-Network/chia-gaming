use std::borrow::Borrow;
use std::rc::Rc;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;

use crate::common::types::{AllocEncoder, Error, Program};

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct ProgramRef(Rc<Program>);

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for ProgramRef {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}

impl From<Rc<Program>> for ProgramRef {
    fn from(other: Rc<Program>) -> Self {
        ProgramRef::new(other)
    }
}

impl From<Program> for ProgramRef {
    fn from(other: Program) -> Self {
        ProgramRef::new(Rc::new(other))
    }
}

impl ProgramRef {
    pub fn new(p: Rc<Program>) -> Self {
        ProgramRef(p)
    }
    pub fn p(&self) -> Rc<Program> {
        self.0.clone()
    }
    pub fn pref(&self) -> &Program {
        self.0.borrow()
    }
    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        self.0.to_nodeptr(allocator)
    }
}

impl Serialize for ProgramRef {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        self.pref().serialize(serializer)
    }
}

impl<'de> Deserialize<'de> for ProgramRef {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        let ser: Program = Program::deserialize(deserializer)?;
        Ok(ProgramRef(Rc::new(ser)))
    }
}
