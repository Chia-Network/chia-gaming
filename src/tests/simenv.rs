use std::borrow::Borrow;
use std::rc::Rc;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use clvm_traits::ToClvm;
use clvmr::{run_program, NodePtr};

use log::debug;

use crate::channel_handler::game::Game;
use crate::channel_handler::runner::{channel_handler_env, ChannelHandlerGame};
use crate::channel_handler::types::{
    ChannelHandlerEnv, GameStartInfo, ReadableMove, StateUpdateProgram,
};
use crate::common::standard_coin::{
    private_to_public_key, puzzle_for_synthetic_public_key, standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{
    chia_dialect, AllocEncoder, Amount, CoinCondition, CoinSpend, CoinString, Error, GameID, Hash,
    IntoErr, PrivateKey, Program, PuzzleHash, Sha256tree, Spend, Timeout,
};
use crate::shutdown::get_conditions_with_channel_handler;
use crate::simulator::Simulator;
use crate::tests::game::{new_channel_handler_game, GameAction, GameActionResult};
use crate::tests::referee::{make_debug_game_handler, RefereeTest};

#[derive(Debug, Clone)]
pub enum OnChainState {
    OffChain(CoinString),
    OnChain(Vec<CoinString>),
}

pub struct SimulatorEnvironment<'a, R: Rng> {
    pub env: ChannelHandlerEnv<'a, R>,
    pub on_chain: OnChainState,
    pub identities: [ChiaIdentity; 2],
    pub parties: ChannelHandlerGame,
    pub simulator: Simulator,
}

impl<'a, R: Rng> SimulatorEnvironment<'a, R> {
    pub fn new(
        allocator: &'a mut AllocEncoder,
        rng: &'a mut R,
        game: &Game,
        contributions: &[Amount; 2],
    ) -> Result<Self, Error> {
        // Generate keys and puzzle hashes.
        let my_private_key: PrivateKey = rng.gen();
        let their_private_key: PrivateKey = rng.gen();

        let identities = [
            ChiaIdentity::new(allocator, my_private_key).expect("should generate"),
            ChiaIdentity::new(allocator, their_private_key).expect("should generate"),
        ];

        let mut env = channel_handler_env(allocator, rng)?;
        let simulator = Simulator::default();
        let (parties, coin) = new_channel_handler_game(
            &simulator,
            &mut env,
            game,
            &identities,
            contributions.clone(),
        )?;

        Ok(SimulatorEnvironment {
            env,
            identities,
            parties,
            on_chain: OnChainState::OffChain(coin),
            simulator,
        })
    }

    // Create a channel coin from the users' input coins giving the new CoinString
    // and the state number.  The result is the coin string of the new coin and
    // conditions to use with the channel handler interface.
    fn spend_channel_coin(
        &mut self,
        player: usize,
        state_channel: CoinString,
        unroll_coin_puzzle_hash: &PuzzleHash,
    ) -> Result<(NodePtr, CoinString), Error> {
        let cc_spend = self.parties.get_channel_coin_spend(player)?;
        let cc_ph = cc_spend
            .channel_puzzle_reveal
            .sha256tree(self.env.allocator);
        debug!("puzzle hash to spend state channel coin: {cc_ph:?}");
        debug!("spend conditions {:?}", cc_spend.spend.conditions);

        let private_key_1 = self.parties.player(0).ch.channel_private_key();
        let private_key_2 = self.parties.player(1).ch.channel_private_key();
        let aggregate_public_key1 = self.parties.player(0).ch.get_aggregate_channel_public_key();
        let aggregate_public_key2 = self.parties.player(1).ch.get_aggregate_channel_public_key();
        assert_eq!(aggregate_public_key1, aggregate_public_key2);

        debug!("parent coin {:?}", state_channel.to_parts());
        let cc_spend_conditions_nodeptr =
            cc_spend.spend.conditions.to_nodeptr(self.env.allocator)?;
        let spend1 = standard_solution_partial(
            self.env.allocator,
            &private_key_1,
            &state_channel.to_coin_id(),
            cc_spend_conditions_nodeptr,
            &aggregate_public_key1,
            &self.env.agg_sig_me_additional_data,
            true,
        )?;
        debug!("party1 predicted sig {:?}", spend1.signature);
        let spend2 = standard_solution_partial(
            self.env.allocator,
            &private_key_2,
            &state_channel.to_coin_id(),
            cc_spend_conditions_nodeptr,
            &aggregate_public_key1,
            &self.env.agg_sig_me_additional_data,
            true,
        )?;
        debug!("party2 predicted sig {:?}", spend2.signature);
        let signature = spend1.signature.clone() + spend2.signature.clone();
        let predicted_puzzle = puzzle_for_synthetic_public_key(
            self.env.allocator,
            &self.env.standard_puzzle,
            &aggregate_public_key1,
        )?;

        assert_eq!(cc_ph, predicted_puzzle.sha256tree(self.env.allocator));
        assert_eq!(signature, cc_spend.spend.aggsig);

        let spend_of_channel_coin = CoinSpend {
            coin: state_channel.clone(),
            bundle: Spend {
                puzzle: cc_spend.channel_puzzle_reveal.clone(),
                solution: cc_spend.spend.solution.into(),
                signature,
            },
        };

        let included = self
            .simulator
            .push_tx(self.env.allocator, &[spend_of_channel_coin])
            .into_gen()?;
        if included.code != 1 {
            return Err(Error::StrErr(format!(
                "failed to spend channel coin {included:?}"
            )));
        }

        self.simulator.farm_block(&self.identities[0].puzzle_hash);

        Ok((
            cc_spend.spend.conditions.to_nodeptr(self.env.allocator)?,
            CoinString::from_parts(
                &state_channel.to_coin_id(),
                unroll_coin_puzzle_hash,
                &cc_spend.amount,
            ),
        ))
    }

