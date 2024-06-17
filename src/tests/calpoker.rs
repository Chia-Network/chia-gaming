use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use clvm_traits::ToClvm;

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
fn test_play_calpoker() {
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
    let alice_word_hash = Sha256Input::Bytes(alice_word).hash();
    let moves = [
        GameAction::Move(0, alice_word_hash.to_clvm(simenv.env.allocator).expect("should convert")),
    ];
    let _play_result = simenv.play_game(&moves);
}
