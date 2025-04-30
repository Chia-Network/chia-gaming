use rand::prelude::*;

use rand::distributions::Standard;
use std::collections::HashMap;

use crate::channel_handler::types::{PotatoSignatures, UnrollCoin};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinID, Hash, PrivateKey, PublicKey, Puzzle, PuzzleHash,
    Sha256tree, Timeout,
};
use crate::common::standard_coin::read_hex_puzzle;

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
    pub my_contribution: Amount,
    pub their_contribution: Amount,
    pub unroll_advance_timeout: Timeout,
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

    pub standard_puzzle: Puzzle,

    pub agg_sig_me_additional_data: Hash,
    pub puzzle_name_map: HashMap<PuzzleHash, String>,
}
// TODO: Also, name new puzzles as we create them (e.g. curried in arguments, singleton spends)
pub fn make_puzzle_name_map(allocator: &mut AllocEncoder) -> HashMap<PuzzleHash, String> {
    let validation_program_names = ["a", "b", "c", "d", "e"];
    let mut puzzle_name_pairs:HashMap<PuzzleHash, String> = HashMap::default();
    for name in validation_program_names {
        let program = read_hex_puzzle(allocator, &format!("clsp/onchain/calpoker/{name}.hex")).expect("should read");
        let hash = program.sha256tree(allocator);
        puzzle_name_pairs.insert(hash, name.to_string());
    }
    puzzle_name_pairs
}

impl<'a, R: Rng> ChannelHandlerEnv<'a, R> {
    pub fn new(
        allocator: &'a mut AllocEncoder,
        rng: &'a mut R,
        unroll_metapuzzle: Puzzle,
        unroll_puzzle: Puzzle,
        referee_coin_puzzle: Puzzle,
        standard_puzzle: Puzzle,
        agg_sig_me_additional_data: Hash,
        puzzle_name_map: HashMap<PuzzleHash, String>,
    ) -> ChannelHandlerEnv<'a, R> {
        let referee_coin_puzzle_hash = referee_coin_puzzle.sha256tree(allocator);
        ChannelHandlerEnv {
            allocator,
            rng,
            referee_coin_puzzle,
            referee_coin_puzzle_hash,
            unroll_metapuzzle,
            unroll_puzzle,
            standard_puzzle,
            agg_sig_me_additional_data,
            puzzle_name_map: puzzle_name_map,
        }
    }
}
