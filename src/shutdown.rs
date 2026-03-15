use clvm_traits::ToClvm;
use clvmr::NodePtr;
use rand::Rng;

use crate::channel_handler::types::ChannelHandlerEnv;
use crate::channel_handler::ChannelHandler;
use crate::common::constants::CREATE_COIN;
use crate::common::types::{AllocEncoder, Amount, Error, IntoErr, Node, PuzzleHash};

fn compute_shutdown_conditions(
    allocator: &mut AllocEncoder,
    our_reward_ph: &PuzzleHash,
    our_share: &Amount,
    their_reward_ph: &PuzzleHash,
    their_share: &Amount,
) -> Result<NodePtr, Error> {
    let mut v = Vec::new();
    if *our_share != Amount::default() {
        v.push(Node(
            (CREATE_COIN, (our_reward_ph, (our_share, ())))
                .to_clvm(allocator)
                .into_gen()?,
        ));
    }
    if *their_share != Amount::default() {
        v.push(Node(
            (CREATE_COIN, (their_reward_ph, (their_share, ())))
                .to_clvm(allocator)
                .into_gen()?,
        ));
    }

    v.to_clvm(allocator).into_gen()
}

/// Given a channel handler and env, compute the CREATE_COIN conditions for clean shutdown.
pub fn get_conditions_with_channel_handler<R: Rng>(
    env: &mut ChannelHandlerEnv<R>,
    ch: &ChannelHandler,
) -> Result<NodePtr, Error> {
    let our_reward_ph = ch.get_reward_puzzle_hash(env)?;
    let our_share = ch.get_our_current_share();
    let their_reward_ph = ch.get_opponent_reward_puzzle_hash();
    let their_share = ch.get_their_current_share();
    compute_shutdown_conditions(
        env.allocator,
        &our_reward_ph,
        &our_share,
        &their_reward_ph,
        &their_share,
    )
}
