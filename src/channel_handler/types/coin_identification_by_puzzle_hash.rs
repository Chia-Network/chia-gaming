use crate::common::types::{Amount, PuzzleHash};

#[derive(Debug)]
pub enum CoinIdentificationByPuzzleHash {
    Reward(PuzzleHash, Amount),
    Game(PuzzleHash, Amount),
}
