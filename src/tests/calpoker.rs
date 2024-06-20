use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use clvm_traits::{ClvmEncoder, ToClvm};

use crate::common::types::{Amount, AllocEncoder, Error, Sha256Input, GameID, Hash};
use crate::channel_handler::game::Game;
use crate::tests::simulator::{SimulatorEnvironment, GameAction};

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

#[test]
fn test_play_calpoker_happy_path() {
    let mut allocator = AllocEncoder::new();
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let game_id_data: Hash = rng.gen();
    let game_id = GameID::new(game_id_data.bytes().to_vec());
    let calpoker = load_calpoker(&mut allocator, game_id).expect("should load");
    let contributions = [Amount::new(100), Amount::new(100)];

    let mut simenv = SimulatorEnvironment::new(
        &mut allocator,
        &mut rng,
        &calpoker,
        &contributions
    ).expect("should get a sim env");

    let alice_word = b"0alice6789abcdef";
    let alice_word_hash = Sha256Input::Bytes(alice_word).hash().to_clvm(simenv.env.allocator).expect("should work");
    let bob_word = simenv.env.allocator.encode_atom(b"0bob456789abcdef").expect("should work");
    let alice_picks = [0,1,0,1,0,1,0,1].to_clvm(simenv.env.allocator).expect("should work");
    let bob_picks = [1,0,1,0,1,0,1,0].to_clvm(simenv.env.allocator).expect("should work");
    let alice_win_move = ().to_clvm(simenv.env.allocator).expect("should work");

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
    let play_result = simenv.play_game(&moves).expect("should succeed");
    eprintln!("play_result {play_result:?}");
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
