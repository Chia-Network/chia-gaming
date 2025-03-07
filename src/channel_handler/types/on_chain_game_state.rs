use super::accept_transaction_state::AcceptTransactionState;
use crate::common::types::{GameID, PuzzleHash};

#[derive(Debug)]
pub struct OnChainGameState {
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub our_turn: bool,
    pub accept: AcceptTransactionState,
}
