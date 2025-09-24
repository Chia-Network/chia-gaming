use super::accept_transaction_state::AcceptTransactionState;
use crate::common::types::{GameID, PuzzleHash};

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct OnChainGameState {
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub our_turn: bool,
    pub state_number: usize,
    pub accept: AcceptTransactionState,
}
