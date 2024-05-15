use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;
use rand::prelude::*;
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;

use clvm_tools_rs::classic::clvm_tools::binutils::{assemble, disassemble};

use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::types::{GameStartInfo, ReadableMove};
use crate::common::standard_coin::{private_to_public_key, read_hex_puzzle, puzzle_hash_for_pk};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, Error, GameID, Node, PrivateKey, PuzzleHash, Sha256tree, Timeout,
};
use crate::referee::RefereeMaker;

fn make_debug_game_handler(allocator: &mut AllocEncoder, amount: &Amount) -> GameHandler {
    let debug_game_handler =
        read_hex_puzzle(allocator, "resources/debug_game_handler.hex").expect("should be readable");
    let game_handler_mod_hash = debug_game_handler.sha256tree(allocator);
    let aggsig = Aggsig::default();
    let curried_game_handler = CurriedProgram {
        program: debug_game_handler.clone(),
        args: clvm_curried_args!(
            (game_handler_mod_hash,
             (debug_game_handler,
              (amount.clone(),
               (true,
                (((), (aggsig, ())), ()) // slash info
               )
              )
             )
            )
        ),
    };
    GameHandler::my_driver_from_nodeptr(
        curried_game_handler
            .to_clvm(allocator)
            .expect("should curry"),
    )
}

#[test]
fn test_referee_smoke() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();

    // Load up the real referee coin.
    let referee_coin_puzzle = read_hex_puzzle(&mut allocator, "onchain/referee.hex").expect("should be readable");
    let referee_coin_puzzle_hash: PuzzleHash = referee_coin_puzzle.sha256tree(&mut allocator);

    // Generate keys and puzzle hashes.
    let my_private_key: PrivateKey = rng.gen();
    let my_public_key = private_to_public_key(&my_private_key);
    let my_puzzle_hash = puzzle_hash_for_pk(&mut allocator, &my_public_key).expect("should have");

    let their_private_key: PrivateKey = rng.gen();
    let their_public_key = private_to_public_key(&their_private_key);
    let their_puzzle_hash: PuzzleHash = puzzle_hash_for_pk(&mut allocator, &their_public_key).expect("should have");

    let amount = Amount::new(100);

    let debug_game_handler = make_debug_game_handler(&mut allocator, &amount);
    let validation_program = CurriedProgram {
        program: Node(debug_game_handler.to_nodeptr()),
        args: clvm_curried_args!(1337)
    }.to_clvm(&mut allocator).expect("should curry");
    let init_state =
        assemble(
            allocator.allocator(),
            "(0 . 0)"
        ).expect("should assemble");

    let validation_program_hash = Node(validation_program).sha256tree(&mut allocator);

    let amount = Amount::new(100);
    let game_start_info = GameStartInfo {
        game_id: GameID::from_bytes(b"test"),
        amount: amount.clone(),
        game_handler: debug_game_handler,
        timeout: Timeout::new(1000),
        is_my_turn: true,
        initial_validation_puzzle: validation_program,
        initial_validation_puzzle_hash: validation_program_hash,
        initial_state: init_state,
        initial_move: vec![0, 0],
        initial_max_move_size: 0,
        initial_mover_share: Amount::default(),
    };
    let mut referee = RefereeMaker::new(
        &mut allocator,
        referee_coin_puzzle_hash.clone(),
        &game_start_info,
        &my_private_key,
        &their_puzzle_hash,
        1,
    )
    .expect("should construct");
    referee.enable_debug_run(true);
    let readable_move = assemble(allocator.allocator(), "(0 . 0)").expect("should assemble");
    let my_move_result = referee
        .my_turn_make_move(
            &mut rng,
            &mut allocator,
            &ReadableMove::from_nodeptr(readable_move),
        )
        .expect("should move");
    assert!(my_move_result.move_made.is_empty());
    let mut off_chain_slash_gives_error = referee.clone();
    let their_move_result = off_chain_slash_gives_error.their_turn_move_off_chain(
        &mut allocator,
        &[1],
        &my_move_result.validation_info_hash,
        100,
        &Amount::default(),
    );
    eprintln!("their move result {their_move_result:?}");
    if let Err(Error::StrErr(s)) = their_move_result {
        assert!(s.contains("slash"));
        assert!(s.contains("off chain"));
    } else {
        assert!(false);
    }

    let on_chain_cheat = referee.clone();

    let their_move_result = referee
        .their_turn_move_off_chain(
            &mut allocator,
            &[],
            &my_move_result.validation_info_hash,
            100,
            &Amount::default(),
        )
        .expect("should run");
    assert_eq!(their_move_result.message, b"message data");
    assert_eq!(
        disassemble(allocator.allocator(), their_move_result.readable_move, None),
        "(())"
    );

    let mut their_referee = RefereeMaker::new(
        &mut allocator,
        referee_coin_puzzle_hash,
        &game_start_info,
        &their_private_key,
        &their_puzzle_hash,
        1,
    );
}
