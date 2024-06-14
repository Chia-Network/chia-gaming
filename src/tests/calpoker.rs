use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use clvm_traits::ToClvm;

use crate::common::types::{Amount, AllocEncoder, Error, Sha256Input};
use crate::channel_handler::game::Game;
use crate::tests::simulator::{SimulatorEnvironment, GameAction};

pub fn load_calpoker(allocator: &mut AllocEncoder) -> Result<Game, Error> {
    Game::new(allocator, "resources/calpoker_include_calpoker_template.hex")
}

#[test]
fn test_load_calpoker() {
    let mut allocator = AllocEncoder::new();
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let calpoker = load_calpoker(&mut allocator).expect("should load");
    let contributions = [Amount::new(100), Amount::new(100)];

    let mut simenv = SimulatorEnvironment::new(
        &mut allocator,
        &mut rng,
        &calpoker,
        &contributions
    ).expect("should get a sim env");
}
