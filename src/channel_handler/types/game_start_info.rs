use serde::{Deserialize, Serialize};

use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::types::StateUpdateProgram;
use crate::channel_handler::types::ValidationProgram;

use crate::common::types::{Amount, GameID, ProgramRef, Timeout};

pub enum ValidationOrUpdateProgram {
    Validation(ValidationProgram),
    StateUpdate(StateUpdateProgram),
}

pub trait GameStartInfoInterfaceND {
    fn version(&self) -> usize;
    fn serialize(&self) -> Result<bson::Bson, bson::ser::Error>;

    fn amount(&self) -> &Amount;
    fn game_handler(&self) -> GameHandler;

    fn my_contribution_this_game(&self) -> &Amount;
    fn their_contribution_this_game(&self) -> &Amount;

    fn initial_validation_program(&self) -> ValidationOrUpdateProgram;

    fn initial_state(&self) -> ProgramRef;
    fn initial_move(&self) -> &[u8];
    fn initial_max_move_size(&self) -> usize;
    fn initial_mover_share(&self) -> &Amount;

    // Can be left out.
    fn game_id(&self) -> &GameID;
    fn timeout(&self) -> &Timeout;
}

pub trait GameStartInfoInterface: GameStartInfoInterfaceND + std::fmt::Debug {}

impl GameStartInfoInterface for GameStartInfo {}
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameStartInfo {
    pub amount: Amount,
    pub game_handler: GameHandler,

    pub my_contribution_this_game: Amount,
    pub their_contribution_this_game: Amount,

    pub initial_validation_program: ValidationProgram,
    pub initial_state: ProgramRef,
    pub initial_move: Vec<u8>,
    pub initial_max_move_size: usize,
    pub initial_mover_share: Amount,

    // Can be left out.
    pub game_id: GameID,
    pub timeout: Timeout,
}

impl GameStartInfoInterfaceND for GameStartInfo {
    fn version(&self) -> usize {
        0
    }
    fn serialize(&self) -> Result<bson::Bson, bson::ser::Error> {
        bson::to_bson(self)
    }

    fn amount(&self) -> &Amount {
        &self.amount
    }
    fn game_handler(&self) -> GameHandler {
        self.game_handler.clone()
    }

    fn my_contribution_this_game(&self) -> &Amount {
        &self.my_contribution_this_game
    }
    fn their_contribution_this_game(&self) -> &Amount {
        &self.their_contribution_this_game
    }

    fn initial_validation_program(&self) -> ValidationOrUpdateProgram {
        ValidationOrUpdateProgram::Validation(self.initial_validation_program.clone())
    }

    fn initial_state(&self) -> ProgramRef {
        self.initial_state.clone()
    }
    fn initial_move(&self) -> &[u8] {
        &self.initial_move
    }
    fn initial_max_move_size(&self) -> usize {
        self.initial_max_move_size
    }
    fn initial_mover_share(&self) -> &Amount {
        &self.initial_mover_share
    }

    // Can be left out.
    fn game_id(&self) -> &GameID {
        &self.game_id
    }
    fn timeout(&self) -> &Timeout {
        &self.timeout
    }
}

impl GameStartInfo {
    pub fn is_my_turn(&self) -> bool {
        matches!(self.game_handler, GameHandler::MyTurnHandler(_))
    }
}
