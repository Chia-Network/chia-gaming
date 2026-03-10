use serde::{Deserialize, Serialize};

use clvmr::allocator::NodePtr;

use crate::common::types::{atom_from_clvm, u64_from_atom, AllocEncoder, Error};

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};

/// Game ID — a nonce number that uniquely identifies a game within a channel.
#[derive(Default, Copy, Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Hash)]
pub struct GameID(pub u64);

impl GameID {
    pub fn from_clvm(allocator: &AllocEncoder, clvm: NodePtr) -> Result<Self, Error> {
        if let Some(atom) = atom_from_clvm(allocator, clvm) {
            u64_from_atom(&atom)
                .map(GameID)
                .ok_or_else(|| Error::StrErr("game id atom too large for u64".to_string()))
        } else {
            Err(Error::StrErr("bad game id".to_string()))
        }
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for GameID {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}