    fn do_off_chain_move(
        &mut self,
        player: usize,
        readable: NodePtr,
        received: bool,
    ) -> Result<GameActionResult, Error> {
        let game_id = self.parties.game_id.clone();
        let entropy: Hash = self.env.rng.gen();
        let readable_move = ReadableMove::from_nodeptr(self.env.allocator, readable)?;
        let move_result = self.parties.player(player).ch.send_potato_move(
            &mut self.env,
            &game_id,
            &readable_move,
            entropy.clone(),
        )?;

        // XXX allow verification of ui result and message.
        if received {
            let (spend, ui_result, message, _mover_share) = self
                .parties
                .player(player ^ 1)
                .ch
                .received_potato_move(&mut self.env, &game_id, &move_result)?;
            self.parties
                .update_channel_coin_after_receive(player ^ 1, &spend)?;
            let decoded_message = if message.is_empty() {
                None
            } else {
                self.parties
                    .player(player)
                    .ch
                    .received_message(&mut self.env, &game_id, &message)?
                    .into()
            };
            Ok(GameActionResult::MoveResult(
                ui_result.to_nodeptr(self.env.allocator)?,
                message,
                decoded_message,
                entropy,
            ))
        } else {
            Ok(GameActionResult::BrokenMove)
        }
    }

    fn do_unroll_spend_to_games(
        &mut self,
        player: usize,
        unroll_coin: CoinString,
    ) -> Result<Vec<CoinString>, Error> {
        let player_ch = &mut self.parties.player(player).ch;
        let finished_unroll_coin = player_ch.get_finished_unroll_coin();
        let pre_unroll_data = player_ch.get_create_unroll_coin_transaction(
            &mut self.env,
            finished_unroll_coin,
            true,
        )?;

        let run_puzzle = pre_unroll_data
            .transaction
            .puzzle
            .to_clvm(self.env.allocator)
            .into_gen()?;
        let run_args = pre_unroll_data
            .transaction
            .solution
            .to_clvm(self.env.allocator)
            .into_gen()?;

        let puzzle_result = run_program(
            self.env.allocator.allocator(),
            &chia_dialect(),
            run_puzzle,
            run_args,
            0,
        )
        .into_gen()?;

        self.simulator.farm_block(&self.identities[0].puzzle_hash);

        debug!(
            "private key 1: {:?}",
            self.parties.player(0).ch.unroll_private_key()
        );
        debug!(
            "private key 2: {:?}",
            self.parties.player(1).ch.unroll_private_key()
        );
        debug!("doing transaction");
        let included = self
            .simulator
            .push_tx(
                self.env.allocator,
                &[CoinSpend {
                    bundle: pre_unroll_data.transaction.clone(),
                    coin: unroll_coin.clone(),
                }],
            )
            .into_gen()?;
        if included.code != 1 {
            return Err(Error::StrErr(format!(
                "could not spend unroll coin for move: {included:?}"
            )));
        }

        let condition_list = CoinCondition::from_nodeptr(self.env.allocator, puzzle_result.1);

        Ok(condition_list
            .iter()
            .filter_map(|cond| {
                if let CoinCondition::CreateCoin(ph, amt) = cond {
                    return Some(CoinString::from_parts(&unroll_coin.to_coin_id(), ph, amt));
                }

                None
            })
            .collect())
    }

