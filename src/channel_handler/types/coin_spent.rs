use crate::channel_handler::types::OnChainGameCoin;
use crate::common::types::{Amount, CoinSpend, CoinString, GameID, PuzzleHash};
use crate::referee::TheirTurnCoinSpentResult;

#[derive(Debug)]
pub enum CoinSpentInformation {
    OurReward(PuzzleHash, Amount),
    OurSpend(PuzzleHash, Amount),
    TheirSpend(TheirTurnCoinSpentResult),
    Expected(PuzzleHash, Amount),
}

#[derive(Debug, Clone)]
pub struct CoinSpentMoveUp {
    pub game_id: GameID,
    pub spend_before_game_coin: CoinSpend,
    pub after_update_game_coin: CoinString,
}

#[derive(Debug, Clone)]
pub struct CoinSpentAccept {
    pub game_id: GameID,
    pub spend: CoinSpend,
    pub reward_coin: CoinString,
}

// Disposition
#[derive(Debug, Clone)]
pub enum CoinSpentDisposition {
    CancelledUX(Vec<GameID>),
    Move(CoinSpentMoveUp),
    Accept(CoinSpentAccept),
}

#[derive(Debug, Clone)]
pub struct CoinSpentResult {
    pub my_clean_reward_coin_string_up: CoinString,
    // New coins that now exist.
    pub new_game_coins_on_chain: Vec<OnChainGameCoin>,
    pub disposition: Option<CoinSpentDisposition>,
}
