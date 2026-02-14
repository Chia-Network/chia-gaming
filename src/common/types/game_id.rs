use serde::{Deserialize, Serialize};

use clvmr::allocator::NodePtr;

use crate::common::types::{atom_from_clvm, AllocEncoder, Error};

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};

/// Game ID
#[derive(Default, Clone, Debug, Eq, PartialEq, Serialize, Deserialize, Hash)]
pub struct GameID(Vec<u8>);

impl GameID {
    pub fn new(s: Vec<u8>) -> GameID {
        GameID(s)
    }

    pub fn from_clvm(allocator: &AllocEncoder, clvm: NodePtr) -> Result<Self, Error> {
        if let Some(atom) = atom_from_clvm(allocator, clvm) {
            Ok(GameID::new(atom.to_vec()))
        } else {
            Err(Error::StrErr("bad game id".to_string()))
        }
    }
}

impl GameID {
    pub fn from_bytes(s: &[u8]) -> GameID {
        GameID(s.to_vec())
    }

    pub fn to_bytes(&self) -> &[u8] {
        &self.0
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for GameID {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        encoder.encode_atom(clvm_traits::Atom::Borrowed(&self.0))
    }
}
