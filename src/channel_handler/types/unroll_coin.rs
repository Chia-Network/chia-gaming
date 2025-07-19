use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;
use clvmr::allocator::NodePtr;

use log::debug;

use rand::prelude::*;

use crate::channel_handler::types::ChannelHandlerEnv;
use crate::common::constants::{CREATE_COIN, REM};
use crate::common::standard_coin::{
    private_to_public_key, unsafe_sign_partial,
};
use crate::common::types::{
    Aggsig, Amount, Error, IntoErr, Node, PrivateKey, PublicKey, PuzzleHash, Sha256tree,
};

/// Represents the unroll coin which will come to exist if the channel coin
/// is spent.  This isolates how the unroll coin functions.
///
/// Unroll takes these curried parameters:
///
/// - SHARED_PUZZLE_HASH
/// - OLD_SEQUENCE_NUMBER
/// - DEFAULT_CONDITIONS_HASH
///
/// The fully curried unroll program takes either
/// - reveal
///
/// or
///
/// - meta_puzzle conditions since conditions are passed through metapuzzle.
///
/// At the end of the day update and verify should produce the same conditions for
/// a specific generation and verify the same message.
///
/// UnrollCoin is responsible for enforcing that a time lock (ASSERT_RELATIVE ...) etc
/// so that the other player has an opportunity to challenge the unroll.
///
/// The unrolling player will have to trigger the "reveal" part as below after a time
/// if the other player doesn't successfully challenge by providing another program that
/// produces new conditions that match the parity criteria.
///
/// XXX TODO: Add time lock
#[derive(Default, Clone)]
pub struct UnrollCoin {
    pub started_with_potato: bool,
    // State number for unroll.
    // Always equal to or 1 less than the current state number.
    // Updated when potato arrives.
    pub state_number: usize,

    pub outcome: Option<UnrollCoinOutcome>,
}

fn prepend_state_number_rem_to_conditions<R: Rng>(
    env: &mut ChannelHandlerEnv<R>,
    state_number: usize,
    conditions: NodePtr,
) -> Result<NodePtr, Error> {
    // Add rem condition for the state number
    let rem_condition = (REM, (state_number, ()));
    (rem_condition, Node(conditions))
        .to_clvm(env.allocator)
        .into_gen()
}

pub fn prepend_rem_conditions<R: Rng>(
    env: &mut ChannelHandlerEnv<R>,
    state_number: usize,
    conditions: NodePtr,
) -> Result<NodePtr, Error> {
    prepend_state_number_rem_to_conditions(env, state_number, conditions)
}

