use log::debug;
use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use clvm_traits::{ClvmEncoder, ToClvm};

use crate::channel_handler::game::Game;
use crate::channel_handler::types::ReadableMove;
use crate::common::types::{AllocEncoder, Amount, Error, GameID, Hash, Sha256Input};
use crate::games::calpoker::decode_readable_card_choices;
use crate::games::calpoker::make_cards;
use crate::tests::game::{GameAction, GameActionResult};

#[cfg(feature = "sim-tests")]
use crate::tests::simenv::SimulatorEnvironment;

pub fn load_calpoker(allocator: &mut AllocEncoder, game_id: GameID) -> Result<Game, Error> {
    Game::new(
        allocator,
        game_id,
        "clsp/calpoker_include_calpoker_template.hex",
    )
}

#[cfg(feature = "sim-tests")]
#[test]
fn test_load_calpoker() {
    let mut allocator = AllocEncoder::new();
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let game_id_data: Hash = rng.gen();
    let game_id = GameID::new(game_id_data.bytes().to_vec());
    let calpoker = load_calpoker(&mut allocator, game_id).expect("should load");
    let contributions = [Amount::new(100), Amount::new(100)];

    let _simenv = SimulatorEnvironment::new(&mut allocator, &mut rng, &calpoker, &contributions)
        .expect("should get a sim env");
}

#[cfg(feature = "sim-tests")]
fn run_calpoker_play_test(
    allocator: &mut AllocEncoder,
    moves: &[GameAction],
) -> Result<Vec<GameActionResult>, Error> {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let game_id_data: Hash = rng.gen();
    let game_id = GameID::new(game_id_data.bytes().to_vec());
    let calpoker = load_calpoker(allocator, game_id).expect("should load");
    let contributions = [Amount::new(100), Amount::new(100)];

    let mut simenv = SimulatorEnvironment::new(allocator, &mut rng, &calpoker, &contributions)
        .expect("should get a sim env");

    simenv.play_game(moves)
}

pub fn test_moves_1(allocator: &mut AllocEncoder) -> [GameAction; 5] {
    let alice_word = b"0alice6789abcdef";
    let alice_word_hash = Sha256Input::Bytes(alice_word)
        .hash()
        .to_clvm(allocator)
        .expect("should work");
    let bob_word = allocator
        .encode_atom(b"0bob456789abcdef")
        .expect("should work");
    let alice_picks = [0, 1, 0, 1, 0, 1, 0, 1]
        .to_clvm(allocator)
        .expect("should work");
    let bob_picks = [1, 0, 1, 0, 1, 0, 1, 0]
        .to_clvm(allocator)
        .expect("should work");
    let win_move = ().to_clvm(allocator).expect("should work");

    [
        GameAction::Move(0, alice_word_hash, true),
        GameAction::Move(1, bob_word, true),
        // Alice's reveal of her card generating seed and her commit to which
        // cards she's picking.
        GameAction::Move(0, alice_picks, true),
        GameAction::Move(1, bob_picks, true),
        // Move is a declared split.
        GameAction::Move(0, win_move, true),
    ]
}

#[cfg(feature = "sim-tests")]
#[test]
fn test_play_calpoker_happy_path() {
    let mut allocator = AllocEncoder::new();
    let moves = test_moves_1(&mut allocator);
    let test1 = run_calpoker_play_test(&mut allocator, &moves).expect("should work");
    debug!("play_result {test1:?}");
}

fn test_make_cards_vs_message_handler() {
    let left = (
        [
            (3, 3),
            (6, 4),
            (7, 1),
            (7, 4),
            (8, 1),
            (10, 2),
            (11, 1),
            (12, 2),
        ],
        [
            (5, 1),
            (6, 2),
            (9, 1),
            (9, 3),
            (10, 3),
            (11, 4),
            (12, 1),
            (12, 3),
        ],
    );
    let right = (
        [
            (2, 1),
            (3, 4),
            (4, 3),
            (4, 4),
            (10, 1),
            (11, 1),
            (12, 2),
            (1, 2),
        ],
        [
            (2, 3),
            (3, 3),
            (4, 2),
            (5, 2),
            (6, 3),
            (6, 4),
            (7, 4),
            (13, 4),
        ],
    );

    let alice_message_bytes = hex::decode("eb04c21e3ee58d1b494e0b5be68ee5e5");
    let x = hex::decode("5192272f4a71debcc8b317095bec6673");
    // let entropy =
    //let make_cards_output = make_cards(&alice_message_bytes, entropy.bytes(), Amount::new(200));
}

fn extract_info_from_game(game_results: &[GameActionResult]) -> (Hash, ReadableMove, Vec<u8>) {
    if let GameActionResult::MoveResult(_, _, _, entropy) = &game_results[1] {
        game_results.iter().find_map(|x| {
            if let GameActionResult::MoveResult(_, message_bytes, Some(clvm_data), _) = x {
                // Alice: message_bytes
                // Bob: entropy
                Some((entropy.clone(), clvm_data.clone(), message_bytes.clone()))
            } else {
                None
            }
        })
    } else {
        None
    }
    .unwrap()
}

