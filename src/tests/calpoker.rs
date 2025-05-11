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
use crate::common::types::{AllocEncoder, Sha256Input};
#[cfg(feature = "sim-tests")]
use crate::common::types::{Error, GameID, Hash};
#[cfg(feature = "sim-tests")]
use crate::games::calpoker::{decode_calpoker_readable, decode_readable_card_choices};
#[cfg(feature = "sim-tests")]
use crate::games::calpoker::{
    get_final_cards_in_canonical_order, select_cards_using_bits, RawCalpokerHandValue,
};
#[cfg(feature = "sim-tests")]
use crate::games::calpoker::{CalpokerResult, WinDirectionUser};
#[cfg(feature = "sim-tests")]
use crate::shutdown::BasicShutdownConditions;
use crate::tests::game::GameAction;
#[cfg(feature = "sim-tests")]
use crate::tests::game::GameActionResult;

#[cfg(feature = "sim-tests")]
use crate::tests::simenv::SimulatorEnvironment;

pub const CALPOKER_HEX_FILE: &'static str = "clsp/calpoker_include_calpoker_template.hex";

#[cfg(feature = "sim-tests")]
pub fn load_calpoker(allocator: &mut AllocEncoder, game_id: GameID) -> Result<Game, Error> {
    Game::new(allocator, true, &game_id, CALPOKER_HEX_FILE)
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

pub struct CalpokerMoveData {
    pub alice_discards: u8,
    pub bob_discards: u8,
    pub moves: Vec<GameAction>,
}

pub fn test_moves_1(allocator: &mut AllocEncoder) -> CalpokerMoveData {
    let alice_word = b"0alice6789abcdef";
    let alice_word_hash = Sha256Input::Bytes(alice_word)
        .hash()
        .to_clvm(allocator)
        .expect("should work");
    let bob_word = allocator
        .encode_atom(clvm_traits::Atom::Borrowed(b"0bob456789abcdef"))
        .expect("should work");
    let alice_picks = allocator
        .encode_atom(clvm_traits::Atom::Borrowed(&[0x55]))
        .expect("should work");
    let bob_picks = allocator
        .encode_atom(clvm_traits::Atom::Borrowed(&[0xaa]))
        .expect("should work");
    let win_move_200 = 200.to_clvm(allocator).expect("should work");

    CalpokerMoveData {
        alice_discards: 0x55,
        bob_discards: 0xaa,
        moves: vec![
            GameAction::Move(0, alice_word_hash, true),
            GameAction::Move(1, bob_word, true),
            // Alice's reveal of her card generating seed and her commit to which
            // cards she's picking.
            GameAction::Move(0, alice_picks, true),
            GameAction::Move(1, bob_picks, true),
            // Move is a declared split.
            GameAction::Move(0, win_move_200, true),
        ],
    }
}

#[cfg(feature = "sim-tests")]
#[test]
fn test_play_calpoker_happy_path() {
    let mut allocator = AllocEncoder::new();
    let game = test_moves_1(&mut allocator);
    let test1 = run_calpoker_play_test(&mut allocator, &game.moves).expect("should work");
    debug!("play_result {test1:?}");
}
#[cfg(feature = "sim-tests")]
#[test]
fn test_verify_endgame_data() {
    let mut allocator = AllocEncoder::new();
    let game = test_moves_1(&mut allocator);
    let game_action_results =
        run_calpoker_play_test(&mut allocator, &game.moves).expect("should work");
    debug!("play_result {game_action_results:?}");
    if let GameActionResult::MoveResult(penultimate_game_data, _, _, _) =
        game_action_results[game_action_results.len() - 1]
    {
        let is_alice_move: bool = false;
        let with_message: Vec<ReadableMove> = game_action_results
            .iter()
            .filter_map(|m| {
                if let GameActionResult::MoveResult(_, _, msg, _) = m {
                    msg.clone()
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(with_message.len(), 1);
        let (alice_initial_cards, bob_initial_cards) =
            decode_readable_card_choices(&mut allocator, with_message[0].clone())
                .expect("should decode");
        let (alice_final_cards, bob_final_cards) = get_final_cards_in_canonical_order(
            &mut allocator,
            &alice_initial_cards,
            0x55,
            &bob_initial_cards,
            0xaa,
        )
        .expect("should work");
        let (alice_final_hand, _) = select_cards_using_bits(&alice_final_cards, 227);
        let (bob_final_hand, _) = select_cards_using_bits(&bob_final_cards, 143);

        let decoded = decode_calpoker_readable(
            &mut allocator,
            penultimate_game_data,
            is_alice_move,
            0xaa,
            &alice_initial_cards,
            &bob_initial_cards,
        )
        .expect("should work");
        // decoded is a description of Alice's result, from Bob's point of view
        // Bob won this game
        // Bob should get a reward coin for 200
        // Alice should get 0
        assert_eq!(
            decoded,
            CalpokerResult {
                my_discards: 0xaa, // me.raw_selects
                opponent_discards: 0x55,
                raw_alice_selects: 227,
                raw_bob_selects: 143,
                alice_hand_value: RawCalpokerHandValue::SimpleList(vec![2, 1, 1, 1, 3, 14, 13, 11]),
                bob_hand_value: RawCalpokerHandValue::SimpleList(vec![2, 2, 1, 4, 2, 12]),
                raw_win_direction: 1,
                win_direction: Some(WinDirectionUser::Bob),
                alice_final_hand,
                bob_final_hand,
            }
        );
    } else {
        panic!("{:?}", game_action_results);
    };
}

#[cfg(feature = "sim-tests")]
#[test]
fn test_play_calpoker_on_chain_after_1_move_p1() {
    let mut allocator = AllocEncoder::new();

    // Make a prototype go on chain scenario by starting with move 1.
    // The second player receives the move, and then observes the first player
    // going on chain.
    let game = test_moves_1(&mut allocator);
    let mut on_chain_moves_1: Vec<GameAction> = game.moves.iter().cloned().take(1).collect();
    on_chain_moves_1.push(GameAction::GoOnChain(true as usize));
    let test2 = run_calpoker_play_test(&mut allocator, &on_chain_moves_1).expect("should work");
    debug!("play_result {test2:?}");
}

#[cfg(feature = "sim-tests")]
#[test]
fn test_play_calpoker_on_chain_after_1_move_p0_lost_message() {
    let mut allocator = AllocEncoder::new();
    let game = test_moves_1(&mut allocator);
    let mut on_chain_moves_2: Vec<GameAction> = game
        .moves
        .iter()
        .cloned()
        .take(1)
        .map(|x| x.lose())
        .collect();
    on_chain_moves_2.push(GameAction::GoOnChain(true as usize));
    let test3 = run_calpoker_play_test(&mut allocator, &on_chain_moves_2).expect("should work");
    debug!("play_result {test3:?}");
}

#[cfg(feature = "sim-tests")]
#[test]
fn test_play_calpoker_on_chain_after_1_move_p0() {
    let mut allocator = AllocEncoder::new();
    let game = test_moves_1(&mut allocator);
    let mut on_chain_moves_2: Vec<GameAction> = game.moves.iter().cloned().take(1).collect();
    on_chain_moves_2.push(GameAction::GoOnChain(true as usize));
    let test3 = run_calpoker_play_test(&mut allocator, &on_chain_moves_2).expect("should work");
    debug!("play_result {test3:?}");
}

#[cfg(feature = "sim-tests")]
#[test]
fn test_play_calpoker_on_chain_after_2_moves_p0() {
    let mut allocator = AllocEncoder::new();
    let game = test_moves_1(&mut allocator);
    // Alice moves, then bob, then bob spends the channel coin.
    let mut on_chain_moves_3: Vec<GameAction> = game.moves.iter().cloned().take(2).collect();
    on_chain_moves_3.push(GameAction::GoOnChain(false as usize));
    let test4 = run_calpoker_play_test(&mut allocator, &on_chain_moves_3).expect("should work");
    debug!("play_result {test4:?}");
}

#[cfg(feature = "sim-tests")]
#[test]
fn test_play_calpoker_on_chain_after_2_moves_p1() {
    let mut allocator = AllocEncoder::new();
    let game = test_moves_1(&mut allocator);
    // Alice moves, then bob, then bob spends the channel coin.
    let mut on_chain_moves_3: Vec<GameAction> = game.moves.iter().cloned().take(2).collect();
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

    let mut game = test_moves_1(&mut allocator);
    game.moves.push(GameAction::Accept(1));
    game.moves
        .push(GameAction::Shutdown(0, Rc::new(BasicShutdownConditions)));

    debug!("running moves {:?}", game.moves);
    let _game_action_results =
        run_calpoker_play_test(&mut allocator, &game.moves).expect("should work");
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
