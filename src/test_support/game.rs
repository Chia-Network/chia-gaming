use crate::common::types::Timeout;
use lazy_static::lazy_static;

lazy_static! {
    pub static ref DEFAULT_UNROLL_TIME_LOCK: Timeout = Timeout::new(5);
}

#[cfg(any(test, feature = "sim-tests"))]
use crate::channel_handler::types::ReadableMove;

// In unit tests (without the `sim-tests` feature), we only need `Timeout` and `Move`.
#[cfg(all(test, not(feature = "sim-tests")))]
#[derive(Clone)]
pub enum GameAction {
    /// Do a timeout
    #[allow(dead_code)]
    Timeout(usize),
    /// Move (player, clvm readable move, was received)
    #[allow(dead_code)]
    Move(usize, ReadableMove, bool),
}

#[cfg(all(test, not(feature = "sim-tests")))]
impl std::fmt::Debug for GameAction {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        match self {
            GameAction::Timeout(t) => write!(formatter, "Timeout({t})"),
            GameAction::Move(p, n, r) => write!(formatter, "Move({p},{n:?},{r})"),
        }
    }
}

#[cfg(feature = "sim-tests")]
mod sim_tests {
    use super::*;

    use crate::channel_handler::game::Game;
    use crate::channel_handler::runner::ChannelHandlerParty;
    use crate::channel_handler::types::{
        ChannelCoinSpendInfo, ChannelHandlerEnv, ChannelHandlerPrivateKeys,
        GameStartInfoInterface, HandshakeResult, StartGameResult,
    };
    use crate::common::standard_coin::{
        private_to_public_key, puzzle_for_pk, puzzle_hash_for_synthetic_public_key, ChiaIdentity,
    };
    use crate::common::types::{
        Amount, CoinID, CoinString, Error, GameID, Hash, IntoErr, Puzzle, PuzzleHash, Sha256tree,
    };
    use crate::shutdown::ShutdownConditions;
    use crate::simulator::Simulator;
    use log::debug;
    use rand::prelude::*;
    use std::rc::Rc;

    pub struct ChannelHandlerGame {
        pub game_id: GameID,
        pub players: [ChannelHandlerParty; 2],
        pub handshake_result: [Option<HandshakeResult>; 2],
    }

    impl ChannelHandlerGame {
        pub fn new<R: Rng>(
            env: &mut ChannelHandlerEnv<R>,
            game_id: GameID,
            launcher_coin_id: &CoinID,
            contributions: &[Amount; 2],
            unroll_advance_timeout: Timeout,
        ) -> Result<ChannelHandlerGame, Error> {
            let private_keys: [ChannelHandlerPrivateKeys; 2] = env.rng.gen();

            let make_ref_info = |env: &mut ChannelHandlerEnv<R>,
                                 id: usize|
             -> Result<(Rc<Puzzle>, PuzzleHash), Error> {
                let ref_key = private_to_public_key(&private_keys[id].my_referee_private_key);
                let referee = puzzle_for_pk(env.allocator, &ref_key)?;
                let ref_puzzle_hash = referee.sha256tree(env.allocator);
                Ok((Rc::new(referee), ref_puzzle_hash))
            };

            let ref1 = make_ref_info(env, 0)?;
            let ref2 = make_ref_info(env, 1)?;
            let referees = [ref1, ref2];

            let make_party =
                |env: &mut ChannelHandlerEnv<R>, id: usize| -> Result<ChannelHandlerParty, Error> {
                    ChannelHandlerParty::new(
                        env,
                        private_keys[id].clone(),
                        referees[id].0.clone(),
                        referees[id].1.clone(),
                        launcher_coin_id.clone(),
                        id == 1,
                        private_to_public_key(&private_keys[id ^ 1].my_channel_coin_private_key),
                        private_to_public_key(&private_keys[id ^ 1].my_unroll_coin_private_key),
                        referees[id ^ 1].1.clone(),
                        referees[id ^ 1].1.clone(),
                        contributions[id].clone(),
                        contributions[id ^ 1].clone(),
                        unroll_advance_timeout.clone(),
                        referees[id ^ 1].1.clone(),
                    )
                };

            let player1 = make_party(env, 0)?;
            let player2 = make_party(env, 1)?;

            Ok(ChannelHandlerGame {
                game_id,
                players: [player1, player2],
                handshake_result: [None, None],
            })
        }

        pub fn player(&mut self, who: usize) -> &mut ChannelHandlerParty {
            &mut self.players[who]
        }

        pub fn finish_handshake<R: Rng>(
            &mut self,
            env: &mut ChannelHandlerEnv<R>,
            who: usize,
        ) -> Result<(), Error> {
            let channel_coin_0_aggsig = self.players[who ^ 1]
                .init_data
                .my_initial_channel_half_signature_peer
                .clone();
            let handshake_result = self.players[who]
                .ch
                .finish_handshake(env, &channel_coin_0_aggsig)?;
            self.handshake_result[0] = Some(handshake_result.clone());
            self.handshake_result[1] = Some(handshake_result);
            Ok(())
        }

