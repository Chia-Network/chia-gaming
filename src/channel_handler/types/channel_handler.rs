use rand::prelude::*;

use rand::distributions::Standard;

use serde::{Deserialize, Serialize};

use crate::channel_handler::types::{PotatoSignatures, UnrollCoin};
use crate::common::types::{
    Aggsig, AllocEncoder, Hash, PrivateKey, Puzzle, PuzzleHash, Sha256tree,
};

#[derive(Clone, Serialize, Deserialize)]
pub struct ChannelHandlerPrivateKeys {
    pub my_channel_coin_private_key: PrivateKey,
    pub my_unroll_coin_private_key: PrivateKey,
    pub my_referee_private_key: PrivateKey,
}

impl Distribution<ChannelHandlerPrivateKeys> for Standard {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> ChannelHandlerPrivateKeys {
        ChannelHandlerPrivateKeys {
            my_channel_coin_private_key: rng.gen(),
            my_unroll_coin_private_key: rng.gen(),
            my_referee_private_key: rng.gen(),
        }
    }
}

#[derive(Clone)]
pub struct ChannelHandlerInitiationResult {
    pub channel_puzzle_hash_up: PuzzleHash,
    pub my_initial_channel_half_signature_peer: Aggsig,
}

/// The channel handler can use these two items to produce a spend on chain.
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct ChannelHandlerUnrollSpendInfo {
    /// Contains the half signature, puzzle and conditions needed to spend.
    pub coin: UnrollCoin,
    /// Contains the other half of the signature.
    pub signatures: PotatoSignatures,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub enum GameStartFailed {
    OutOfMoney,
}

#[derive(Clone, Debug)]
pub enum StartGameResult {
    Failure(GameStartFailed),
    Success(Box<PotatoSignatures>),
}

pub struct ChannelHandlerEnv<'a, R: Rng> {
    pub allocator: &'a mut AllocEncoder,
    pub rng: &'a mut R,
    pub unroll_metapuzzle: Puzzle,
    pub unroll_puzzle: Puzzle,

    pub referee_coin_puzzle: Puzzle,
    pub referee_coin_puzzle_hash: PuzzleHash,

    pub referee_coin_puzzle_v1: Puzzle,
    pub referee_coin_puzzle_hash_v1: PuzzleHash,

    pub standard_puzzle: Puzzle,

    pub agg_sig_me_additional_data: Hash,
}

impl<'a, R: Rng> ChannelHandlerEnv<'a, R> {
    pub fn new(
        allocator: &'a mut AllocEncoder,
        rng: &'a mut R,
        unroll_metapuzzle: Puzzle,
        unroll_puzzle: Puzzle,
        referee_coin_puzzle: Puzzle,
        referee_coin_puzzle_v1: Puzzle,
        standard_puzzle: Puzzle,
        agg_sig_me_additional_data: Hash,
    ) -> ChannelHandlerEnv<'a, R> {
        let referee_coin_puzzle_hash = referee_coin_puzzle.sha256tree(allocator);
        let referee_coin_puzzle_hash_v1 = referee_coin_puzzle_v1.sha256tree(allocator);
        ChannelHandlerEnv {
            allocator,
            rng,
            referee_coin_puzzle,
            referee_coin_puzzle_hash,
            referee_coin_puzzle_v1,
            referee_coin_puzzle_hash_v1,
            unroll_metapuzzle,
            unroll_puzzle,
            standard_puzzle,
            agg_sig_me_additional_data,
        }
    }
}
