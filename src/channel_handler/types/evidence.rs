use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;

use crate::common::types::AllocEncoder;

#[derive(Debug, Clone)]
pub struct Evidence(NodePtr);

impl Evidence {
    pub fn from_nodeptr(n: NodePtr) -> Evidence {
        Evidence(n)
    }

    pub fn nil(allocator: &mut AllocEncoder) -> Evidence {
        Evidence(allocator.allocator().nil())
    }

    pub fn to_nodeptr(&self) -> NodePtr {
        self.0
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Evidence {
    fn to_clvm(&self, _encoder: &mut E) -> Result<NodePtr, ToClvmError> {
        Ok(self.0)
    }
}
