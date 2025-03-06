use crate::common::types::{CoinString, GameID};

#[derive(Debug, Clone)]
pub struct OnChainGameCoin {
    pub game_id_up: GameID,
    pub coin_string_up: Option<CoinString>,
}
