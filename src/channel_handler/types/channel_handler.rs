use rand::prelude::*;

use rand::distributions::Standard;

use serde::{Deserialize, Serialize};

use crate::channel_handler::types::{PotatoSignatures, UnrollCoin};
use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::load_clvm::read_hex_puzzle;
use crate::common::standard_coin::get_standard_coin_puzzle;
use crate::common::types::{
    Aggsig, AllocEncoder, Error, Hash, PrivateKey, Puzzle, PuzzleHash, Sha256tree
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
    ) -> Result<ChannelHandlerEnv<'a, R>, Error> {
        let referee_coin_puzzle = read_hex_puzzle(allocator, "clsp/referee/onchain/referee.hex")?;
        let referee_coin_puzzle_v1 =
            read_hex_puzzle(allocator, "clsp/referee/onchain/referee-v1.hex")?;
        let unroll_puzzle = read_hex_puzzle(
            allocator,
            "clsp/unroll/unroll_puzzle_state_channel_unrolling.hex",
        )?;
        let unroll_metapuzzle = read_hex_puzzle(allocator, "clsp/unroll/unroll_meta_puzzle.hex")?;
        let standard_puzzle = get_standard_coin_puzzle(allocator)?;
        let referee_coin_puzzle_hash = referee_coin_puzzle.sha256tree(allocator);
        let referee_coin_puzzle_hash_v1 = referee_coin_puzzle_v1.sha256tree(allocator);
        Ok(ChannelHandlerEnv {
            allocator,
            rng,
            referee_coin_puzzle,
            referee_coin_puzzle_hash,
            referee_coin_puzzle_v1,
            referee_coin_puzzle_hash_v1,
            unroll_metapuzzle,
            unroll_puzzle,
            standard_puzzle,
            agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        })
    }
}