impl UnrollCoin {
    pub fn get_internal_conditions_for_unroll_coin_spend(&self) -> Result<NodePtr, Error> {
        if let Some(r) = self.outcome.as_ref() {
            Ok(r.conditions_without_hash)
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

    pub fn get_conditions_for_unroll_coin_spend(&self) -> Result<NodePtr, Error> {
        if let Some(r) = self.outcome.as_ref() {
            Ok(r.conditions)
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

    /// What a spend can bring:
    /// Either a game creation that got cancelled happens,
    /// move we did that needs to be replayed on chain.
    /// game folding that we need to replay on chain.
    pub fn make_curried_unroll_puzzle<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        aggregate_public_key: &PublicKey,
    ) -> Result<NodePtr, Error> {
        let conditions_hash = self.get_conditions_hash_for_unroll_puzzle()?;
        let shared_puzzle = CurriedProgram {
            program: env.unroll_metapuzzle.clone(),
            args: clvm_curried_args!(aggregate_public_key.clone()),
        }
        .to_clvm(env.allocator)
        .into_gen()?;
        let shared_puzzle_hash = Node(shared_puzzle).sha256tree(env.allocator);

        CurriedProgram {
            program: env.unroll_puzzle.clone(),
            args: clvm_curried_args!(
                shared_puzzle_hash,
                self.get_old_state_number()?,
                conditions_hash
            ),
        }
        .to_clvm(env.allocator)
        .into_gen()
    }

    pub fn make_unroll_puzzle_solution<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        aggregate_public_key: &PublicKey,
    ) -> Result<NodePtr, Error> {
        let unroll_inner_puzzle = CurriedProgram {
            program: env.unroll_metapuzzle.clone(),
            args: clvm_curried_args!(aggregate_public_key.clone()),
        }
        .to_clvm(env.allocator)
        .into_gen()?;

        let unroll_puzzle_solution = (
            Node(unroll_inner_puzzle),
            (Node(self.get_conditions_for_unroll_coin_spend()?), ()),
        )
            .to_clvm(env.allocator)
            .into_gen()?;
        Ok(unroll_puzzle_solution)
    }

    /// Returns a list of create coin conditions which the unroll coin should do.
    /// We don't care about the parent coin id since we're not constraining it.
    ///
    /// The order is important and the first two coins' order are determined by
    /// whether the potato was ours first.
    /// Needs rem of sequence number and the default conditions hash.
    fn compute_unroll_coin_conditions<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        inputs: &UnrollCoinConditionInputs,
    ) -> Result<NodePtr, Error> {
        let their_first_coin = (
            CREATE_COIN,
            (
                inputs.their_reward_puzzle_hash.clone(),
                (inputs.their_balance.clone(), ()),
            ),
        );

        let our_first_coin = (
            CREATE_COIN,
            (inputs.reward_puzzle_hash.clone(), (inputs.my_balance.clone(), ())),
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
        // Meta puzzle for the unroll can't be standard.
        for (ph, a) in inputs.puzzle_hashes_and_amounts.iter() {
            let clvm_conditions = (CREATE_COIN, (ph.clone(), (a.clone(), ())))
                .to_clvm(env.allocator)
                .into_gen()?;
            result_coins.push(Node(clvm_conditions));
        }

        let result_coins_node = result_coins.to_clvm(env.allocator).into_gen()?;
        prepend_rem_conditions(env, self.state_number, result_coins_node)
    }

    /// Given new inputs, recompute the state of the unroll coin and store the
    /// conditions and signature necessary for the channel coin to create it.
    pub fn update<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<R>,
        unroll_private_key: &PrivateKey,
        their_unroll_coin_public_key: &PublicKey,
        inputs: &UnrollCoinConditionInputs,
    ) -> Result<Aggsig, Error> {
        let unroll_conditions = self.compute_unroll_coin_conditions(env, inputs)?;
        let conditions_hash = Node(unroll_conditions).sha256tree(env.allocator);
        let unroll_public_key = private_to_public_key(unroll_private_key);
        let unroll_aggregate_key = unroll_public_key.clone() + their_unroll_coin_public_key.clone();
        debug!("conditions_hash {conditions_hash:?}");
        let unroll_signature = unsafe_sign_partial(
            unroll_private_key,
            &unroll_aggregate_key,
            conditions_hash.bytes(),
        );
        self.outcome = Some(UnrollCoinOutcome {
            conditions: unroll_conditions,
            conditions_without_hash: unroll_conditions,
            state_number: inputs.rem_condition_state,
            hash: conditions_hash,
            signature: unroll_signature.clone(),
        });

        debug!("AGGREGATE PUBLIC KEY {:?}", unroll_aggregate_key);
        debug!(
            "SIGNATURE {} {:?}",
            self.started_with_potato, unroll_signature
        );

        Ok(unroll_signature)
    }

    pub fn verify<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        aggregate_unroll_public_key: &PublicKey,
        signature: &Aggsig,
    ) -> Result<bool, Error> {
        // Check the signature of the unroll coin spend.
        let unroll_puzzle_solution = self.get_internal_conditions_for_unroll_coin_spend()?;
        let unroll_puzzle_solution_hash = Node(unroll_puzzle_solution).sha256tree(env.allocator);

        let aggregate_unroll_signature = signature.clone() + self.get_unroll_coin_signature()?;
        debug!("{} VERIFY: AGGREGATE UNROLL hash {unroll_puzzle_solution_hash:?} {aggregate_unroll_signature:?}", self.started_with_potato);

        Ok(aggregate_unroll_signature.verify(
            aggregate_unroll_public_key,
            unroll_puzzle_solution_hash.bytes(),
        ))
    }
}

#[derive(Debug)]
pub struct UnrollCoinConditionInputs {
    pub reward_puzzle_hash: PuzzleHash,
    pub their_reward_puzzle_hash: PuzzleHash,
    pub my_balance: Amount,
    pub their_balance: Amount,
    pub puzzle_hashes_and_amounts: Vec<(PuzzleHash, Amount)>,
    pub rem_condition_state: usize,
}

#[derive(Clone, Debug)]
pub struct UnrollCoinOutcome {
    pub conditions: NodePtr,
    pub conditions_without_hash: NodePtr,
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
