#[cfg(feature = "sim-tests")]
use crate::channel_handler::types::ReadableMove;
#[cfg(feature = "sim-tests")]
use crate::common::types::Hash;
use crate::common::types::Timeout;
#[cfg(feature = "sim-tests")]
use crate::shutdown::ShutdownConditions;
#[cfg(feature = "sim-tests")]
use std::rc::Rc;

#[cfg(test)]
use clvmr::NodePtr;
use lazy_static::lazy_static;

#[cfg(feature = "sim-tests")]
use rand::prelude::*;

#[cfg(feature = "sim-tests")]
use log::debug;

lazy_static! {
    pub static ref DEFAULT_UNROLL_TIME_LOCK: Timeout = Timeout::new(5);
}

#[cfg(feature = "sim-tests")]
use crate::channel_handler::game::Game;
#[cfg(feature = "sim-tests")]
use crate::channel_handler::runner::ChannelHandlerGame;
#[cfg(feature = "sim-tests")]
use crate::channel_handler::types::ChannelHandlerEnv;
#[cfg(feature = "sim-tests")]
use crate::common::standard_coin::{
    private_to_public_key, puzzle_hash_for_synthetic_public_key, ChiaIdentity,
};
#[cfg(feature = "sim-tests")]
use crate::common::types::{Amount, CoinString, Error, IntoErr};

#[cfg(feature = "sim-tests")]
use crate::simulator::Simulator;

#[derive(Clone)]
#[cfg(test)]
pub enum GameAction {
    /// Do a timeout
    #[allow(dead_code)]
    Timeout(usize),
    /// Move (player, clvm readable move, was received)
    #[allow(dead_code)]
    Move(usize, NodePtr, bool),
    /// Fake move, just calls receive on the indicated side.
    #[cfg(feature = "sim-tests")]
    FakeMove(usize, NodePtr, Vec<u8>),
    /// Go on chain
    #[cfg(feature = "sim-tests")]
    GoOnChain(usize),
    /// Accept
    #[cfg(feature = "sim-tests")]
    Accept(usize),
    /// Shut down
    #[cfg(feature = "sim-tests")]
    Shutdown(usize, Rc<dyn ShutdownConditions>),
}

impl std::fmt::Debug for GameAction {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        match self {
            GameAction::Timeout(t) => write!(formatter, "Timeout({t})"),
            GameAction::Move(p, n, r) => write!(formatter, "Move({p},{n:?},{r})"),
            #[cfg(feature = "sim-tests")]
            GameAction::FakeMove(p, n, v) => write!(formatter, "FakeMove({p},{n:?},{v:?})"),
            #[cfg(feature = "sim-tests")]
            GameAction::GoOnChain(p) => write!(formatter, "GoOnChain({p})"),
            #[cfg(feature = "sim-tests")]
            GameAction::Accept(p) => write!(formatter, "Accept({p})"),
            #[cfg(feature = "sim-tests")]
            GameAction::Shutdown(p, _) => write!(formatter, "Shutdown({p},..)"),
        }
    }
}

impl GameAction {
    #[cfg(feature = "sim-tests")]
    pub fn lose(&self) -> GameAction {
        if let GameAction::Move(p, m, _r) = self {
            return GameAction::Move(*p, *m, false);
        }

        self.clone()
    }
}

#[derive(Debug, Clone)]
#[cfg(feature = "sim-tests")]
pub enum GameActionResult {
    MoveResult(NodePtr, Vec<u8>, Option<ReadableMove>, Hash),
    BrokenMove,
    MoveToOnChain,
    Accepted,
    Shutdown,
}

#[cfg(feature = "sim-tests")]
pub fn new_channel_handler_game<R: Rng>(
    simulator: &Simulator,
    env: &mut ChannelHandlerEnv<R>,
    game: &Game,
    identities: &[ChiaIdentity; 2],
    contributions: [Amount; 2],
) -> Result<(ChannelHandlerGame, CoinString), Error> {
    // Get at least one coin for the first identity
    simulator.farm_block(&identities[0].puzzle_hash);
    // Get at least one coin for the second identity
    simulator.farm_block(&identities[1].puzzle_hash);

    let get_sufficient_coins = |i: usize| -> Result<Vec<CoinString>, Error> {
        Ok(simulator
            .get_my_coins(&identities[i].puzzle_hash)
            .into_gen()?
            .into_iter()
            .filter(|c| {
                if let Some((_, _, amt)) = c.to_parts() {
                    return amt >= contributions[i].clone();
                }
                false
            })
            .collect())
    };
    let coins: [Vec<CoinString>; 2] = [get_sufficient_coins(0)?, get_sufficient_coins(1)?];

    // Make state channel coin.
    // Spend coin1 to person 0 creating their_amount and change (u1).
    let (u1, _) = simulator.transfer_coin_amount(
        env.allocator,
        &identities[0],
        &identities[1],
        &coins[1][0],
        contributions[1].clone(),
    )?;
    simulator.farm_block(&identities[0].puzzle_hash);

    // Spend coin0 to person 0 creating my_amount and change (u0).
    let (u2, _) = simulator.transfer_coin_amount(
        env.allocator,
        &identities[0],
        &identities[0],
        &coins[0][0],
        contributions[0].clone(),
    )?;
    simulator.farm_block(&identities[0].puzzle_hash);

    let mut party = ChannelHandlerGame::new(
        env,
        game.id.clone(),
        &u2.to_coin_id(),
        &contributions.clone(),
        (*DEFAULT_UNROLL_TIME_LOCK).clone(),
    )
    .expect("should work");

    // Combine u1 and u0 into a single person aggregate key coin.
    let aggregate_public_key = private_to_public_key(&party.player(0).ch.channel_private_key())
        + private_to_public_key(&party.player(1).ch.channel_private_key());

    let cc_ph = puzzle_hash_for_synthetic_public_key(env.allocator, &aggregate_public_key)?;
    debug!("puzzle hash for state channel coin: {cc_ph:?}");

    let state_channel_coin = simulator.combine_coins(
        env.allocator,
        &identities[0],
        &party.players[0].init_data.channel_puzzle_hash_up,
        &[u1, u2],
    )?;
    debug!(
        "actual state channel coin {:?}",
        state_channel_coin.to_parts()
    );
    simulator.farm_block(&identities[0].puzzle_hash);

    party
        .finish_handshake(env, 1)
        .expect("should finish handshake");
    party
        .finish_handshake(env, 0)
        .expect("should finish handshake");

    let timeout = Timeout::new(10);

    let (our_game_start, their_game_start) = game.symmetric_game_starts(
        &game.id,
        &contributions[0].clone(),
        &contributions[1].clone(),
        &timeout,
    );

    debug!("our_game_start {:?}", our_game_start);
    debug!("their_game_start {:?}", their_game_start);

    let sigs1 = party.player(0).ch.send_empty_potato(env)?;
    let spend1 = party.player(1).ch.received_empty_potato(env, &sigs1)?;
    party.update_channel_coin_after_receive(1, &spend1)?;

    let sigs2 = party.player(1).ch.send_empty_potato(env)?;
    let spend2 = party.player(0).ch.received_empty_potato(env, &sigs2)?;
    party.update_channel_coin_after_receive(0, &spend2)?;

    let start_potato = party
        .player(0)
        .ch
        .send_potato_start_game(env, &[our_game_start])?;

    let solidified_state =
        party
            .player(1)
            .ch
            .received_potato_start_game(env, &start_potato, &[their_game_start])?;
    party.update_channel_coin_after_receive(1, &solidified_state)?;

    Ok((party, state_channel_coin))
}
