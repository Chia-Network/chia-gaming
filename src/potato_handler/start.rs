use std::rc::Rc;

use crate::common::types::{
    Amount, GameID, Program, Timeout, GameType
};
use serde::{Deserialize, Serialize};

use crate::channel_handler::types::GameStartInfoInterface;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameStart {
    pub game_id: GameID,
    pub game_type: GameType,
    pub timeout: Timeout,
    pub amount: Amount,
    pub my_contribution: Amount,
    pub my_turn: bool,
    pub parameters: Program,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WireGameStart {
    pub game_ids: Vec<GameID>,
    pub start: GameStart,
}

#[derive(Debug, Clone)]
pub struct GameStartQueueEntry(pub Vec<GameID>);

#[derive(Debug, Clone)]
pub struct MyGameStartQueueEntry {
    pub my_games: Vec<Rc<dyn GameStartInfoInterface>>,
    pub their_games: Vec<Rc<dyn GameStartInfoInterface>>,
}