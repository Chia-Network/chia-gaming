use std::rc::Rc;

use crate::utils::proper_list;

use clvmr::allocator::NodePtr;

use serde::{Deserialize, Serialize};

use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::types::{
    GameStartInfoInterface, GameStartInfoInterfaceND, StateUpdateProgram, ValidationOrUpdateProgram,
};
use crate::common::types::{
    atom_from_clvm, usize_from_atom, AllocEncoder, Amount, Error, GameID, Hash, Program,
    ProgramRef, Timeout,
};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct GameStartInfo {
    pub amount: Amount,
    pub game_handler: GameHandler,

    pub my_contribution_this_game: Amount,
    pub their_contribution_this_game: Amount,

    pub initial_validation_program: StateUpdateProgram,
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
        1
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
        ValidationOrUpdateProgram::StateUpdate(self.initial_validation_program.clone())
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

impl GameStartInfoInterface for GameStartInfo {}

impl GameStartInfo {
    pub fn is_my_turn(&self) -> bool {
        matches!(self.game_handler, GameHandler::MyTurnHandler(_))
    }

    pub fn from_clvm(allocator: &mut AllocEncoder, clvm: NodePtr) -> Result<Self, Error> {
        let lst = if let Some(lst) = proper_list(allocator.allocator(), clvm, true) {
            lst
        } else {
            return Err(Error::StrErr(
                "game start info clvm wasn't a full list".to_string(),
            ));
        };

        let required_length = 11;

        if lst.len() < required_length {
            return Err(Error::StrErr(format!(
                "game start info clvm needs at least {required_length} items"
            )));
        }

        let returned_amount = Amount::from_clvm(allocator, lst[0])?;
        let my_turn = atom_from_clvm(allocator, lst[1])
            .and_then(|a| usize_from_atom(&a))
            .unwrap_or(0)
            != 0;
        let returned_handler = if my_turn {
            GameHandler::MyTurnHandler(Program::from_nodeptr(allocator, lst[2])?.into())
        } else {
            GameHandler::TheirTurnHandler(Program::from_nodeptr(allocator, lst[2])?.into())
        };
        let returned_my_contribution = Amount::from_clvm(allocator, lst[3])?;
        let returned_their_contribution = Amount::from_clvm(allocator, lst[4])?;

        let validation_prog = Rc::new(Program::from_nodeptr(allocator, lst[5])?);
        let validation_program_hash = Hash::from_nodeptr(allocator, lst[6])?;
        let validation_program =
            StateUpdateProgram::new_hash(validation_prog, "initial", validation_program_hash);
        let initial_state = Program::from_nodeptr(allocator, lst[7])?.into();
        let initial_move = if let Some(a) = atom_from_clvm(allocator, lst[8]) {
            a.to_vec()
        } else {
            return Err(Error::StrErr("initial move wasn't an atom".to_string()));
        };
        let initial_max_move_size =
            if let Some(a) = atom_from_clvm(allocator, lst[9]).and_then(|a| usize_from_atom(&a)) {
                a
            } else {
                return Err(Error::StrErr("bad initial max move size".to_string()));
            };
        let initial_mover_share = Amount::from_clvm(allocator, lst[10])?;

        let returned_game_id = if lst.len() > required_length + 1 {
            GameID::from_clvm(allocator, lst[required_length])?
        } else {
            GameID::default()
        };

        let returned_timeout = if lst.len() > required_length + 2 {
            Timeout::from_clvm(allocator, lst[required_length + 1])?
        } else {
            Timeout::new(0)
        };

        Ok(GameStartInfo {
            game_id: returned_game_id,
            amount: returned_amount,
            game_handler: returned_handler,
            timeout: returned_timeout,
            my_contribution_this_game: returned_my_contribution,
            their_contribution_this_game: returned_their_contribution,
            initial_validation_program: validation_program,
            initial_state,
            initial_move,
            initial_max_move_size,
            initial_mover_share,
        })
    }
}
