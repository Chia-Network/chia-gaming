use crate::channel_handler::types::{ChannelCoinSpendInfo, CoinSpentDisposition, PotatoSignatures};

use crate::common::types::{Amount, GameID, Puzzle};
use crate::referee::GameMoveDetails;
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct MoveResult {
    pub signatures: PotatoSignatures,
    pub game_move: GameMoveDetails,
}

pub struct DispositionResult {
    pub skip_game: Vec<GameID>,
    pub skip_coin_id: Option<GameID>,
    pub our_contribution_adjustment: Amount,
    pub disposition: CoinSpentDisposition,
}

#[derive(Clone)]
pub struct HandshakeResult {
    pub channel_puzzle_reveal: Puzzle,
    pub amount: Amount,
    pub spend: ChannelCoinSpendInfo,
}