#[cfg(feature = "sim-tests")]
#[test]
fn test_verify_bob_message() {
    // Ensure the bytes being passed on are structured correctly
    // Verify message decoding
    let mut allocator = AllocEncoder::new();
    let moves = test_moves_1(&mut allocator);
    let game_results = run_calpoker_play_test(&mut allocator, &moves).expect("should work");

    let (entropy, bob_clvm_data, alice_message_bytes) = extract_info_from_game(&game_results);
    let got = decode_readable_card_choices(&mut allocator, bob_clvm_data).unwrap();
    let expected = make_cards(&alice_message_bytes, entropy.bytes(), Amount::new(200));

    debug!("play_result {game_results:?}");
    assert_eq!(got, expected);
}

#[cfg(feature = "sim-tests")]
#[test]
fn test_play_calpoker_on_chain_after_1_move_p1() {
    let mut allocator = AllocEncoder::new();

    // Make a prototype go on chain scenario by starting with move 1.
    // The second player receives the move, and then observes the first player
    // going on chain.
    let moves = test_moves_1(&mut allocator);
    let mut on_chain_moves_1: Vec<GameAction> = moves.into_iter().take(1).collect();
    on_chain_moves_1.push(GameAction::GoOnChain(true as usize));
    let test2 = run_calpoker_play_test(&mut allocator, &on_chain_moves_1).expect("should work");
    debug!("play_result {test2:?}");
}

#[cfg(feature = "sim-tests")]
#[test]
fn test_play_calpoker_on_chain_after_1_move_p0_lost_message() {
    let mut allocator = AllocEncoder::new();
    let moves = test_moves_1(&mut allocator);
    let mut on_chain_moves_2: Vec<GameAction> =
        moves.into_iter().take(1).map(|x| x.lose()).collect();
    on_chain_moves_2.push(GameAction::GoOnChain(true as usize));
    let test3 = run_calpoker_play_test(&mut allocator, &on_chain_moves_2).expect("should work");
    debug!("play_result {test3:?}");
}

#[cfg(feature = "sim-tests")]
#[test]
fn test_play_calpoker_on_chain_after_1_move_p0() {
    let mut allocator = AllocEncoder::new();
    let moves = test_moves_1(&mut allocator);
    let mut on_chain_moves_2: Vec<GameAction> = moves.into_iter().take(1).collect();
    on_chain_moves_2.push(GameAction::GoOnChain(true as usize));
    let test3 = run_calpoker_play_test(&mut allocator, &on_chain_moves_2).expect("should work");
    debug!("play_result {test3:?}");
}

#[cfg(feature = "sim-tests")]
#[test]
fn test_play_calpoker_on_chain_after_2_moves_p0() {
    let mut allocator = AllocEncoder::new();
    let moves = test_moves_1(&mut allocator);
    // Alice moves, then bob, then bob spends the channel coin.
    let mut on_chain_moves_3: Vec<GameAction> = moves.into_iter().take(2).collect();
    on_chain_moves_3.push(GameAction::GoOnChain(false as usize));
    let test4 = run_calpoker_play_test(&mut allocator, &on_chain_moves_3).expect("should work");
    debug!("play_result {test4:?}");
}

#[cfg(feature = "sim-tests")]
#[test]
fn test_play_calpoker_on_chain_after_2_moves_p1() {
    let mut allocator = AllocEncoder::new();
    let moves = test_moves_1(&mut allocator);
    // Alice moves, then bob, then bob spends the channel coin.
    let mut on_chain_moves_3: Vec<GameAction> = moves.into_iter().take(2).collect();
    on_chain_moves_3.push(GameAction::GoOnChain(true as usize));
    let test4 = run_calpoker_play_test(&mut allocator, &on_chain_moves_3);
    assert!(test4.is_err());
    assert!(format!("{:?}", test4).contains("from the past"));
    debug!("play_result {test4:?}");
}

// Bram: slashing tests
//
// I think this is a decent list of slashing tests: Alice attempts to give
// herself too much with honest cards and Bob successfully slashes with honest
// cards. Alice attempts to give herself too much with bad cards and Bob
// successfully slashes with honest cards. Alice gives herself an honest amount
// and Bob fails to slash with honest cards. Alice gives herself an honest
// amount and Bob fails to slash with bad cards. That's four tests which should
// be run each with the Alice wins, Bob wins, and tie scenarios with the caveat
// that Alice can't 'cheat' when she's already supposed to win everything and
// Bob can't cheat when he's supposed to win everything. We can fuzz to find the
// three hands then inspect manually to sanity check the hand evals and find bad
// cards
//
// Test that we can't move off chain when validation puzzle hash is nil.
//
// Move without receive
//
// Also have to test forcing an out of date version on chain which requires some behavior which the code can't be prompted to do
//
// About game creation:
//
// give game parameters to factory.
// start game info: parameters should be included here as well
//
// factory produces initial move, initial share etc.
//
// Pass parameters over the wire instead of outputs to game factory.
//
// Pass game handler its own mod hash.
