use crate::common::types::{Amount, GameType, Hash, Program, Timeout};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameStart {
    pub game_type: GameType,
    pub timeout: Timeout,
    pub amount: Amount,
    pub my_contribution: Amount,
    pub my_turn: bool,
    pub parameters: Program,
    #[serde(default)]
    pub initial_validation_program_hash: Option<Hash>,
    #[serde(default)]
    pub initial_state: Option<Program>,
    #[serde(default)]
    pub initial_max_move_size: Option<usize>,
    #[serde(default)]
    pub initial_mover_share: Option<Amount>,
}
