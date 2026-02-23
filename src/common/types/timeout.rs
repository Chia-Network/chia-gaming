use std::ops::Add;

use serde::{Deserialize, Serialize};

use clvmr::allocator::NodePtr;

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};

use crate::common::types::{atom_from_clvm, u64_from_atom, AllocEncoder, Error};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, PartialOrd, Ord)]
pub struct Timeout(u64);

impl Timeout {
    pub fn new(t: u64) -> Self {
        Timeout(t)
    }

    pub fn to_u64(&self) -> u64 {
        self.0
    }

    pub fn from_clvm(allocator: &AllocEncoder, clvm: NodePtr) -> Result<Self, Error> {
        if let Some(amt) = atom_from_clvm(allocator, clvm).and_then(|a| u64_from_atom(&a)) {
            Ok(Timeout::new(amt))
        } else {
            Err(Error::StrErr("bad timeout".to_string()))
        }
    }
}

impl Add for Timeout {
    type Output = Timeout;

    fn add(self, rhs: Self) -> Timeout {
        Timeout::new(self.0 + rhs.0)
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Timeout {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}
