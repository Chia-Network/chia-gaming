use super::accept_transaction_state::AcceptTransactionState;
use crate::common::types::{Amount, GameID, PuzzleHash, Timeout};

use serde::{Deserialize, Serialize};

fn default_game_timeout() -> Timeout {
    Timeout::new(10)
}

#[derive(Debug, Serialize, Deserialize)]
pub struct OnChainGameState {
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub our_turn: bool,
    pub state_number: usize,
    pub accept: AcceptTransactionState,
    /// When set, this coin is the result of an opponent's illegal move and we've
    /// submitted a slash transaction to spend it. If the slash succeeds (coin gets
    /// spent), we emit WeSlashedOpponent. If it times out, OpponentSuccessfullyCheated.
    #[serde(default)]
    pub pending_slash_amount: Option<Amount>,
    #[serde(default)]
    pub accepted: bool,
    /// The game-specific on-chain timeout (ASSERT_HEIGHT_RELATIVE) from the referee puzzle.
    #[serde(default = "default_game_timeout")]
    pub game_timeout: Timeout,
}
