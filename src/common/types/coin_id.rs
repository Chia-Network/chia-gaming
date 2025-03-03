use serde::{Deserialize, Serialize};

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;

use crate::common::types::Hash as Hash32;

/// CoinID
#[derive(Default, Clone, Debug, Serialize, Deserialize, Eq, PartialEq, Hash)]
pub struct CoinID(pub Hash32);

impl CoinID {
    pub fn new(h: Hash32) -> CoinID {
        CoinID(h)
    }
    pub fn bytes(&self) -> &[u8] {
        self.0.bytes()
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for CoinID {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        self.0.to_clvm(encoder)
    }
}
