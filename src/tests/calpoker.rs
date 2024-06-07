use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::types::{Amount, AllocEncoder, Error, Hash, PuzzleHash, PrivateKey, Sha256tree};
use crate::common::standard_coin::{ChiaIdentity, read_hex_puzzle};
use crate::channel_handler::game::Game;
use crate::channel_handler::types::ChannelHandlerEnv;
use crate::tests::channel_handler::ChannelHandlerParty;
use crate::tests::game::new_channel_handler_game;
use crate::tests::simulator::SimulatorEnvironment;

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

    let simenv = SimulatorEnvironment::new(
        &mut allocator,
        &mut rng,
        seed,
        &calpoker,
        &contributions
    ).expect("should get a sim env");
}
