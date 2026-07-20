use crate::common::types::{Amount, PuzzleHash};
use crate::referee::types::TheirTurnCoinSpentResult;

#[derive(Debug)]
pub enum CoinSpentInformation {
    OurReward(PuzzleHash, Amount),
    TheirSpend(TheirTurnCoinSpentResult),
}
