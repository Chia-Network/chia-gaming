use std::rc::Rc;

use clvm_traits::ToClvm;
use clvmr::{NodePtr, run_program};

use crate::utils::proper_list;

use log::debug;

use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::types::StateUpdateProgram;
use crate::channel_handler::GameStartInfo;
use crate::common::standard_coin::read_hex_puzzle;
use crate::common::types::{
    atom_from_clvm, chia_dialect, u64_from_atom, usize_from_atom, AllocEncoder, Amount, Error,
    GameID, Hash, IntoErr, Program, Puzzle, Timeout,
};

#[derive(Clone)]
pub struct GameStart {
    pub id: GameID,
    pub initial_mover_handler: GameHandler,
    pub initial_move: Vec<u8>,
    pub initial_max_move_size: usize,
    pub initial_validation_program: StateUpdateProgram,
    pub initial_validation_program_hash: Hash,
    pub initial_state: Rc<Program>,
    pub initial_mover_share: u64,
}

impl GameStart {
    pub fn new_program(
        allocator: &mut AllocEncoder,
        game_id: &GameID,
        template_list: &[NodePtr],
    ) -> Result<GameStart, Error> {
        if template_list.len() != 11 {
            return Err(Error::StrErr(format!(
                "calpoker template returned incorrect property list {}",
                template_list.len(),
            )));
        }

        let initial_mover_handler =
            GameHandler::my_driver_from_nodeptr(allocator, template_list[2])?;

        let validation_prog = Rc::new(Program::from_nodeptr(allocator, template_list[5])?);
        let initial_validation_program =
            StateUpdateProgram::new(allocator, "initial", validation_prog);
        let initial_validation_program_hash =
            if let Some(a) = atom_from_clvm(allocator, template_list[6]) {
                Hash::from_slice(&a)
            } else {
                return Err(Error::StrErr(
                    "not an atom for initial_validation_hash".to_string(),
                ));
            };
        let initial_state_node = template_list[7];
        let initial_state = Rc::new(Program::from_nodeptr(allocator, initial_state_node)?);
        let initial_move = atom_from_clvm(allocator, template_list[8]).unwrap_or_default();
        let initial_max_move_size = atom_from_clvm(allocator, template_list[9])
            .and_then(|a| usize_from_atom(&a))
            .expect("should be an atom");
        let initial_mover_share = atom_from_clvm(allocator, template_list[10])
            .and_then(|a| u64_from_atom(&a))
            .expect("should be an atom");
        Ok(GameStart {
            id: game_id.clone(),
            initial_max_move_size,
            initial_validation_program,
            initial_validation_program_hash,
            initial_state,
            initial_move,
            initial_mover_share,
            initial_mover_handler,
        })
    }

    pub fn game_start(
        &self,
        game_id: &GameID,
        amount: &Amount,
        timeout: &Timeout,
        my_contribution: &Amount,
        their_contribution: &Amount,
    ) -> GameStartInfo {
        GameStartInfo {
            game_id: game_id.clone(),
            amount: amount.clone(),
            game_handler: self.initial_mover_handler.clone(),
            timeout: timeout.clone(),
            my_contribution_this_game: my_contribution.clone(),
            their_contribution_this_game: their_contribution.clone(),
            initial_validation_program: self.initial_validation_program.clone(),
            initial_state: self.initial_state.clone().into(),
            initial_move: self.initial_move.clone(),
            initial_max_move_size: self.initial_max_move_size,
            initial_mover_share: Amount::new(self.initial_mover_share),
        }
    }
}

#[derive(Clone)]
pub struct Game {
    pub starts: Vec<GameStart>,
}

impl Game {
    pub fn new_program(
        allocator: &mut AllocEncoder,
        as_alice: bool,
        game_id: &GameID,
        poker_generator: Puzzle,
    ) -> Result<Game, Error> {
        let mut starts = Vec::new();

        let args = (as_alice, (100, (100, ((), ()))))
            .to_clvm(allocator)
            .into_gen()?;
        let args_program = Program::from_nodeptr(allocator, args)?;

        let poker_generator_clvm = poker_generator.to_clvm(allocator).into_gen()?;
        debug!("running start program {poker_generator:?}");
        debug!("running start args {args_program:?}");
        let template_clvm = run_program(
            allocator.allocator(),
            &chia_dialect(),
            poker_generator_clvm,
            args,
            0,
        )
            .into_gen()?
            .1;
        let template_list_prog = Program::from_nodeptr(allocator, template_clvm)?;
        debug!("game template_list {template_list_prog:?}");
        let game_list = if let Some(lst) = proper_list(allocator.allocator(), template_clvm, true) {
            lst
        } else {
            return Err(Error::StrErr(
                "poker program didn't return a list".to_string(),
            ));
        };

        if game_list.is_empty() {
            return Err(Error::StrErr("not even one game returned".to_string()));
        }

        for game in game_list.iter() {
            let template_list =
                if let Some(lst) = proper_list(allocator.allocator(), *game, true) {
                    lst
                } else {
                    return Err(Error::StrErr("bad template list".to_string()));
                };

            starts.push(GameStart::new_program(
                allocator,
                game_id,
                &template_list,
            )?);
        }

        Ok(Game { starts })
    }

    pub fn new(
        allocator: &mut AllocEncoder,
        as_alice: bool,
        game_id: &GameID,
        game_hex_file: &str,
    ) -> Result<Game, Error> {
        let poker_generator = read_hex_puzzle(allocator, game_hex_file)?;
        Game::new_program(allocator, as_alice, game_id, poker_generator.clone())
    }

    /// Return a pair of GameStartInfo which can be used as the starts for two
    /// players in a game.
    pub fn symmetric_game_starts(
        &self,
        game_id: &GameID,
        our_contribution: &Amount,
        their_contribution: &Amount,
        timeout: &Timeout,
    ) -> (GameStartInfo, GameStartInfo) {
        let amount = our_contribution.clone() + their_contribution.clone();
        let alice_start = self.starts[0].game_start(
            game_id,
            &amount,
            timeout,
            our_contribution,
            their_contribution,
        );
        let bob_start = self.starts[0].game_start(
            game_id,
            &amount,
            timeout,
            their_contribution,
            our_contribution,
        );

        (alice_start, bob_start)
    }
}
