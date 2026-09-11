use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::allocator::{NodePtr, SExp};
use std::rc::Rc;

use crate::common::types::{Aggsig, AllocEncoder, Error, Program};
use crate::utils::proper_list;

#[derive(Debug, Clone, Eq, PartialEq)]
pub struct Evidence {
    program: Rc<Program>,
    signature: Option<Aggsig>,
}

impl Evidence {
    pub fn new(p: Rc<Program>) -> Self {
        Evidence {
            program: p,
            signature: None,
        }
    }

    pub fn with_signature(program: Rc<Program>, signature: Aggsig) -> Self {
        Evidence {
            program,
            signature: Some(signature),
        }
    }

    pub fn from_nodeptr(allocator: &mut AllocEncoder, n: NodePtr) -> Result<Evidence, Error> {
        if let Some(items) = proper_list(allocator.allocator(), n, true) {
            if items.len() == 3
                && matches!(allocator.allocator().sexp(items[0]), SExp::Atom)
                && allocator.allocator().atom(items[0]).as_ref() == b"s"
            {
                return Ok(Evidence {
                    program: Rc::new(Program::from_nodeptr(allocator, items[1])?),
                    signature: Some(Aggsig::from_slice(
                        allocator.allocator().atom(items[2]).as_ref(),
                    )?),
                });
            }
        }
        Ok(Evidence::new(Rc::new(Program::from_nodeptr(allocator, n)?)))
    }

    pub fn nil() -> Result<Evidence, Error> {
        Ok(Evidence::new(Rc::new(Program::from_hex("80")?)))
    }

    pub fn to_nodeptr(&self, allocator: &mut AllocEncoder) -> Result<NodePtr, Error> {
        self.program.to_nodeptr(allocator)
    }

    pub fn to_program(&self) -> Rc<Program> {
        self.program.clone()
    }

    pub fn signature(&self) -> Option<&Aggsig> {
        self.signature.as_ref()
    }
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Evidence {
    fn to_clvm(&self, encoder: &mut E) -> Result<NodePtr, ToClvmError> {
        self.program.to_clvm(encoder)
    }
}
