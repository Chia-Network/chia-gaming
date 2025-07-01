use clvm_traits::{ClvmEncoder, ToClvm, ToClvmError};
use clvmr::NodePtr;
use serde::{Deserialize, Serialize};

use crate::common::types::atom_from_clvm;
use crate::common::types::{
    Aggsig, AllocEncoder, CoinString, Error, Node, Program, ProgramRef, Puzzle,
};
use crate::utils::proper_list;

#[derive(Clone, Debug, Serialize, Deserialize, Eq, PartialEq)]
pub struct Spend {
    pub puzzle: Puzzle,
    pub solution: ProgramRef,
    pub signature: Aggsig,
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for Spend {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        (
            self.puzzle.clone(),
            (self.solution.clone(), (self.signature.clone(), ())),
        )
            .to_clvm(encoder)
    }
}

impl Spend {
    pub fn from_clvm(allocator: &mut AllocEncoder, data: NodePtr) -> Result<Spend, Error> {
        let lst = if let Some(lst) = proper_list(allocator.allocator(), data, true) {
            lst
        } else {
            return Err(Error::StrErr("not list".to_string()));
        };

        if lst.len() < 3 {
            return Err(Error::StrErr("bad length".to_string()));
        }

        let puzzle = Puzzle::from_nodeptr(allocator, lst[0])?;
        let solution = Program::from_nodeptr(allocator, lst[1])?;
        let signature_atom = if let Some(s) = atom_from_clvm(allocator, lst[2]) {
            s
        } else {
            return Err(Error::StrErr("bad sig".to_string()));
        };

        let signature = Aggsig::from_slice(&signature_atom)?;
        Ok(Spend {
            puzzle,
            solution: solution.into(),
            signature,
        })
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CoinSpend {
    pub coin: CoinString,
    pub bundle: Spend,
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for CoinSpend {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        let cs_bytes = self.coin.to_bytes();
        let cs_atom = encoder.encode_atom(clvm_traits::Atom::Borrowed(&cs_bytes))?;
        (Node(cs_atom), (self.bundle.clone(), ())).to_clvm(encoder)
    }
}

impl CoinSpend {
    pub fn from_clvm(allocator: &mut AllocEncoder, data: NodePtr) -> Result<CoinSpend, Error> {
        let lst = if let Some(lst) = proper_list(allocator.allocator(), data, true) {
            lst
        } else {
            return Err(Error::StrErr("bad list".to_string()));
        };

        if lst.len() < 2 {
            return Err(Error::StrErr("bad length".to_string()));
        }

        let coin_bytes = if let Some(by) = atom_from_clvm(allocator, lst[0]) {
            by
        } else {
            return Err(Error::StrErr("bad coin".to_string()));
        };

        let coin = CoinString::from_bytes(&coin_bytes);
        let bundle = Spend::from_clvm(allocator, lst[1])?;

        Ok(CoinSpend { coin, bundle })
    }
}

impl Default for Spend {
    fn default() -> Self {
        Spend {
            puzzle: Puzzle::from_bytes(&[0x80]),
            solution: Program::from_bytes(&[0x80]).into(),
            signature: Aggsig::default(),
        }
    }
}

pub struct SpendRewardResult {
    pub coins_with_solutions: Vec<CoinSpend>,
    pub result_coin_string_up: CoinString,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SpendBundle {
    pub name: Option<String>,
    pub spends: Vec<CoinSpend>,
}

impl<E: ClvmEncoder<Node = NodePtr>> ToClvm<E> for SpendBundle {
    fn to_clvm(&self, encoder: &mut E) -> Result<<E as ClvmEncoder>::Node, ToClvmError> {
        self.spends.to_clvm(encoder)
    }
}

impl SpendBundle {
    pub fn from_clvm(allocator: &mut AllocEncoder, data: NodePtr) -> Result<SpendBundle, Error> {
        let lst = if let Some(lst) = proper_list(allocator.allocator(), data, true) {
            lst
        } else {
            return Err(Error::StrErr("bad list".to_string()));
        };

        let mut spends = Vec::new();
        for b in lst.iter() {
            let cs = CoinSpend::from_clvm(allocator, *b)?;
            spends.push(cs);
        }

        Ok(SpendBundle { name: None, spends })
    }
}

/// Maximum information about a coin spend.  Everything one might need downstream.
pub struct BrokenOutCoinSpendInfo {
    pub solution: ProgramRef,
    pub conditions: ProgramRef,
    pub message: Vec<u8>,
    pub signature: Aggsig,
}
