use rand::Rng;
use std::rc::Rc;

use crate::channel_handler::{
    ChannelHandler, ChannelHandlerEnv, ChannelHandlerInitiationResult, ChannelHandlerPrivateKeys,
};

use crate::common::types::{Amount, CoinID, Error, PublicKey, Puzzle, PuzzleHash, Timeout};

pub struct ChannelHandlerParty {
    pub ch: ChannelHandler,
    pub init_data: ChannelHandlerInitiationResult,
    pub referee: Rc<Puzzle>,
    pub ref_puzzle_hash: PuzzleHash,
    pub contribution: Amount,
}

impl ChannelHandlerParty {
    pub fn new<R: Rng>(
        env: &mut ChannelHandlerEnv<R>,
        private_keys: ChannelHandlerPrivateKeys,
        referee: Rc<Puzzle>,
        ref_puzzle_hash: PuzzleHash,
        launcher_coin_id: CoinID,
        we_start_with_potato: bool,
        their_channel_pubkey: PublicKey,
        their_unroll_pubkey: PublicKey,
        their_referee_puzzle_hash: PuzzleHash,
        their_reward_puzzle_hash: PuzzleHash,
        my_contribution: Amount,
        their_contribution: Amount,
        unroll_advance_timeout: Timeout,
        reward_puzzle_hash: PuzzleHash,
    ) -> Result<ChannelHandlerParty, Error> {
        let (ch, init_data) = ChannelHandler::new(
            env,
            private_keys,
            launcher_coin_id,
            we_start_with_potato,
            their_channel_pubkey,
            their_unroll_pubkey,
            their_referee_puzzle_hash,
            their_reward_puzzle_hash,
            my_contribution.clone(),
            their_contribution,
            unroll_advance_timeout,
            reward_puzzle_hash,
        )?;
        Ok(ChannelHandlerParty {
            ch,
            init_data,
            contribution: my_contribution,
            referee,
            ref_puzzle_hash,
        })
    }
}
