use std::rc::Rc;

use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;

use serde::{Deserialize, Serialize};

use crate::channel_handler::types::ChannelHandlerEnv;
use crate::common::constants::{ASSERT_HEIGHT_RELATIVE, CREATE_COIN, REM};
use crate::common::standard_coin::{private_to_public_key, unsafe_sign_partial};
use crate::common::types::{
    Aggsig, Amount, Error, IntoErr, Node, PrivateKey, Program, ProgramRef, PublicKey, PuzzleHash,
    Sha256tree,
};

/// Represents the unroll coin which will come to exist if the channel coin
/// is spent.  This isolates how the unroll coin functions.
///
/// Unroll takes these curried parameters:
///
/// - SHARED_PUBKEY (aggregate 2-of-2 unroll public key)
/// - OLD_SEQUENCE_NUMBER
/// - DEFAULT_CONDITIONS_HASH
///
/// The solution is just conditions (as the dotted-pair cdr of the args).
/// Dispatch is via shatree(conditions) == DEFAULT_CONDITIONS_HASH:
///   - Match: timeout path, returns conditions as-is
///   - No match: preemption path; the first condition must be
///     (REM sequence_number). Checks sequence number > old with opposite
///     parity, then prepends AGG_SIG_UNSAFE SHARED_PUBKEY conditions_hash
///
/// At the end of the day update and verify should produce the same conditions for
/// a specific generation and verify the same message.
///
/// UnrollCoin is responsible for enforcing that a time lock (ASSERT_RELATIVE ...) etc
/// so that the other player has an opportunity to challenge the unroll.
///
#[derive(Default, Clone, Serialize, Deserialize)]
pub struct UnrollCoin {
    pub started_with_potato: bool,
    // Potato number. Equals the latest state_number after send or receive.
    pub state_number: usize,

    pub outcome: Option<UnrollCoinOutcome>,
}

fn prepend_state_number_rem_to_conditions(
    env: &mut ChannelHandlerEnv<'_>,
    state_number: usize,
    conditions: NodePtr,
) -> Result<NodePtr, Error> {
    // Add rem condition for the state number
    let rem_condition = (REM, (state_number, ()));
    (rem_condition, Node(conditions))
        .to_clvm(env.allocator)
        .into_gen()
}

pub fn prepend_rem_conditions(
    env: &mut ChannelHandlerEnv<'_>,
    state_number: usize,
    conditions: NodePtr,
) -> Result<NodePtr, Error> {
    prepend_state_number_rem_to_conditions(env, state_number, conditions)
}

impl UnrollCoin {
    pub fn get_internal_conditions_for_unroll_coin_spend(&self) -> Result<ProgramRef, Error> {
        if let Some(r) = self.outcome.as_ref() {
            Ok(r.conditions_without_hash.clone())
        } else {
            Err(Error::StrErr("no default setup".to_string()))
        }
    }

    fn get_old_state_number(&self) -> Result<usize, Error> {
        if let Some(r) = self.outcome.as_ref() {
            Ok(r.state_number)
        } else {
            Err(Error::StrErr("no default setup".to_string()))
        }
    }

    pub fn get_conditions_for_unroll_coin_spend(&self) -> Result<ProgramRef, Error> {
        if let Some(r) = self.outcome.as_ref() {
            Ok(r.conditions.clone())
        } else {
            Err(Error::StrErr("no default setup".to_string()))
        }
    }

    pub fn get_conditions_hash_for_unroll_puzzle(&self) -> Result<PuzzleHash, Error> {
        if let Some(r) = self.outcome.as_ref() {
            Ok(r.hash.clone())
        } else {
            Err(Error::StrErr("no default setup".to_string()))
        }
    }

    pub fn get_unroll_coin_signature(&self) -> Result<Aggsig, Error> {
        if let Some(r) = self.outcome.as_ref() {
            Ok(r.signature.clone())
        } else {
            Err(Error::StrErr("no default setup".to_string()))
        }
    }

    /// Curry the unroll puzzle with (aggregate_public_key, old_state_number,
    /// conditions_hash).  The aggregate key is curried directly — no
    /// metapuzzle indirection.
    pub fn make_curried_unroll_puzzle(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
        aggregate_public_key: &PublicKey,
    ) -> Result<NodePtr, Error> {
        let conditions_hash = self.get_conditions_hash_for_unroll_puzzle()?;

        CurriedProgram {
            program: env.unroll_puzzle.clone(),
            args: clvm_curried_args!(
                aggregate_public_key.clone(),
                self.get_old_state_number()?,
                conditions_hash
            ),
        }
        .to_clvm(env.allocator)
        .into_gen()
    }

