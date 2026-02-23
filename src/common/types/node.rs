use clvmr::allocator::NodePtr;
use clvmr::serde::node_to_bytes;
use clvmr::Allocator;

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};

use crate::common::types::{AllocEncoder, Error, IntoErr};

#[derive(Clone, Debug)]
pub struct Node(pub NodePtr);

impl Default for Node {
    fn default() -> Node {
        let allocator = Allocator::new();
        Node(allocator.nil())
    }
}

impl Node {
    pub fn to_hex(&self, allocator: &AllocEncoder) -> Result<String, Error> {
        let bytes = node_to_bytes(allocator.allocator_ref(), self.0).into_gen()?;
        Ok(hex::encode(bytes))
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Node {
    fn to_clvm(&self, _encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        Ok(self.0)
    }
}
