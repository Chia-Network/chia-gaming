use std::rc::Rc;

use clvm_traits::{ClvmEncoder, ToClvm};
use clvmr::run_program;

use crate::utils::proper_list;

use log::debug;

use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::types::ValidationProgram;
use crate::channel_handler::GameStartInfo;
use crate::common::standard_coin::read_hex_puzzle;
use crate::common::types::{
    atom_from_clvm, chia_dialect, u64_from_atom, usize_from_atom, AllocEncoder, Amount, Error,
    GameID, Hash, IntoErr, Program, Timeout,
};

pub struct Game {
    pub id: GameID,
    pub initial_mover_handler: GameHandler,
    pub initial_waiter_handler: GameHandler,
    pub whether_paired: bool,
    pub required_size_factor: Amount,
    pub initial_max_move_size: usize,
    pub initial_validation_program: ValidationProgram,
    pub initial_validation_program_hash: Hash,
    pub initial_state: Rc<Program>,
    pub initial_mover_share_proportion: usize,
}

impl Game {
    pub fn new(
        allocator: &mut AllocEncoder,
        game_id: GameID,
        game_hex_file: &str,
    ) -> Result<Game, Error> {
        let poker_generator = read_hex_puzzle(allocator, game_hex_file)?;
        let nil = allocator
            .encode_atom(clvm_traits::Atom::Borrowed(&[]))
            .into_gen()?;
        let poker_generator_clvm = poker_generator.to_clvm(allocator).into_gen()?;
        debug!("running start");
        let template_clvm = run_program(
            allocator.allocator(),
            &chia_dialect(),
            poker_generator_clvm,
            nil,
            0,
        )
        .into_gen()?
        .1;
        let template_list =
            if let Some(lst) = proper_list(allocator.allocator(), template_clvm, true) {
                lst
            } else {
                return Err(Error::StrErr(
                    "poker program didn't return a list".to_string(),
                ));
            };

        if template_list.len() != 9 {
            return Err(Error::StrErr(
                "calpoker template returned incorrect property list".to_string(),
            ));
        }

        let initial_mover_handler =
            GameHandler::my_driver_from_nodeptr(allocator, template_list[0])?;
        let initial_waiter_handler =
            GameHandler::their_driver_from_nodeptr(allocator, template_list[1])?;
        let whether_paired = atom_from_clvm(allocator, template_list[2])
            .map(|a| !a.is_empty())
            .expect("should be an atom");
        let required_size_factor = Amount::new(
            atom_from_clvm(allocator, template_list[3])
                .and_then(|a| u64_from_atom(&a))
                .expect("should be an atom"),
        );
        let initial_max_move_size = atom_from_clvm(allocator, template_list[4])
            .and_then(|a| usize_from_atom(&a))
            .expect("should be an atom");
        let validation_prog = Rc::new(Program::from_nodeptr(allocator, template_list[5])?);
        let initial_validation_program = ValidationProgram::new(allocator, validation_prog);
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
        let initial_mover_share_proportion = atom_from_clvm(allocator, template_list[8])
            .and_then(|a| usize_from_atom(&a))
            .expect("should be an atom");
        Ok(Game {
            id: game_id,
            initial_mover_handler,
            initial_waiter_handler,
            whether_paired,
            required_size_factor,
            initial_max_move_size,
            initial_validation_program,
            initial_validation_program_hash,
            initial_state,
            initial_mover_share_proportion,
        })
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
        let amount_as_u64: u64 = amount.clone().into();
        let mover_share =
            Amount::new((amount_as_u64 * self.initial_mover_share_proportion as u64) / 100);
        let waiter_share = amount.clone() - mover_share.clone();
        (
            GameStartInfo {
                game_id: game_id.clone(),
                amount: amount.clone(),
                game_handler: self.initial_mover_handler.clone(),
                timeout: timeout.clone(),
                my_contribution_this_game: our_contribution.clone(),
                their_contribution_this_game: their_contribution.clone(),
                initial_validation_program: self.initial_validation_program.clone(),
                initial_state: self.initial_state.clone().into(),
                initial_move: vec![],
                initial_max_move_size: self.initial_max_move_size,
                initial_mover_share: mover_share,
            },
            GameStartInfo {
                game_id: game_id.clone(),
                amount: amount.clone(),
                game_handler: self.initial_waiter_handler.clone(),
                timeout: timeout.clone(),
                my_contribution_this_game: their_contribution.clone(),
                their_contribution_this_game: our_contribution.clone(),
                initial_validation_program: self.initial_validation_program.clone(),
                initial_state: self.initial_state.clone().into(),
                initial_move: vec![],
                initial_max_move_size: self.initial_max_move_size,
                initial_mover_share: waiter_share,
            },
        )
    }
}
