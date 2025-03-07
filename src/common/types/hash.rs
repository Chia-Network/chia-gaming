use serde::{Deserialize, Serialize};

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;

#[derive(Clone, Eq, PartialEq, Serialize, Deserialize, Hash, Default)]
pub struct Hash(pub [u8; 32]);

/// CoinID
#[derive(Default, Clone, Debug, Serialize, Deserialize, Eq, PartialEq, Hash)]
pub struct CoinID(pub Hash);

impl CoinID {
    pub fn new(h: Hash) -> CoinID {
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
