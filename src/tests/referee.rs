use std::rc::Rc;

use clvm_traits::{clvm_curried_args, ClvmEncoder, ToClvm};
use clvm_utils::CurriedProgram;
use rand::prelude::*;
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;

use log::debug;

use crate::channel_handler::game_handler::{GameHandler, TheirTurnResult};
use crate::channel_handler::types::{GameStartInfo, ReadableMove, ValidationProgram};
use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::standard_coin::{read_hex_puzzle, ChiaIdentity};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, Error, GameID, Hash, PrivateKey, Program, Puzzle, PuzzleHash,
    Sha256tree, Timeout,
};
use crate::referee::RefereeMaker;
use crate::referee::types::{GameMoveDetails, GameMoveStateInfo};
use crate::referee::types::ValidatorResult;

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

#[test]
fn test_referee_smoke() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();

    // Generate keys and puzzle hashes.
    let my_private_key: PrivateKey = rng.gen();
    let my_identity = ChiaIdentity::new(&mut allocator, my_private_key).expect("should generate");

    let their_private_key: PrivateKey = rng.gen();
    let their_identity =
        ChiaIdentity::new(&mut allocator, their_private_key).expect("should generate");

    let amount = Amount::new(100);
    let timeout = Timeout::new(1000);

    let debug_game = make_debug_game_handler(&mut allocator, &my_identity, &amount, &timeout);
    let init_state_node = ((), ()).to_clvm(&mut allocator).expect("should assemble");
    let init_state =
        Program::from_nodeptr(&mut allocator, init_state_node).expect("should convert");
    let initial_validation_program =
        ValidationProgram::new(&mut allocator, debug_game.my_validation_program);

    let amount = Amount::new(100);
    let game_start_info = GameStartInfo {
        game_id: GameID::from_bytes(b"test"),
        amount: amount.clone(),
        game_handler: debug_game.my_turn_handler,
        timeout: timeout.clone(),
        my_contribution_this_game: Amount::new(50),
        their_contribution_this_game: Amount::new(50),
        initial_validation_program,
        initial_state: init_state.into(),
        initial_move: vec![],
        initial_max_move_size: 0,
        initial_mover_share: Amount::default(),
    };

    let mut reftest = RefereeTest::new(
        &mut allocator,
        my_identity,
        their_identity,
        debug_game.their_turn_handler,
        &game_start_info,
    );

    let readable_move = ((), ()).to_clvm(&mut allocator).expect("should cvt");
    let readable_my_move =
        ReadableMove::from_nodeptr(&mut allocator, readable_move).expect("should work");
    let my_move_wire_data = reftest
        .my_referee
        .my_turn_make_move(&mut allocator, &readable_my_move, rng.gen(), 0)
        .expect("should move");

    assert!(my_move_wire_data.details.basic.move_made.is_empty());
    let mut off_chain_slash_gives_error = reftest.my_referee.clone();
    let their_move_result = off_chain_slash_gives_error.their_turn_move_off_chain(
        &mut allocator,
        &GameMoveDetails {
            basic: GameMoveStateInfo {
                move_made: vec![1],
                max_move_size: 100,
                mover_share: Amount::default(),
            },
            validation_info_hash: my_move_wire_data.details.validation_info_hash.clone(),
        },
        0,
        None,
    );
    debug!("their move result {their_move_result:?}");
    if let Err(Error::StrErr(s)) = their_move_result {
        assert!(s.contains("slash"));
    } else {
        unreachable!();
    }

    let their_move_local_update = reftest
        .their_referee
        .their_turn_move_off_chain(&mut allocator, &my_move_wire_data.details, 0, None)
        .expect("should move");

    debug!("their_move_wire_data {their_move_local_update:?}");

    let nil = allocator
        .encode_atom(clvm_traits::Atom::Borrowed(&[]))
        .expect("should encode");
    todo!();
    // let validator_result = reftest
    //     .their_referee
    //     .run_validator_for_move(&mut allocator, nil, true);
    // assert!(matches!(validator_result, Ok(ValidatorResult::MoveOk(_,_,_))));

    // assert!(reftest.my_referee.processing_my_turn());
    // let their_move_result = reftest
    //     .my_referee
    //     .their_turn_move_off_chain(&mut allocator, &my_move_wire_data.details, 0, None)
    //     .expect("should run");
    // let (readable_move, message) = match &their_move_result.original {
    //     TheirTurnResult::MakeMove(_, message, move_data) => {
    //         (move_data.readable_move, message.clone())
    //     }
    //     TheirTurnResult::FinalMove(move_data) => (move_data.readable_move, vec![]),
    //     _ => {
    //         panic!();
    //     }
    // };
    // assert_eq!(message, b"message data");
    // let readable_prog = Program::from_nodeptr(&mut allocator, readable_move).expect("should cvt");
    // assert_eq!(format!("{:?}", readable_prog), "Program(ff8080)");
    // assert!(!reftest.my_referee.processing_my_turn());
}
