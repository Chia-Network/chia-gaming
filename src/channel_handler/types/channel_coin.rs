use std::rc::Rc;

use clvm_traits::ToClvm;

use log::debug;

use rand::prelude::*;

use serde::{Deserialize, Serialize};

use crate::channel_handler::types::{prepend_rem_conditions, ChannelHandlerEnv, UnrollCoin};
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::standard_solution_partial;
use crate::common::types::{
    Aggsig, Amount, BrokenOutCoinSpendInfo, CoinID, CoinString, Error, GameID, IntoErr, Node,
    PrivateKey, Program, PublicKey, Sha256tree, Spend,
};

/// Describes all aspects of the channel coin spend.
/// Allows the user to get the solution, conditions, quoted condition program
/// and signature for the channel coin spend.
#[derive(Serialize, Deserialize)]
pub struct ChannelCoin {
    state_channel_coin: CoinString,
}

impl ChannelCoin {
    pub fn new(state_channel_coin: CoinString) -> Self {
        ChannelCoin { state_channel_coin }
    }

    pub fn coin_string(&self) -> &CoinString {
        &self.state_channel_coin
    }
    pub fn to_coin_id(&self) -> CoinID {
        self.state_channel_coin.to_coin_id()
    }

    pub fn get_solution_and_signature_from_conditions<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        private_key: &PrivateKey,
        aggregate_public_key: &PublicKey,
        conditions: Rc<Program>,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        debug!("STATE CONDITONS: {conditions:?}");
        let conditions_nodeptr = conditions.to_nodeptr(env.allocator)?;
        let spend = standard_solution_partial(
            env.allocator,
            private_key,
            &self.state_channel_coin.to_coin_id(),
            conditions_nodeptr,
            aggregate_public_key,
            &env.agg_sig_me_additional_data,
            true,
        )?;
        Ok(spend)
    }

    pub fn get_solution_and_signature<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<R>,
        private_key: &PrivateKey,
        aggregate_channel_public_key: &PublicKey,
        aggregate_unroll_public_key: &PublicKey,
        amount: &Amount,
        unroll_coin: &UnrollCoin,
    ) -> Result<BrokenOutCoinSpendInfo, Error> {
        debug!(
            "making solution for channel coin with unroll state {}",
            unroll_coin.state_number
        );
        let unroll_puzzle =
            unroll_coin.make_curried_unroll_puzzle(env, aggregate_unroll_public_key)?;
        let unroll_puzzle_hash = Node(unroll_puzzle).sha256tree(env.allocator);
        let create_conditions = vec![Node(
            (
                CREATE_COIN,
                (unroll_puzzle_hash.clone(), (amount.clone(), ())),
            )
                .to_clvm(env.allocator)
                .into_gen()?,
        )];
        let create_conditions_obj = create_conditions.to_clvm(env.allocator).into_gen()?;
        let create_conditions_with_rem =
            prepend_rem_conditions(env, unroll_coin.state_number, create_conditions_obj)?;
        let ccrem_program = Program::from_nodeptr(env.allocator, create_conditions_with_rem)?;
        self.get_solution_and_signature_from_conditions(
            env,
            private_key,
            aggregate_channel_public_key,
            Rc::new(ccrem_program),
        )
    }
}

#[derive(Clone, Debug)]
pub struct ChannelCoinSpentResult {
    pub transaction: Spend,
    pub timeout: bool,
    pub games_canceled: Vec<GameID>,
}

#[derive(Clone, Debug)]
pub struct ChannelCoinSpendInfo {
    pub solution: Rc<Program>,
    pub conditions: Rc<Program>,
    pub aggsig: Aggsig,
}

#[derive(Serialize, Deserialize)]
pub struct ChannelCoinInfo {
    pub coin: ChannelCoin,
    pub amount: Amount,
    // Used in unrolling.
    pub spend: Spend,
}