        pub fn update_channel_coin_after_receive(
            &mut self,
            player: usize,
            spend: &ChannelCoinSpendInfo,
        ) -> Result<(), Error> {
            if let Some(r) = &mut self.handshake_result[player] {
                debug!("UPDATE CHANNEL COIN AFTER RECEIVE");
                r.spend = spend.clone();
                return Ok(());
            }

            Err(Error::StrErr("not fully running".to_string()))
        }

        pub fn get_channel_coin_spend(&self, who: usize) -> Result<HandshakeResult, Error> {
            if let Some(r) = &self.handshake_result[who] {
                return Ok(r.clone());
            }

            Err(Error::StrErr(
                "get channel handler spend when not able to unroll".to_string(),
            ))
        }
    }

    #[derive(Clone)]
    pub enum GameAction {
        /// Do a timeout
        #[allow(dead_code)]
        Timeout(usize),
        /// Move (player, clvm readable move, was received)
        #[allow(dead_code)]
        Move(usize, ReadableMove, bool),
        /// Fake move, just calls receive on the indicated side.
        FakeMove(usize, ReadableMove, Vec<u8>),
        /// Enable cheating: the next on-chain move for this player will use
        /// fake move bytes instead of the real handler output.
        EnableCheating(usize, Vec<u8>),
        /// Go on chain
        GoOnChain(usize),
        /// Wait a number of blocks
        WaitBlocks(usize, usize),
        /// Accept
        Accept(usize),
        /// Shut down
        Shutdown(usize, Rc<dyn ShutdownConditions>),
    }

    impl std::fmt::Debug for GameAction {
        fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
            match self {
                GameAction::Timeout(t) => write!(formatter, "Timeout({t})"),
                GameAction::Move(p, n, r) => write!(formatter, "Move({p},{n:?},{r})"),
                GameAction::FakeMove(p, n, v) => write!(formatter, "FakeMove({p},{n:?},{v:?})"),
                GameAction::EnableCheating(p, v) => {
                    write!(formatter, "EnableCheating({p},{v:?})")
                }
                GameAction::GoOnChain(p) => write!(formatter, "GoOnChain({p})"),
                GameAction::Accept(p) => write!(formatter, "Accept({p})"),
                GameAction::WaitBlocks(n, p) => write!(formatter, "WaitBlocks({n},{p})"),
                GameAction::Shutdown(p, _) => write!(formatter, "Shutdown({p},..)"),
            }
        }
    }

    impl GameAction {
        pub fn lose(&self) -> GameAction {
            if let GameAction::Move(p, m, _r) = self {
                return GameAction::Move(*p, m.clone(), false);
            }

            self.clone()
        }
    }

    #[derive(Debug, Clone)]
    pub enum GameActionResult {
        MoveResult(ReadableMove, Vec<u8>, Option<ReadableMove>, Hash),
        BrokenMove,
        MoveToOnChain,
        Accepted,
        Shutdown,
    }

    pub fn new_channel_handler_game<R: Rng>(
        simulator: &Simulator,
        env: &mut ChannelHandlerEnv<R>,
        game_id: &GameID,
        alice_game: &Game,
        bob_game: &Game,
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
            &identities[0].puzzle_hash,
            &identities[1],
            &coins[1][0],
            contributions[1].clone(),
        )?;
        simulator.farm_block(&identities[0].puzzle_hash);

        // Spend coin0 to person 0 creating my_amount and change (u0).
        let (u2, _) = simulator.transfer_coin_amount(
            env.allocator,
            &identities[0].puzzle_hash,
            &identities[0],
            &coins[0][0],
            contributions[0].clone(),
        )?;
        simulator.farm_block(&identities[0].puzzle_hash);

        let mut party = ChannelHandlerGame::new(
            env,
            game_id.clone(),
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

        let our_game_start = alice_game.game_start(
            game_id,
            &contributions[0],
            &contributions[1],
            &timeout,
        );
        let their_game_start = bob_game.game_start(
            game_id,
            &contributions[1],
            &contributions[0],
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

        let our_start: Rc<dyn GameStartInfoInterface> = Rc::new(our_game_start);
        let their_start: Rc<dyn GameStartInfoInterface> = Rc::new(their_game_start);

        let StartGameResult::Success(start_potato) = party
            .player(0)
            .ch
            .send_potato_start_game(env, &[our_start])?
        else {
            return Err(Error::StrErr("game start failed in test".to_string()));
        };

        let (_, solidified_state) = party.player(1).ch.received_potato_start_game(
            env,
            &start_potato,
            &[their_start],
        )?;
        party.update_channel_coin_after_receive(1, &solidified_state)?;

        Ok((party, state_channel_coin))
    }
}

#[cfg(feature = "sim-tests")]
pub use sim_tests::{new_channel_handler_game, ChannelHandlerGame, GameAction, GameActionResult};
