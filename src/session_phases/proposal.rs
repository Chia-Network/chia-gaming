use crate::common::types::{GameType, Program, Timeout};
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameProposal {
    pub game_type: GameType,
    pub timeout: Timeout,
    pub parameters: Program,
}