    /// Build the solution for the preemption path: just the base conditions
    /// (without the timelock).  The puzzle prepends AGG_SIG_UNSAFE inline.
    pub fn make_unroll_puzzle_solution(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<NodePtr, Error> {
        let conditions = self.get_internal_conditions_for_unroll_coin_spend()?;
        conditions.to_nodeptr(env.allocator)
    }

    /// Build the solution for the timeout path: just the timeout conditions
    /// (which include ASSERT_HEIGHT_RELATIVE).  The puzzle checks
    /// shatree(conditions) == DEFAULT_CONDITIONS_HASH.
    pub fn make_timeout_unroll_solution(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<NodePtr, Error> {
        let timeout_conditions = self.get_conditions_for_unroll_coin_spend()?;
        timeout_conditions.to_nodeptr(env.allocator)
    }

    /// Returns a list of create coin conditions which the unroll coin should do.
    /// We don't care about the parent coin id since we're not constraining it.
    ///
    /// The order is important and the first two coins' order are determined by
    /// whether the potato was ours first.
    /// Needs rem of sequence number and the default conditions hash.
    fn compute_unroll_coin_conditions(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
        inputs: &UnrollCoinConditionInputs,
    ) -> Result<ProgramRef, Error> {
        let their_first_coin = (
            CREATE_COIN,
            (
                inputs.their_reward_puzzle_hash.clone(),
                (inputs.their_balance.clone(), ()),
            ),
        );

        let our_first_coin = (
            CREATE_COIN,
            (
                inputs.my_reward_puzzle_hash.clone(),
                (inputs.my_balance.clone(), ()),
            ),
        );

        let (start_coin_one, start_coin_two) = if self.started_with_potato {
            (our_first_coin, their_first_coin)
        } else {
            (their_first_coin, our_first_coin)
        };

        let start_coin_one_clvm = start_coin_one.to_clvm(env.allocator).into_gen()?;
        let start_coin_two_clvm = start_coin_two.to_clvm(env.allocator).into_gen()?;
        let mut result_coins: Vec<Node> =
            vec![Node(start_coin_one_clvm), Node(start_coin_two_clvm)];

        // Signatures for the unroll puzzle are always unsafe.
        // Signatures for the channel puzzle are always safe (std format).
        for (ph, a) in inputs.puzzle_hashes_and_amounts.iter() {
            let clvm_conditions = (CREATE_COIN, (ph.clone(), (a.clone(), ())))
                .to_clvm(env.allocator)
                .into_gen()?;
            result_coins.push(Node(clvm_conditions));
        }

        let result_coins_node = result_coins.to_clvm(env.allocator).into_gen()?;
        let result_node = prepend_rem_conditions(env, self.state_number, result_coins_node)?;
        Ok(ProgramRef::new(Rc::new(Program::from_nodeptr(
            env.allocator,
            result_node,
        )?)))
    }

    /// Given new inputs, recompute the state of the unroll coin and store the
    /// conditions and signature necessary for the channel coin to create it.
    pub fn update(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        unroll_private_key: &PrivateKey,
        their_unroll_coin_public_key: &PublicKey,
        inputs: &UnrollCoinConditionInputs,
    ) -> Result<Aggsig, Error> {
        let base_conditions = self.compute_unroll_coin_conditions(env, inputs)?;

        // Timeout conditions: prepend ASSERT_HEIGHT_RELATIVE to the base
        // conditions.  The preemption path uses the base conditions (no
        // timelock) so it can execute immediately.
        let timeout_conditions = if inputs.unroll_timeout > 0 {
            let timelock_cond = (ASSERT_HEIGHT_RELATIVE, (inputs.unroll_timeout, ()))
                .to_clvm(env.allocator)
                .into_gen()?;
            let timeout_node = (
                Node(timelock_cond),
                Node(base_conditions.to_nodeptr(env.allocator)?),
            )
                .to_clvm(env.allocator)
                .into_gen()?;
            ProgramRef::new(Rc::new(Program::from_nodeptr(env.allocator, timeout_node)?))
        } else {
            base_conditions.clone()
        };

        let timeout_hash = timeout_conditions.sha256tree(env.allocator);
        let base_hash = base_conditions.sha256tree(env.allocator);
        let unroll_public_key = private_to_public_key(unroll_private_key);
        let unroll_aggregate_key = unroll_public_key.clone() + their_unroll_coin_public_key.clone();
        let unroll_signature =
            unsafe_sign_partial(unroll_private_key, &unroll_aggregate_key, base_hash.bytes());

        self.outcome = Some(UnrollCoinOutcome {
            conditions: timeout_conditions,
            conditions_without_hash: base_conditions,
            state_number: self.state_number,
            hash: timeout_hash,
            signature: unroll_signature.clone(),
        });

        Ok(unroll_signature)
    }

    pub fn verify(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
        aggregate_unroll_public_key: &PublicKey,
        signature: &Aggsig,
    ) -> Result<bool, Error> {
        let unroll_puzzle_solution = self.get_internal_conditions_for_unroll_coin_spend()?;
        let unroll_puzzle_solution_hash = unroll_puzzle_solution.sha256tree(env.allocator);

        let our_half = self.get_unroll_coin_signature()?;
        let aggregate_unroll_signature = signature.clone() + our_half.clone();

        let result = aggregate_unroll_signature.verify(
            aggregate_unroll_public_key,
            unroll_puzzle_solution_hash.bytes(),
        );

        Ok(result)
    }
}

#[derive(Debug)]
pub struct UnrollCoinConditionInputs {
    pub my_reward_puzzle_hash: PuzzleHash,
    pub their_reward_puzzle_hash: PuzzleHash,
    pub my_balance: Amount,
    pub their_balance: Amount,
    pub puzzle_hashes_and_amounts: Vec<(PuzzleHash, Amount)>,
    pub unroll_timeout: u64,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct UnrollCoinOutcome {
    pub conditions: ProgramRef,
    pub conditions_without_hash: ProgramRef,
    pub state_number: usize,
    pub hash: PuzzleHash,
    pub signature: Aggsig,
}

pub struct UnrollTarget {
    pub state_number: usize,
    pub unroll_puzzle_hash: PuzzleHash,
    pub my_amount: Amount,
    pub their_amount: Amount,
}
