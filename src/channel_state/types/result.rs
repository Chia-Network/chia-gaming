use crate::channel_state::types::ChannelCoinSpendInfo;

use crate::common::types::{Amount, Puzzle};
use crate::referee::types::GameMoveDetails;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MoveResult {
    pub game_move: GameMoveDetails,
    pub state_number: usize,
    #[serde(default)]
    pub is_finished: bool,
}

#[derive(Clone)]
pub struct HandshakeResult {
    pub channel_puzzle_reveal: Puzzle,
    pub amount: Amount,
    pub spend: ChannelCoinSpendInfo,
}
