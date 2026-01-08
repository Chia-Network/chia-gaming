use crate::common::types::{Aggsig, GameID, Program, Spend};
use std::rc::Rc;

#[derive(Clone, Debug)]
pub struct ChannelCoinSpentResult {
    pub transaction: Spend,
    pub timeout: bool,
    pub games_canceled: Vec<GameID>,
}

#[derive(Clone, Debug)]
pub struct ChannelCoinSpendInfo {
    pub solution: Rc<Program>,
    pub conditions: Rc<Program>,
    pub aggsig: Aggsig,
}
