use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::types::{Amount, CoinID, Sha256tree, PrivateKey, AllocEncoder, Node, Hash};
use crate::channel_handler::handler::ChannelHandler;
use crate::channel_handler::types::{ChannelHandlerInitiationData, ChannelHandlerEnv, read_unroll_metapuzzle, read_unroll_puzzle};
use crate::tests::constants::{THEIR_STATE_PUBKEY, THEIR_UNROLL_PUBKEY};

#[test]
fn test_smoke_can_initiate_channel_handler() {
    let mut allocator = AllocEncoder::new();
    let mut rng = ChaCha8Rng::from_seed([0; 32]);
    let mut ch = ChannelHandler::construct_with_rng(&mut rng);
    let their_referee = allocator.allocator().one();
    let ref_puzzle_hash = Node(their_referee).sha256tree(&mut allocator);
    let unroll_metapuzzle = read_unroll_metapuzzle(&mut allocator).unwrap();
    let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
    let mut env = ChannelHandlerEnv {
        allocator: &mut allocator,
        unroll_metapuzzle,
        unroll_puzzle,
        agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA.clone())
    };
    let _initiation_result = ch.initiate(&mut env, &ChannelHandlerInitiationData {
        launcher_coin_id: CoinID::default(),
        we_start_with_potato: false,
        their_state_pubkey: THEIR_STATE_PUBKEY.clone(),
        their_unroll_pubkey: THEIR_UNROLL_PUBKEY.clone(),
        their_referee_puzzle_hash: ref_puzzle_hash,
        my_contribution: Amount::new(100),
        their_contribution: Amount::new(100)
    }).expect("should construct");
}