    fn do_on_chain_move(
        &mut self,
        player: usize,
        readable: NodePtr,
        _game_coins: &[CoinString],
    ) -> Result<GameActionResult, Error> {
        let game_id = self.parties.game_id.clone();
        let player_ch = &mut self.parties.player(player).ch;
        let entropy = self.env.rng.gen();
        let readable_move = ReadableMove::from_nodeptr(self.env.allocator, readable)?;
        let _move_result =
            player_ch.send_potato_move(&mut self.env, &game_id, &readable_move, entropy)?;
        let finished_unroll_coin = player_ch.get_finished_unroll_coin();
        let post_unroll_data = player_ch.get_create_unroll_coin_transaction(
            &mut self.env,
            finished_unroll_coin,
            true,
        )?;
        debug!("post_unroll_data {post_unroll_data:?}");
        todo!();
    }

    pub fn perform_action(&mut self, action: &GameAction) -> Result<GameActionResult, Error> {
        debug!("play move {action:?}");
        match action {
            GameAction::Move(player, readable, received) => {
                match &self.on_chain {
                    OnChainState::OffChain(_coins) => {
                        self.do_off_chain_move(*player, *readable, *received)
                    }
                    OnChainState::OnChain(games) => {
                        // Multiple borrow.
                        self.do_on_chain_move(*player, *readable, &games.clone())
                    }
                }
            }
            GameAction::GoOnChain(player) => {
                let use_unroll = self
                    .parties
                    .player(*player)
                    .ch
                    .get_finished_unroll_coin()
                    .clone();
                let unroll_target = self
                    .parties
                    .player(*player)
                    .ch
                    .get_unroll_target(&mut self.env, &use_unroll)?;
                debug!(
                    "GO ON CHAIN: {} {:?} {:?}",
                    unroll_target.state_number, unroll_target.my_amount, unroll_target.their_amount
                );
                let state_channel_coin = match self.on_chain.clone() {
                    OnChainState::OffChain(coin) => coin.clone(),
                    _ => {
                        return Err(Error::StrErr("go on chain when on chain".to_string()));
                    }
                };

                let aggregate_public_key =
                    private_to_public_key(&self.parties.player(0).ch.channel_private_key())
                        + private_to_public_key(&self.parties.player(1).ch.channel_private_key());
                debug!("going on chain: aggregate public key is: {aggregate_public_key:?}",);

                let (channel_coin_conditions, unroll_coin) = self.spend_channel_coin(
                    *player,
                    state_channel_coin,
                    &unroll_target.unroll_puzzle_hash,
                )?;
                debug!("unroll_coin {unroll_coin:?}");

                let _channel_spent_result_1 = self.parties.player(*player).ch.channel_coin_spent(
                    &mut self.env,
                    true,
                    channel_coin_conditions,
                )?;
                let _channel_spent_result_2 = self
                    .parties
                    .player(*player ^ 1)
                    .ch
                    .channel_coin_spent(&mut self.env, false, channel_coin_conditions)?;

                let game_coins = self.do_unroll_spend_to_games(*player, unroll_coin)?;

                self.on_chain = OnChainState::OnChain(game_coins);
                Ok(GameActionResult::MoveToOnChain)
            }
            GameAction::Accept(player) => {
                let game_id = self.parties.game_id.clone();
                let (signatures, _amount) = self
                    .parties
                    .player(*player)
                    .ch
                    .send_potato_accept(&mut self.env, &game_id)?;

                let spend = self.parties.player(*player ^ 1).ch.received_potato_accept(
                    &mut self.env,
                    &signatures,
                    &game_id,
                )?;

                self.parties
                    .update_channel_coin_after_receive(*player ^ 1, &spend)?;

                Ok(GameActionResult::Accepted)
            }
            GameAction::Shutdown(player, target_conditions) => {
                let real_target_conditions = get_conditions_with_channel_handler(
                    &mut self.env,
                    &self.parties.player(*player).ch,
                    target_conditions.borrow(),
                )?;
                let spend = self
                    .parties
                    .player(*player)
                    .ch
                    .send_potato_clean_shutdown(&mut self.env, real_target_conditions)?;

                let full_spend = self
                    .parties
                    .player(*player ^ 1)
                    .ch
                    .received_potato_clean_shutdown(
                        &mut self.env,
                        &spend.signature,
                        real_target_conditions,
                    )?;

                // The shutdown gives a spend, which we need to do here.
                let channel_coin = self
                    .parties
                    .player(*player)
                    .ch
                    .state_channel_coin()
                    .coin_string()
                    .clone();

                debug!("solution in full spend: {:?}", full_spend.solution);

                let channel_puzzle_public_key = self
                    .parties
                    .player(*player)
                    .ch
                    .get_aggregate_channel_public_key();
                let puzzle = puzzle_for_synthetic_public_key(
                    self.env.allocator,
                    &self.env.standard_puzzle,
                    &channel_puzzle_public_key,
                )?;
                let included = self
                    .simulator
                    .push_tx(
                        self.env.allocator,
                        &[CoinSpend {
                            coin: channel_coin,
                            bundle: Spend {
                                solution: full_spend.solution.clone(),
                                puzzle,
                                signature: full_spend.signature.clone(),
                            },
                        }],
                    )
                    .unwrap();

                debug!("included {included:?}");
                assert_eq!(included.code, 1);

                Ok(GameActionResult::Shutdown)
            }
            _ => {
                todo!();
            }
        }
    }

