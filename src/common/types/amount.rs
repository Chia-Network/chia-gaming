use serde::{Deserialize, Serialize};
use std::ops::{Add, AddAssign};

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;

use crate::common::types::{atom_from_clvm, u64_from_atom, AllocEncoder, Error};

/// Amount
#[derive(Default, Clone, Debug, Eq, PartialEq, Ord, PartialOrd, Serialize, Deserialize)]
pub struct Amount(u64);

impl Amount {
    pub fn new(amt: u64) -> Amount {
        Amount(amt)
    }

    pub fn half(&self) -> Amount {
        Amount::new(self.0 / 2)
    }

    pub fn to_u64(&self) -> u64 {
        self.0
    }

    pub fn checked_sub(&self, rhs: &Amount) -> Result<Amount, Error> {
        debug_assert!(self.0 >= rhs.0, "Amount underflow: {} - {}", self.0, rhs.0);
        self.0
            .checked_sub(rhs.0)
            .map(Amount)
            .ok_or_else(|| Error::StrErr(format!("Amount underflow: {} - {}", self.0, rhs.0)))
    }

    pub fn from_clvm(allocator: &AllocEncoder, clvm: NodePtr) -> Result<Amount, Error> {
        if let Some(val) = atom_from_clvm(allocator, clvm).and_then(|a| u64_from_atom(&a)) {
            Ok(Amount::new(val))
        } else {
            Err(Error::StrErr("bad amount".to_string()))
        }
    }
}

impl std::fmt::Display for Amount {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.0)
    }
}

impl AddAssign for Amount {
    fn add_assign(&mut self, rhs: Self) {
        self.0 += rhs.0;
    }
}

impl Add for Amount {
    type Output = Amount;

    fn add(mut self, rhs: Self) -> Amount {
        self += rhs;
        self
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Amount {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}

impl From<Amount> for u64 {
    fn from(amt: Amount) -> Self {
        amt.0
    }
}
