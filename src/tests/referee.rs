use std::rc::Rc;

use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;
use rand::prelude::*;
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;

use log::debug;

use crate::channel_handler::game_handler::{GameHandler, TheirTurnResult};
use crate::channel_handler::types::{GameStartInfo, ReadableMove, StateUpdateProgram};
use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::standard_coin::{read_hex_puzzle, ChiaIdentity};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, Error, GameID, Hash, PrivateKey, Program, Puzzle, PuzzleHash,
    Sha256tree, Timeout,
};
use crate::referee::types::{GameMoveDetails, GameMoveStateInfo};
use crate::referee::RefereeMaker;

pub struct DebugGamePrograms {
    pub my_validation_program: Rc<Program>,
    #[allow(dead_code)]
    pub their_validation_program: Rc<Program>,
    pub my_turn_handler: GameHandler,
    pub their_turn_handler: GameHandler,
}

pub fn make_debug_game_handler(
    allocator: &mut AllocEncoder,
    identity: &ChiaIdentity,
    amount: &Amount,
    timeout: &Timeout,
) -> DebugGamePrograms {
    let debug_game_handler =
        read_hex_puzzle(allocator, "clsp/test/debug_game_handler.hex").expect("should be readable");
    let game_handler_mod_hash = debug_game_handler.sha256tree(allocator);
    let make_curried_game_handler = |my_turn: bool| {
        let aggsig = Aggsig::default();
        CurriedProgram {
            program: debug_game_handler.clone(),
            args: clvm_curried_args!((
                game_handler_mod_hash.clone(),
                (
                    debug_game_handler.clone(),
                    (
                        timeout.clone(),
                        (
                            amount.clone(),
                            (
                                my_turn,
                                (
                                    ((), (aggsig, ())),
                                    (identity.puzzle_hash.clone(), ()) // slash info
                                )
                            )
                        )
                    )
                )
            )),
        }
    };

    let my_driver_node = make_curried_game_handler(true)
        .to_clvm(allocator)
        .expect("should curry");
    let my_turn_handler =
        GameHandler::my_driver_from_nodeptr(allocator, my_driver_node).expect("should cvt");
    let my_validation_program_node = CurriedProgram {
        program: my_turn_handler.clone(),
        args: clvm_curried_args!(1337),
    }
    .to_clvm(allocator)
    .expect("should curry");
    let my_validation_program = Rc::new(
        Program::from_nodeptr(allocator, my_validation_program_node).expect("should convert"),
    );

    let their_turn_node = make_curried_game_handler(false)
        .to_clvm(allocator)
        .expect("should curry");
    let their_turn_handler =
        GameHandler::their_driver_from_nodeptr(allocator, their_turn_node).expect("should cvt");
    let their_validation_program_node = CurriedProgram {
        program: their_turn_handler.clone(),
        args: clvm_curried_args!(1337),
    }
    .to_clvm(allocator)
    .expect("should curry");
    let their_validation_program = Rc::new(
        Program::from_nodeptr(allocator, their_validation_program_node).expect("should convert"),
    );

    DebugGamePrograms {
        my_validation_program,
        my_turn_handler,
        their_validation_program,
        their_turn_handler,
    }
}

#[cfg(test)]
pub struct RefereeTest {
    #[allow(dead_code)]
    pub my_identity: ChiaIdentity,
    #[allow(dead_code)]
    pub their_identity: ChiaIdentity,

    #[allow(dead_code)]
    pub my_referee: RefereeMaker,
    pub their_referee: RefereeMaker,

    #[allow(dead_code)]
    pub referee_coin_puzzle: Puzzle,
    #[allow(dead_code)]
    pub referee_coin_puzzle_hash: PuzzleHash,
}

impl RefereeTest {
    pub fn new(
        allocator: &mut AllocEncoder,

        my_identity: ChiaIdentity,
        their_identity: ChiaIdentity,

        their_game_handler: GameHandler,

        game_start: &GameStartInfo,
    ) -> RefereeTest {
        // Load up the real referee coin.
        let referee_coin_puzzle =
            read_hex_puzzle(allocator, "clsp/onchain/referee.hex").expect("should be readable");
        let referee_coin_puzzle_hash: PuzzleHash = referee_coin_puzzle.sha256tree(allocator);
        let (my_referee, first_puzzle_hash) = RefereeMaker::new(
            allocator,
            referee_coin_puzzle.clone(),
            referee_coin_puzzle_hash.clone(),
            game_start,
            my_identity.clone(),
            &their_identity.puzzle_hash,
            1,
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            0,
        )
        .expect("should construct");
        assert_eq!(
            first_puzzle_hash,
            my_referee
                .on_chain_referee_puzzle_hash(allocator)
                .expect("should work")
        );

        let their_game_start_info = GameStartInfo {
            initial_mover_share: game_start.amount.clone() - game_start.initial_mover_share.clone(),
            game_handler: their_game_handler,
            ..game_start.clone()
        };

        let (their_referee, _) = RefereeMaker::new(
            allocator,
            referee_coin_puzzle.clone(),
            referee_coin_puzzle_hash.clone(),
            &their_game_start_info,
            their_identity.clone(),
            &my_identity.puzzle_hash,
            1,
            &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
            0,
        )
        .expect("should construct");

        RefereeTest {
            my_identity,
            their_identity,

            my_referee,
            their_referee,

            referee_coin_puzzle,
            referee_coin_puzzle_hash,
        }
    }
}
