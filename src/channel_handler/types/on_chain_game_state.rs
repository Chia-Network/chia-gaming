use super::timeout_claim_state::TimeoutClaimState;
use crate::common::types::{Amount, GameID, PuzzleHash, Timeout};

use serde::{Deserialize, Serialize};

#[derive(Debug, Serialize, Deserialize)]
pub struct OnChainGameState {
    pub game_id: GameID,
    pub puzzle_hash: PuzzleHash,
    pub our_turn: bool,
    pub state_number: usize,
    pub timeout_claim: TimeoutClaimState,
    /// Set when we've submitted a slash transaction for this coin (opponent made
    /// an illegal move). WeSlashedOpponent if the slash lands, OpponentSuccessfullyCheated
    /// if it times out.
    pub pending_slash_amount: Option<Amount>,
    /// The mover_share the opponent claimed in their illegal move. If the slash
    /// times out, this is the amount we actually end up with.
    pub cheating_move_mover_share: Option<Amount>,
    /// True once the on-chain timeout-claim path is armed for this game coin
    /// (eager register or explicit AcceptSettlement).
    pub timeout_claim_armed: bool,
    pub notification_sent: bool,
    pub game_timeout: Timeout,
    /// True when the referee's game handler is None (no further moves possible).
    /// Distinguishes "real timeout" from "timeout on a terminal game state".
    pub game_finished: bool,
}
