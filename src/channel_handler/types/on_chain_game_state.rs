use super::accept_transaction_state::AcceptTransactionState;
use crate::common::types::{Amount, GameID, PuzzleHash, Timeout};

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct OnChainGameState {
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub our_turn: bool,
    pub state_number: usize,
    pub accept: AcceptTransactionState,
    pub pending_slash_amount: Option<Amount>,
    pub cheating_move_mover_share: Option<Amount>,
    pub accepted: bool,
    pub notification_sent: bool,
    pub game_timeout: Timeout,
    pub game_finished: bool,
}
