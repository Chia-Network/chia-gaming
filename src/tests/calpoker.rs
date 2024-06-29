use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use clvm_traits::{ClvmEncoder, ToClvm};

use crate::common::types::{Amount, AllocEncoder, Error, Sha256Input, GameID, Hash};
use crate::channel_handler::game::Game;
use crate::tests::simulator::{SimulatorEnvironment, GameAction, GameActionResult};

pub fn load_calpoker(allocator: &mut AllocEncoder, game_id: GameID) -> Result<Game, Error> {
    Game::new(allocator, game_id, "resources/calpoker_include_calpoker_template.hex")
}

#[test]
fn test_load_calpoker() {
    let mut allocator = AllocEncoder::new();
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let game_id_data: Hash = rng.gen();
    let game_id = GameID::new(game_id_data.bytes().to_vec());
    let calpoker = load_calpoker(&mut allocator, game_id).expect("should load");
    let contributions = [Amount::new(100), Amount::new(100)];

    let _simenv = SimulatorEnvironment::new(
        &mut allocator,
        &mut rng,
        &calpoker,
        &contributions
    ).expect("should get a sim env");
}

fn run_calpoker_play_test(
    allocator: &mut AllocEncoder,
    moves: &[GameAction]
) -> Result<Vec<GameActionResult>, Error> {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let game_id_data: Hash = rng.gen();
    let game_id = GameID::new(game_id_data.bytes().to_vec());
    let calpoker = load_calpoker(allocator, game_id).expect("should load");
    let contributions = [Amount::new(100), Amount::new(100)];

    let mut simenv = SimulatorEnvironment::new(
        allocator,
        &mut rng,
        &calpoker,
        &contributions
    ).expect("should get a sim env");

    simenv.play_game(moves)
}

#[test]
fn test_play_calpoker_happy_path() {
    let mut allocator = AllocEncoder::new();
    let alice_word = b"0alice6789abcdef";
    let alice_word_hash = Sha256Input::Bytes(alice_word).hash().to_clvm(&mut allocator).expect("should work");
    let bob_word = allocator.encode_atom(b"0bob456789abcdef").expect("should work");
    let alice_picks = [0,1,0,1,0,1,0,1].to_clvm(&mut allocator).expect("should work");
    let bob_picks = [1,0,1,0,1,0,1,0].to_clvm(&mut allocator).expect("should work");
    let alice_win_move = ().to_clvm(&mut allocator).expect("should work");

    let moves = [
        GameAction::Move(0, alice_word_hash),
        GameAction::Move(1, bob_word),
        // Alice's reaveal of her card generating seed and her commit to which
        // cards she's picking.
        GameAction::Move(0, alice_picks),
        GameAction::Move(1, bob_picks),
        // Move is a declared split.
        GameAction::Move(0, alice_win_move),
    ];

    let test1 = run_calpoker_play_test(&mut allocator, &moves).expect("should work");
    eprintln!("play_result {test1:?}");

    // Make a prototype go on chain scenario by starting with move 1.
    let mut use_moves: Vec<GameAction> = moves.iter().take(1).cloned().collect();
    use_moves.push(GameAction::GoOnChain(true as usize));
    // use_moves.append(&mut moves.iter().skip(1).cloned().collect());
    let test2 = run_calpoker_play_test(&mut allocator, &use_moves).expect("should work");
    eprintln!("play_result {test2:?}");
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
