use serde::{Deserialize, Serialize};

use crate::common::types::{Aggsig, CoinString, Program, ProgramRef, Puzzle};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Spend {
    pub puzzle: Puzzle,
    pub solution: ProgramRef,
    pub signature: Aggsig,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct CoinSpend {
    pub coin: CoinString,
    pub bundle: Spend,
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

/// Maximum information about a coin spend.  Everything one might need downstream.
pub struct BrokenOutCoinSpendInfo {
    pub solution: ProgramRef,
    pub conditions: ProgramRef,
    pub message: Vec<u8>,
    pub signature: Aggsig,
}