    pub fn play_game(&mut self, actions: &[GameAction]) -> Result<Vec<GameActionResult>, Error> {
        let mut results = Vec::new();
        for a in actions.iter() {
            results.push(self.perform_action(a)?);
        }

        Ok(results)
    }
}

#[test]
fn test_sim() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();
    let s = Simulator::default();
    let private_key: PrivateKey = rng.gen();
    let identity = ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");
    debug!("identity public key {:?}", identity.public_key);
    s.farm_block(&identity.puzzle_hash);

    let coins = s.get_my_coins(&identity.puzzle_hash).expect("got coins");
    debug!("coin 0 {:?}", coins[0].to_parts());
    debug!("coin 0 id {:?}", coins[0].to_coin_id());

    let (_, _, amt) = coins[0].to_parts().unwrap();
    s.spend_coin_to_puzzle_hash(
        &mut allocator,
        &identity,
        &identity.puzzle,
        &coins[0],
        &[(identity.puzzle_hash.clone(), amt.clone())],
    )
    .expect("should spend");
}

#[test]
fn test_simulator_transfer_coin() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();
    let s = Simulator::default();
    let private_key: PrivateKey = rng.gen();
    let identity1 = ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");
    let pk2: PrivateKey = rng.gen();
    let identity2 = ChiaIdentity::new(&mut allocator, pk2.clone()).expect("should create");

    s.farm_block(&identity1.puzzle_hash);

    let coins1 = s.get_my_coins(&identity1.puzzle_hash).expect("got coins");
    let coins2_empty = s
        .get_my_coins(&identity2.puzzle_hash)
        .expect("got coin list");

    assert!(coins2_empty.is_empty());
    s.transfer_coin_amount(
        &mut allocator,
        &identity2,
        &identity1,
        &coins1[0],
        Amount::new(100),
    )
    .expect("should transfer");

    s.farm_block(&identity1.puzzle_hash);
    let coins2 = s.get_my_coins(&identity2.puzzle_hash).expect("got coins");
    assert_eq!(coins2.len(), 1);
}

#[test]
fn test_simulator_combine_coins() {
    let seed: [u8; 32] = [0; 32];
    let mut rng = ChaCha8Rng::from_seed(seed);
    let mut allocator = AllocEncoder::new();
    let s = Simulator::default();
    let private_key: PrivateKey = rng.gen();
    let identity = ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");

    s.farm_block(&identity.puzzle_hash);

    let coins = s.get_my_coins(&identity.puzzle_hash).expect("got coins");

    s.combine_coins(&mut allocator, &identity, &identity.puzzle_hash, &coins)
        .expect("should transfer");

    let pk2: PrivateKey = rng.gen();
    let identity2 = ChiaIdentity::new(&mut allocator, pk2.clone()).expect("should create");
    s.farm_block(&identity2.puzzle_hash);
    let one_coin = s.get_my_coins(&identity.puzzle_hash).expect("got coins");

    let (_, _, a1) = coins[0].to_parts().expect("should parse");
    let (_, _, a2) = coins[1].to_parts().expect("should parse");
    let (_, _, amt) = one_coin[0].to_parts().expect("should parse");

    assert_eq!(one_coin.len(), coins.len() - 1);
    assert_eq!(a1 + a2, amt);
}
