use lazy_static::lazy_static;
use rand::prelude::*;
use rand_chacha::ChaCha8Rng;

use clvmr::allocator::Allocator;

use crate::common::types::{Amount, CoinString, PublicKey, ClvmObject, CoinID, Sha256tree};
use crate::channel_handler::handler::ChannelHandler;
use crate::channel_handler::types::{ChannelHandlerInitiationData, ChannelHandlerEnv, read_unroll_metapuzzle, read_unroll_puzzle};

lazy_static! {
    pub static ref THEIR_STATE_PUBKEY: PublicKey = {
        PublicKey::from_bytes(&[
            0xb6,
            0x4e,
            0x83,
            0xdc,
            0x97,
            0x32,
            0x20,
            0x53,
            0x77,
            0xf2,
            0x26,
            0x47,
            0xdc,
            0x38,
            0xc1,
            0xd1,
            0x97,
            0xa6,
            0x72,
            0x88,
            0x26,
            0x82,
            0x6f,
            0x69,
            0xaf,
            0x35,
            0x28,
            0x36,
            0x2b,
            0xc7,
            0xb8,
            0x3a,
            0x17,
            0x90,
            0x83,
            0xe9,
            0x82,
            0x44,
            0x8c,
            0x21,
            0x93,
            0x40,
            0xc8,
            0xdd,
            0x6b,
            0xdb,
            0x79,
            0xcd,
        ])
    };

    pub static ref THEIR_UNROLL_PUBKEY: PublicKey = {
        PublicKey::from_bytes(&[
            0x99,
            0xf7,
            0xa7,
            0x96,
            0xf1,
            0x4c,
            0x63,
            0x98,
            0xc4,
            0x14,
            0x94,
            0x3a,
            0x2d,
            0x0c,
            0xbc,
            0x39,
            0xcf,
            0x47,
            0x2c,
            0x15,
            0xec,
            0x32,
            0x84,
            0x01,
            0x0e,
            0x57,
            0xaa,
            0x62,
            0x73,
            0x59,
            0x78,
            0xe9,
            0x84,
            0x3d,
            0x09,
            0x98,
            0xf5,
            0x41,
            0xa1,
            0xa9,
            0x29,
            0x95,
            0xa0,
            0x55,
            0x2d,
            0x9b,
            0x1c,
            0x42,
        ])
    };
}

#[test]
fn test_smoke_can_initiate_channel_handler() {
    let mut allocator = Allocator::new();
    let mut rng = ChaCha8Rng::from_seed([0; 32]);
    let mut ch = ChannelHandler::construct_with_rng(&mut rng);
    let their_referee = ClvmObject::from_nodeptr(allocator.one());
    let ref_puzzle_hash = their_referee.sha256tree(&mut allocator);
    let unroll_metapuzzle = read_unroll_metapuzzle(&mut allocator).unwrap();
    let unroll_puzzle = read_unroll_puzzle(&mut allocator).unwrap();
    let mut env = ChannelHandlerEnv {
        allocator: &mut allocator,
        unroll_metapuzzle,
        unroll_puzzle,
    };
    let initiation_result = ch.initiate(&mut env, &ChannelHandlerInitiationData {
        launcher_coin_id: CoinID::default(),
        we_start_with_potato: false,
        their_state_pubkey: THEIR_STATE_PUBKEY.clone(),
        their_unroll_pubkey: THEIR_UNROLL_PUBKEY.clone(),
        their_referee_puzzle_hash: ref_puzzle_hash,
        my_contribution: Amount::new(100),
        their_contribution: Amount::new(100)
    }).expect("should construct");
}

