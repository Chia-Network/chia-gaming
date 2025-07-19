use rand::prelude::*;

use rand::distributions::Standard;

use crate::channel_handler::types::{PotatoSignatures, UnrollCoin};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinID, Hash, PrivateKey, PublicKey, Puzzle, PuzzleHash,
    Sha256tree, Timeout,
};

#[derive(Clone)]
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

pub struct ChannelHandlerInitiationData {
    pub launcher_coin_id: CoinID,
    pub we_start_with_potato: bool,
    pub their_channel_pubkey: PublicKey,
    pub their_unroll_pubkey: PublicKey,
    pub their_referee_puzzle_hash: PuzzleHash,
    pub their_reward_puzzle_hash: PuzzleHash,
    pub my_contribution: Amount,
    pub their_contribution: Amount,
    pub unroll_advance_timeout: Timeout,
    pub reward_puzzle_hash: PuzzleHash,
}

#[derive(Clone)]
pub struct ChannelHandlerInitiationResult {
    pub channel_puzzle_hash_up: PuzzleHash,
    pub my_initial_channel_half_signature_peer: Aggsig,
}

/// The channel handler can use these two items to produce a spend on chain.
#[derive(Default, Clone)]
pub struct ChannelHandlerUnrollSpendInfo {
    /// Contains the half signature, puzzle and conditions needed to spend.
    pub coin: UnrollCoin,
    /// Contains the other half of the signature.
    pub signatures: PotatoSignatures,
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
