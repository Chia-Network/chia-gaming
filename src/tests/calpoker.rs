use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::types::{Amount, AllocEncoder, Error, Hash, PuzzleHash, PrivateKey, Sha256tree};
use crate::common::standard_coin::{ChiaIdentity, read_hex_puzzle};
use crate::channel_handler::game::Game;
use crate::channel_handler::types::ChannelHandlerEnv;
use crate::tests::channel_handler::ChannelHandlerParty;
use crate::tests::game::new_channel_handler_game;
use crate::tests::simulator::Simulator;

pub fn load_calpoker(allocator: &mut AllocEncoder) -> Result<Game, Error> {
    Game::new(allocator, "resources/calpoker_include_calpoker_template.hex")
}

#[test]
fn test_load_calpoker() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();

    // Generate keys and puzzle hashes.
    let my_private_key: PrivateKey = rng.gen();
    let their_private_key: PrivateKey = rng.gen();

    let identities = [
        ChiaIdentity::new(&mut allocator, my_private_key).expect("should generate"),
        ChiaIdentity::new(&mut allocator, their_private_key).expect("should generate")
    ];

    let calpoker = load_calpoker(&mut allocator).expect("should load");
    let contributions = [Amount::new(100), Amount::new(100)];
    let referee_coin_puzzle = read_hex_puzzle(
        &mut allocator,
        "onchain/referee.hex"
    ).expect("should be readable");
    let referee_coin_puzzle_hash: PuzzleHash = referee_coin_puzzle.sha256tree(&mut allocator);
    let unroll_puzzle = read_hex_puzzle(
        &mut allocator,
        "resources/unroll_puzzle_state_channel_unrolling.hex").expect("should read"
    );
    let mut env = ChannelHandlerEnv {
        allocator: &mut allocator,
        rng: &mut rng,
        referee_coin_puzzle,
        referee_coin_puzzle_hash,
        unroll_metapuzzle: identities[0].puzzle.clone(),
        unroll_puzzle,
        agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA.clone()),
    };

    let simulator = Simulator::new();
    let game_party = new_channel_handler_game(
        &simulator,
        &mut env,
        &calpoker,
        &identities,
        contributions,
    );
}
