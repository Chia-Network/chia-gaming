use std::rc::Rc;

#[cfg(feature = "sim-tests")]
use log::debug;
#[cfg(feature = "sim-tests")]
use rand::prelude::*;
#[cfg(feature = "sim-tests")]
use rand_chacha::ChaCha8Rng;
#[cfg(feature = "sim-tests")]
use std::rc::Rc;

use clvm_traits::{ClvmEncoder, ToClvm};

#[cfg(feature = "sim-tests")]
use crate::channel_handler::game::Game;
#[cfg(feature = "sim-tests")]
use crate::channel_handler::types::ReadableMove;
#[cfg(feature = "sim-tests")]
use crate::common::types::Amount;
use crate::common::types::{AllocEncoder, Program, Sha256Input};
#[cfg(feature = "sim-tests")]
use crate::common::types::{Error, GameID, Hash};
use crate::channel_handler::types::ReadableMove;
#[cfg(feature = "sim-tests")]
use crate::games::calpoker::make_cards;
#[cfg(feature = "sim-tests")]
use crate::games::calpoker::{decode_calpoker_readable, decode_readable_card_choices};
#[cfg(feature = "sim-tests")]
use crate::games::calpoker::{CalpokerHandValue, RawCalpokerHandValue};
#[cfg(feature = "sim-tests")]
use crate::games::calpoker::{CalpokerResult, WinDirectionUser};
#[cfg(feature = "sim-tests")]
use crate::shutdown::BasicShutdownConditions;
use crate::tests::game::GameAction;
#[cfg(feature = "sim-tests")]
use crate::tests::game::GameActionResult;

#[cfg(feature = "sim-tests")]
use crate::tests::simenv::SimulatorEnvironment;

#[cfg(feature = "sim-tests")]
pub fn load_calpoker(allocator: &mut AllocEncoder, game_id: GameID) -> Result<Game, Error> {
    Game::new(
        allocator,
        game_id,
        "clsp/games/calpoker-v0/calpoker_include_calpoker_template.hex",
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
        .encode_atom(clvm_traits::Atom::Borrowed(b"0bob456789abcdef"))
        .expect("should work");
    let alice_picks = [0, 1, 0, 1, 0, 1, 0, 1]
        .to_clvm(allocator)
        .expect("should work");
    let bob_picks = [1, 0, 1, 0, 1, 0, 1, 0]
        .to_clvm(allocator)
        .expect("should work");
    let win_move_200 = 200.to_clvm(allocator).expect("should work");

    let mut readable_moves = Vec::new();
    for move_node in [
        &alice_word_hash,
        &bob_word,
        &alice_picks,
        &bob_picks,
        &win_move_200,
    ]
    .into_iter()
    {
        readable_moves.push(ReadableMove::from_program(Rc::new(
            Program::from_nodeptr(allocator, *move_node).expect("good"),
        )));
    }

    [
        GameAction::Move(0, readable_moves[0].clone(), true),
        GameAction::Move(1, readable_moves[1].clone(), true),
        // Alice's reveal of her card generating seed and her commit to which
        // cards she's picking.
        GameAction::Move(0, readable_moves[2].clone(), true),
        GameAction::Move(1, readable_moves[3].clone(), true),
        // Move is a declared split.
        GameAction::Move(0, readable_moves[4].clone(), true),
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
#[cfg(feature = "sim-tests")]
#[test]
fn test_verify_endgame_data() {
    let mut allocator = AllocEncoder::new();
    let moves = test_moves_1(&mut allocator);
    let game_action_results = run_calpoker_play_test(&mut allocator, &moves).expect("should work");
    debug!("play_result {game_action_results:?}");
    if let GameActionResult::MoveResult(penultimate_game_data, _, _, _) =
        game_action_results[game_action_results.len() - 1]
    {
        let is_bob_move: bool = true;
        let decoded = decode_calpoker_readable(
            &mut allocator,
            penultimate_game_data,
            Amount::new(200),
            is_bob_move,
        )
        .expect("should work");
        // decoded is a description of Alice's result, from Bob's point of view
        // Bob won this game
        // Bob should get a reward coin for 200
        // Alice should get 0
        assert_eq!(
            decoded,
            CalpokerResult {
                raw_alice_selects: 170, // me.raw_selects
                raw_bob_picks: 205,
                raw_alice_picks: 185,
                alice_hand_result: CalpokerHandValue::TwoPair(4, 2, 12),
                alice_hand_value: RawCalpokerHandValue::SimpleList(vec![2, 2, 1, 4, 2, 12]),
                bob_hand_result: CalpokerHandValue::Pair(3, vec![3, 14, 13, 11]),
                bob_hand_value: RawCalpokerHandValue::SimpleList(vec![2, 1, 1, 1, 3, 14, 13, 11]),
                your_share: 200,
                game_amount: 200,
                raw_win_direction: 1,
                win_direction: Some(WinDirectionUser::Alice),
            }
        );
    } else {
        panic!("{:?}", game_action_results);
    };
}

#[cfg(feature = "sim-tests")]
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

#[cfg(feature = "sim-tests")]
#[test]
fn test_play_calpoker_end_game_reward() {
    let mut allocator = AllocEncoder::new();

    let mut moves = test_moves_1(&mut allocator).to_vec();
    moves.push(GameAction::Accept(1));
    moves.push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));

    debug!("running moves {moves:?}");
    let _game_action_results = run_calpoker_play_test(&mut allocator, &moves).expect("should work");
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
