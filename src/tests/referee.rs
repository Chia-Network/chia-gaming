use rand::prelude::*;
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;
use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;

use clvm_tools_rs::classic::clvm_tools::binutils::{assemble, disassemble};

use crate::common::types::{GameID, Timeout, Amount, PuzzleHash, PrivateKey, AllocEncoder, Sha256tree, Node, Aggsig, Error};
use crate::common::standard_coin::read_hex_puzzle;
use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::types::{GameStartInfo, ReadableMove};
use crate::referee::RefereeMaker;

fn make_debug_game_handler(
    allocator: &mut AllocEncoder,
    amount: &Amount,
) -> GameHandler {
    let debug_game_handler = read_hex_puzzle(
        allocator,
        "resources/debug_game_handler.hex"
    ).expect("should be readable");
    let game_handler_mod_hash = debug_game_handler.sha256tree(allocator);
    let aggsig = Aggsig::default();
    let curried_game_handler = CurriedProgram {
        program: debug_game_handler.clone(),
        args: clvm_curried_args!(
            game_handler_mod_hash,
            debug_game_handler,
            amount.clone(),
            true,
            ((), (aggsig, ())) // slash info
        )
    };
    GameHandler::my_driver_from_nodeptr(curried_game_handler.to_clvm(allocator).expect("should curry"))
}

#[test]
fn test_referee_smoke() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();
    let referee_coin_puzzle_hash: PuzzleHash = rng.gen();
    let private_key: PrivateKey = rng.gen();
    let their_puzzle_hash: PuzzleHash = rng.gen();
    let nil = allocator.allocator().null();
    let val_hash = Node(nil).sha256tree(&mut allocator);
    let init_state = assemble(
        allocator.allocator(),
        "(0 . 0)"
    ).expect("should assemble");
    let amount = Amount::new(100);
    let game_start_info = GameStartInfo {
        game_id: GameID::from_bytes(b"test"),
        amount: amount.clone(),
        game_handler: make_debug_game_handler(
            &mut allocator,
            &amount,
        ),
        timeout: Timeout::new(1000),
        is_my_turn: true,
        initial_validation_puzzle: nil,
        initial_validation_puzzle_hash: val_hash,
        initial_state: init_state,
        initial_move: vec![0,0],
        initial_max_move_size: 0,
        initial_mover_share: Amount::default()
    };
    let mut referee = RefereeMaker::new(
        &mut allocator,
        referee_coin_puzzle_hash,
        &game_start_info,
        &private_key,
        &their_puzzle_hash,
        1
    ).expect("should construct");
    let readable_move =
        assemble(
            allocator.allocator(),
            "(0 . 0)"
        ).expect("should assemble");
    let my_move_result = referee.my_turn_make_move(
        &mut rng,
        &mut allocator,
        &ReadableMove::from_nodeptr(readable_move)
    ).expect("should move");
    assert_eq!(my_move_result.move_made, &[0]);
    let mut off_chain_slash_gives_error = referee.clone();
    let their_move_result = off_chain_slash_gives_error.their_turn_move_off_chain(
        &mut allocator,
        &[1],
        &my_move_result.validation_info_hash,
        100,
        &Amount::default()
    );
    if let Err(Error::StrErr(s)) = their_move_result {
        assert!(s.contains("slash"));
        assert!(s.contains("off chain"));
    } else {
        assert!(false);
    }

    let their_move_result = referee.their_turn_move_off_chain(
        &mut allocator,
        &[0],
        &my_move_result.validation_info_hash,
        100,
        &Amount::default()
    ).expect("should run");
    assert_eq!(their_move_result.message, b"message data");
    assert_eq!(disassemble(allocator.allocator(), their_move_result.readable_move, None), "(())");
}
