use serde::{Deserialize, Serialize};

use crate::channel_state::game_handler::GameHandler;
use crate::channel_state::types::{StateUpdateProgram, ValidationProgramRegistry};
use crate::common::types::{Amount, GameID, ProgramRef, Timeout};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameStartInfo {
    pub amount: Amount,
    pub game_handler: GameHandler,

    pub player_a_contribution: Amount,
    pub player_b_contribution: Amount,
    pub my_contribution_this_game: Amount,
    pub their_contribution_this_game: Amount,

    pub validation_programs: ValidationProgramRegistry,
    pub initial_state: ProgramRef,
    pub initial_move: Vec<u8>,
    pub initial_max_move_size: usize,
    pub initial_mover_share: Amount,

    pub game_id: GameID,
    pub timeout: Timeout,
}

impl GameStartInfo {
    pub fn initial_validation_program(&self) -> StateUpdateProgram {
        self.validation_programs.initial()
    }

    pub fn is_my_turn(&self) -> bool {
        matches!(self.game_handler, GameHandler::MyTurnHandler(_))
    }
}
