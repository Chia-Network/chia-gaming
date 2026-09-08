use clvm_traits::ToClvm;
use clvmr::NodePtr;

use crate::channel_state::types::ChannelEnv;
use crate::channel_state::ChannelState;
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::puzzle_for_synthetic_public_key;
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinSpend, Error, IntoErr, Node, PuzzleHash, Spend,
};

fn compute_shutdown_conditions(
    allocator: &mut AllocEncoder,
    our_reward_ph: &PuzzleHash,
    our_share: &Amount,
    their_reward_ph: &PuzzleHash,
    their_share: &Amount,
) -> Result<NodePtr, Error> {
    let mut payouts = Vec::new();
    if *our_share != Amount::default() {
        payouts.push((our_reward_ph, our_share));
    }
    if *their_share != Amount::default() {
        payouts.push((their_reward_ph, their_share));
    }
    payouts.sort_by(|(left_hash, left_amount), (right_hash, right_amount)| {
        left_hash
            .bytes()
            .cmp(right_hash.bytes())
            .then_with(|| left_amount.cmp(right_amount))
    });

    let conditions = payouts
        .into_iter()
        .map(|(puzzle_hash, amount)| {
            (CREATE_COIN, (puzzle_hash, (amount, ())))
                .to_clvm(allocator)
                .map(Node)
                .into_gen()
        })
        .collect::<Result<Vec<_>, _>>()?;

    conditions.to_clvm(allocator).into_gen()
}

/// Given a channel handler and env, compute the CREATE_COIN conditions for clean shutdown.
pub fn get_conditions_with_channel_state(
    env: &mut ChannelEnv<'_>,
    ch: &ChannelState,
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

/// Build the canonical clean-shutdown spend by combining our signature half
/// with the peer's half.
pub fn complete_shutdown_spend(
    env: &mut ChannelEnv<'_>,
    ch: &ChannelState,
    peer_channel_half_sig: &Aggsig,
) -> Result<(CoinSpend, Aggsig), Error> {
    let conditions = get_conditions_with_channel_state(env, ch)?;
    let local_spend = ch.send_potato_clean_shutdown(env, conditions)?;
    let full_spend = ch.received_potato_clean_shutdown(env, peer_channel_half_sig, conditions)?;
    let puzzle = puzzle_for_synthetic_public_key(
        env.allocator,
        &env.standard_puzzle,
        &ch.get_aggregate_channel_public_key(),
    )?;

    Ok((
        CoinSpend {
            coin: ch.channel_coin().clone(),
            bundle: Spend {
                solution: full_spend.solution,
                puzzle,
                signature: full_spend.signature,
            },
        },
        local_spend.signature,
    ))
}

#[cfg(test)]
mod tests {
    use super::compute_shutdown_conditions;
    use crate::common::types::{AllocEncoder, Amount, Program, PuzzleHash};

    fn condition_bytes(
        allocator: &mut AllocEncoder,
        our_hash: PuzzleHash,
        our_amount: Amount,
        their_hash: PuzzleHash,
        their_amount: Amount,
    ) -> Vec<u8> {
        let conditions = compute_shutdown_conditions(
            allocator,
            &our_hash,
            &our_amount,
            &their_hash,
            &their_amount,
        )
        .expect("compute shutdown conditions");
        Program::from_nodeptr(allocator, conditions)
            .expect("serialize shutdown conditions")
            .bytes()
            .to_vec()
    }

    #[test]
    fn shutdown_conditions_are_canonical_across_peer_perspectives() {
        let mut allocator = AllocEncoder::new();
        let first_hash = PuzzleHash::from_bytes([0x22; 32]);
        let second_hash = PuzzleHash::from_bytes([0x11; 32]);
        let first_amount = Amount::new(3);
        let second_amount = Amount::new(7);

        let first_view = condition_bytes(
            &mut allocator,
            first_hash.clone(),
            first_amount.clone(),
            second_hash.clone(),
            second_amount.clone(),
        );
        let second_view = condition_bytes(
            &mut allocator,
            second_hash,
            second_amount,
            first_hash,
            first_amount,
        );

        assert_eq!(first_view, second_view);
    }
}
