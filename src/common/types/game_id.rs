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

    pub fn from_clvm(allocator: &mut AllocEncoder, clvm: NodePtr) -> Result<Self, Error> {
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

    pub fn from_nonce(n: usize) -> GameID {
        if n == 0 {
            return GameID(Vec::new());
        }
        let bytes = (n as u64).to_be_bytes();
        let start = bytes.iter().position(|&b| b != 0).unwrap();
        GameID(bytes[start..].to_vec())
    }

    pub fn to_nonce(&self) -> Option<usize> {
        if self.0.len() > 8 {
            return None;
        }
        let mut result: u64 = 0;
        for &b in &self.0 {
            result = (result << 8) | (b as u64);
        }
        Some(result as usize)
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for GameID {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        encoder.encode_atom(clvm_traits::Atom::Borrowed(&self.0))
    }
}
