use rand::prelude::*;
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;

use clvm_tools_rs::classic::clvm_tools::binutils::assemble;

use crate::common::types::{GameID, Timeout, Amount, PuzzleHash, PrivateKey, AllocEncoder, Sha256tree, Node};
use crate::common::standard_coin::read_hex_puzzle;
use crate::channel_handler::game_handler::GameHandler;
use crate::channel_handler::types::{GameStartInfo, ReadableMove};
use crate::referee::RefereeMaker;

#[test]
fn test_referee_smoke() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();
    let referee_coin_puzzle_hash: PuzzleHash = rng.gen();
    let private_key: PrivateKey = rng.gen();
    let their_puzzle_hash: PuzzleHash = rng.gen();
    let debug_game_handler = read_hex_puzzle(
        &mut allocator,
        "resources/debug_game_handler.hex"
    ).expect("should be readable");
    let nil = allocator.allocator().null();
    let val_hash = Node(nil).sha256tree(&mut allocator);
    let init_state = assemble(
        allocator.allocator(),
        "(0 . 0)"
    ).expect("should assemble");
    let game_start_info = GameStartInfo {
        game_id: GameID::from_bytes(b"test"),
        amount: Amount::new(100),
        game_handler: GameHandler::my_driver_from_nodeptr(debug_game_handler.to_nodeptr()),
        timeout: Timeout::new(1000),
        is_my_turn: true,
        initial_validation_puzzle: nil,
        initial_validation_puzzle_hash: val_hash,
        initial_state: init_state,
        initial_move: vec![0,0],
        initial_max_move_size: 0,
        initial_mover_share: Amount::default()
    };
    let mut allocator = AllocEncoder::new();
    let mut referee = RefereeMaker::new(
        &mut allocator,
        referee_coin_puzzle_hash,
        &game_start_info,
        &private_key,
        &their_puzzle_hash,
        1
    ).expect("should construct");
    referee.enable_debug_run(true);
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
}
