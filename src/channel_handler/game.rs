use clvmr::allocator::NodePtr;
use clvmr::run_program;
use clvm_traits::ClvmEncoder;

use clvm_tools_rs::classic::clvm::sexp::proper_list;

use crate::common::types::{AllocEncoder, Amount, Error, Hash, IntoErr, atom_from_clvm, u64_from_atom, usize_from_atom};
use crate::common::standard_coin::read_hex_puzzle;
use crate::channel_handler::game_handler::{GameHandler, chia_dialect};
use crate::channel_handler::types::ValidationProgram;

pub struct Game {
    pub initial_mover_handler: GameHandler,
    pub initial_waiter_handler: GameHandler,
    pub whether_paired: bool,
    pub required_size_factor: Amount,
    pub initial_max_move_size: usize,
    pub initial_validation_program: ValidationProgram,
    pub initial_validation_program_hash: Hash,
    pub initial_state: NodePtr,
    pub initial_mover_share_proportion: Amount,
}

impl Game {
    pub fn new(allocator: &mut AllocEncoder, game_hex_file: &str) -> Result<Game, Error> {
        let poker_generator = read_hex_puzzle(allocator, game_hex_file)?;
        let nil = allocator.encode_atom(&[]).into_gen()?;
        let template_clvm =
            run_program(
                allocator.allocator(),
                &chia_dialect(),
                poker_generator.to_nodeptr(),
                nil,
                0
            ).into_gen()?.1;
        let template_list =
            if let Some(lst) = proper_list(allocator.allocator(), template_clvm, true) {
                lst
            } else {
                return Err(Error::StrErr("poker program didn't return a list".to_string()));
            };

        if template_list.len() != 9 {
            return Err(Error::StrErr("calpoker template returned incorrect property list".to_string()));
        }

        let initial_mover_handler = GameHandler::my_driver_from_nodeptr(template_list[0]);
        let initial_waiter_handler = GameHandler::their_driver_from_nodeptr(template_list[1]);
        let whether_paired = atom_from_clvm(allocator, template_list[2]).map(|a| !a.is_empty()).expect("should be an atom");
        let required_size_factor = Amount::new(atom_from_clvm(allocator, template_list[3]).and_then(|a| u64_from_atom(a)).expect("should be an atom"));
        let initial_max_move_size = atom_from_clvm(allocator, template_list[4]).and_then(|a| usize_from_atom(a)).expect("should be an atom");
        let initial_validation_program = ValidationProgram::new(
            allocator,
            template_list[5]
        );
        let initial_validation_program_hash =
            if let Some(a) = atom_from_clvm(allocator, template_list[6]) {
                Hash::from_slice(a)
            } else {
                return Err(Error::StrErr("not an atom for initial_validation_hash".to_string()));
            };
        let initial_state = template_list[7];
        let initial_mover_share_proportion = Amount::new(atom_from_clvm(allocator, template_list[8]).and_then(|a| u64_from_atom(a)).expect("should be an atom"));
        Ok(Game {
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
}
