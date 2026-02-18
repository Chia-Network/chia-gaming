use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::allocator::NodePtr;
use clvmr::Allocator;

pub struct AllocEncoder(pub Allocator);
impl Default for AllocEncoder {
    fn default() -> Self {
        AllocEncoder(Allocator::new())
    }
}

impl AllocEncoder {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn allocator_ref(&self) -> &Allocator {
        &self.0
    }

    pub fn allocator(&mut self) -> &mut Allocator {
        &mut self.0
    }
}

impl ToClvm<AllocEncoder> for NodePtr {
    fn to_clvm(&self, _encoder: &mut AllocEncoder) -> Result<NodePtr, ToClvmError> {
        Ok(*self)
    }
}

impl ClvmEncoder for AllocEncoder {
    type Node = NodePtr;

    fn encode_atom(&mut self, bytes: clvm_traits::Atom<'_>) -> Result<Self::Node, ToClvmError> {
        self.0
            .new_atom(&bytes)
            .map_err(|e| ToClvmError::Custom(format!("{e:?}")))
    }

    fn encode_pair(
        &mut self,
        first: Self::Node,
        rest: Self::Node,
    ) -> Result<Self::Node, ToClvmError> {
        self.0
            .new_pair(first, rest)
            .map_err(|e| ToClvmError::Custom(format!("{e:?}")))
    }
}
