use clvm_traits::ToClvm;
use clvmr::NodePtr;
use log::debug;
use rand::Rng;

use crate::channel_handler::types::ChannelHandlerEnv;
use crate::channel_handler::ChannelHandler;
use crate::common::constants::CREATE_COIN;
use crate::common::types::{AllocEncoder, Amount, Error, IntoErr, Node, PuzzleHash};

pub trait ShutdownConditions {
    fn compute(
        &self,
        allocator: &mut AllocEncoder,
        our_reward_ph: &PuzzleHash,
        our_share: &Amount,
        their_reward_ph: &PuzzleHash,
        their_share: &Amount,
    ) -> Result<NodePtr, Error>;
}

pub struct BasicShutdownConditions;

impl ShutdownConditions for BasicShutdownConditions {
    fn compute(
        &self,
        allocator: &mut AllocEncoder,
        our_reward_ph: &PuzzleHash,
        our_share: &Amount,
        their_reward_ph: &PuzzleHash,
        their_share: &Amount
    ) -> Result<NodePtr, Error> {
        let mut v = Vec::new();
        if *our_share != Amount::default() {
            v.push(Node((
                CREATE_COIN,
                (our_reward_ph, (our_share, ())),
            )
                    .to_clvm(allocator)
                    .into_gen()?
            ));
        }
        if *their_share != Amount::default() {
            v.push(Node((
                CREATE_COIN,
                (their_reward_ph, (their_share, ())),
            )
                    .to_clvm(allocator)
                    .into_gen()?
            ));
        }

        debug!("Reward coins:");
        debug!("me   {our_share:?} {our_reward_ph:?}");
        debug!("them {their_share:?} {their_reward_ph:?}");

        // Return the full list.
        v.to_clvm(allocator).into_gen()
    }
}

/// Given a channel handler, env and conditions generator, make the conditions.
pub fn get_conditions_with_channel_handler<R: Rng>(
    env: &mut ChannelHandlerEnv<R>,
    ch: &ChannelHandler,
    conditions: &dyn ShutdownConditions
) -> Result<NodePtr, Error> {
    let our_reward_ph = ch.get_reward_puzzle_hash(env)?;
    let our_share = ch.get_our_current_share();
    let their_reward_ph = ch.get_opponent_reward_puzzle_hash();
    let their_share = ch.get_their_current_share();
    conditions.compute(
        env.allocator,
        &our_reward_ph,
        &our_share,
        &their_reward_ph,
        &their_share
    )
}
