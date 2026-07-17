use rand::distr::StandardUniform;
use rand::prelude::*;

use serde::{Deserialize, Serialize};

use crate::channel_state::types::{PotatoSignatures, UnrollCoin};
use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::load_clvm::read_hex_puzzle;
use crate::common::standard_coin::get_standard_coin_puzzle;
use crate::common::types::{
    Aggsig, AllocEncoder, Error, Hash, PrivateKey, ProgramRef, Puzzle, PuzzleHash, Sha256tree,
};

#[derive(Clone, Serialize, Deserialize)]
pub struct ChannelPrivateKeys {
    pub my_channel_coin_private_key: PrivateKey,
    pub my_unroll_coin_private_key: PrivateKey,
    pub my_referee_private_key: PrivateKey,
}

impl Distribution<ChannelPrivateKeys> for StandardUniform {
    fn sample<R: Rng + ?Sized>(&self, rng: &mut R) -> ChannelPrivateKeys {
        let my_channel_coin_private_key: PrivateKey = rng.random();
        let my_unroll_coin_private_key: PrivateKey = rng.random();
        let my_referee_private_key: PrivateKey = rng.random();
        ChannelPrivateKeys {
            my_channel_coin_private_key,
            my_unroll_coin_private_key,
            my_referee_private_key,
        }
    }
}

#[derive(Clone)]
pub struct ChannelInitiationResult {
    pub channel_puzzle_hash_up: PuzzleHash,
    pub my_initial_channel_half_signature_peer: Aggsig,
}

/// The channel handler can use these two items to produce a spend on chain.
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct ChannelUnrollSpendInfo {
    /// Contains the half signature, puzzle and conditions needed to spend.
    pub coin: UnrollCoin,
    /// Contains the other half of the signature.
    pub signatures: PotatoSignatures,
}

/// Minimal data retained for identifying and timing out a historical unroll.
///
/// Historical states never preempt: preemption uses one of the full latest
/// sent/received records. The timeout path only needs the values committed
/// into the historical unroll puzzle and its default solution.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct HistoricalUnrollSpendInfo {
    pub state_number: usize,
    pub conditions_hash: PuzzleHash,
    pub timeout_conditions: ProgramRef,
}

pub struct ChannelEnv<'a> {
    pub allocator: &'a mut AllocEncoder,
    pub unroll_puzzle: Puzzle,

    pub referee_coin_puzzle: Puzzle,
    pub referee_coin_puzzle_hash: PuzzleHash,

    pub standard_puzzle: Puzzle,

    pub agg_sig_me_additional_data: Hash,
}

impl<'a> ChannelEnv<'a> {
    pub fn new(allocator: &'a mut AllocEncoder) -> Result<ChannelEnv<'a>, Error> {
        let referee_coin_puzzle = read_hex_puzzle(allocator, "clsp/referee/onchain/referee.hex")?;
        let unroll_puzzle = read_hex_puzzle(
            allocator,
            "clsp/unroll/unroll_puzzle_state_channel_unrolling.hex",
        )?;
        let standard_puzzle = get_standard_coin_puzzle(allocator)?;
        let referee_coin_puzzle_hash = referee_coin_puzzle.sha256tree(allocator);
        Ok(ChannelEnv {
            allocator,
            referee_coin_puzzle,
            referee_coin_puzzle_hash,
            unroll_puzzle,
            standard_puzzle,
            agg_sig_me_additional_data: Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
        })
    }
}
