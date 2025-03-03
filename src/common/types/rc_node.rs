use std::borrow::Borrow;
use std::rc::Rc;

use clvmr::allocator::NodePtr;

use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};

pub struct RcNode<X>(Rc<X>);

impl<E: ClvmEncoder<Node = NodePtr>, X: ToClvm<E>> ToClvm<E> for RcNode<X> {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        let borrowed: &X = self.0.borrow();
        borrowed.to_clvm(encoder)
    }
}

impl<X> RcNode<X> {
    pub fn new(node: Rc<X>) -> Self {
        RcNode(node.clone())
    }
}

impl<X> From<&Rc<X>> for RcNode<X> {
    fn from(item: &Rc<X>) -> RcNode<X> {
        RcNode(item.clone())
    }
}
