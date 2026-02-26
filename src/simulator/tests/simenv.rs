use std::borrow::Borrow;

use rand::{Rng, SeedableRng};
use rand_chacha::ChaCha8Rng;

use clvm_traits::ToClvm;
use clvmr::{run_program, NodePtr};

use log::debug;

use crate::channel_handler::game::Game;

use crate::channel_handler::types::{ChannelHandlerEnv, ReadableMove};
use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
use crate::common::standard_coin::{
    private_to_public_key, puzzle_for_synthetic_public_key, sign_agg_sig_me,
    solution_for_conditions, standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{
    chia_dialect, Aggsig, AllocEncoder, Amount, CoinCondition, CoinID, CoinSpend, CoinString,
    Error, GameID, GetCoinStringParts, Hash, IntoErr, PrivateKey, Program, PuzzleHash,
    Sha256tree, Spend, ToQuotedProgram,
};
use crate::common::constants::CREATE_COIN;
use crate::shutdown::get_conditions_with_channel_handler;
use crate::simulator::Simulator;
use crate::test_support::game::{
    new_channel_handler_game, ChannelHandlerGame, GameAction, GameActionResult,
};

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
        game_id: &GameID,
        alice_game: &Game,
        bob_game: &Game,
        contributions: &[Amount; 2],
    ) -> Result<Self, Error> {
        // Generate keys and puzzle hashes.
        let my_private_key: PrivateKey = rng.gen();
        let their_private_key: PrivateKey = rng.gen();

        let identities = [
            ChiaIdentity::new(allocator, my_private_key).expect("should generate"),
            ChiaIdentity::new(allocator, their_private_key).expect("should generate"),
        ];

        let mut env = ChannelHandlerEnv::new(allocator, rng)?;
        let simulator = Simulator::new_strict();
        let (parties, coin) = new_channel_handler_game(
            &simulator,
            &mut env,
            game_id,
            alice_game,
            bob_game,
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
            .push_tx(self.env.allocator, &[spend_of_channel_coin])?;
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
            let move_result = self.parties.player(player ^ 1).ch.received_potato_move(
                &mut self.env,
                &game_id,
                &move_result,
            )?;
            self.parties
                .update_channel_coin_after_receive(player ^ 1, &move_result.spend_info)?;
            let decoded_message = if move_result.message.is_empty() {
                None
            } else {
                self.parties
                    .player(player)
                    .ch
                    .received_message(&mut self.env, &game_id, &move_result.message)?
                    .into()
            };
            Ok(GameActionResult::MoveResult(
                ReadableMove::from_program(move_result.readable_their_move),
                move_result.message,
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
            )?;
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
                let readable_node = readable.to_clvm(self.env.allocator).into_gen()?;
                match &self.on_chain {
                    OnChainState::OffChain(_coins) => {
                        self.do_off_chain_move(*player, readable_node, *received)
                    }
                    OnChainState::OnChain(games) => {
                        // Multiple borrow.
                        self.do_on_chain_move(*player, readable_node, &games.clone())
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
            GameAction::CleanShutdown(player, target_conditions) => {
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

                // The clean shutdown gives a spend, which we need to do here.
                let channel_coin = self.parties.player(*player).ch.state_channel_coin().clone();

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

pub fn test_funs() -> Vec<(&'static str, &'static dyn Fn())> {
    let mut res: Vec<(&'static str, &'static dyn Fn())> = Vec::new();
    res.push(("test_sim", &|| {
        let seed: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let private_key: PrivateKey = rng.gen();
        debug!("private_key: {private_key:?}");
        let identity = ChiaIdentity::new(&mut allocator, private_key.clone())
            .map_err(|err| {
                debug!("{err:?}");
                err
            })
            .expect("no");
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
    }));

    res.push(("test_simulator_transfer_coin", &|| {
        let seed: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let private_key: PrivateKey = rng.gen();
        let identity1 =
            ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");
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
            &identity2.puzzle_hash,
            &identity1,
            &coins1[0],
            Amount::new(100),
        )
        .expect("should transfer");

        s.farm_block(&identity1.puzzle_hash);
        let coins2 = s.get_my_coins(&identity2.puzzle_hash).expect("got coins");
        assert_eq!(coins2.len(), 1);
    }));

    res.push(("test_simulator_combine_coins", &|| {
        let seed: [u8; 32] = [0; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let private_key: PrivateKey = rng.gen();
        let identity =
            ChiaIdentity::new(&mut allocator, private_key.clone()).expect("should create");

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
    }));

    res.push(("test_simulator_farm_block_height", &|| {
        let s = Simulator::new_strict();
        assert_eq!(s.get_current_height(), 0usize);

        let ph = PuzzleHash::from_hash(Hash::from_slice(&[1u8; 32]));
        s.farm_block(&ph);
        assert_eq!(s.get_current_height(), 1usize);

        s.farm_block(&ph);
        assert_eq!(s.get_current_height(), 2usize);
    }));

    res.push(("test_simulator_farm_creates_coins", &|| {
        let mut allocator = AllocEncoder::new();
        let seed: [u8; 32] = [1; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let s = Simulator::new_strict();
        let pk: PrivateKey = rng.gen();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        let before = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        assert!(before.is_empty());

        s.farm_block(&identity.puzzle_hash);
        let after = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        assert_eq!(after.len(), 2, "farm_block should create pool + farmer reward");

        let total: u64 = after
            .iter()
            .map(|c| {
                let (_, _, amt) = c.get_coin_string_parts().unwrap();
                let v: u64 = amt.into();
                v
            })
            .sum();
        assert_eq!(total, 2_000_000_000_000, "total reward should be 2 XCH");
    }));

    res.push(("test_simulator_get_all_coins_excludes_coinbase", &|| {
        let s = Simulator::new_strict();
        let ph = PuzzleHash::from_hash(Hash::from_slice(&[2u8; 32]));
        s.farm_block(&ph);

        let all = s.get_all_coins().expect("ok");
        assert!(all.is_empty(), "get_all_coins should exclude coinbase/reward coins");

        let my = s.get_my_coins(&ph).expect("ok");
        assert_eq!(my.len(), 2, "get_my_coins should include reward coins");
    }));

    res.push(("test_simulator_push_tx_and_farm", &|| {
        let seed: [u8; 32] = [3; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let pk: PrivateKey = rng.gen();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        s.farm_block(&identity.puzzle_hash);
        let coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        let coin = &coins[0];
        let (_, _, amt) = coin.get_coin_string_parts().unwrap();

        let pk2: PrivateKey = rng.gen();
        let identity2 = ChiaIdentity::new(&mut allocator, pk2).expect("should create");

        let conditions = ((CREATE_COIN, (identity2.puzzle_hash.clone(), (amt.clone(), ()))), ())
            .to_clvm(&mut allocator)
            .into_gen()
            .unwrap();
        let solution = solution_for_conditions(&mut allocator, conditions).unwrap();
        let quoted = conditions.to_quoted_program(&mut allocator).unwrap();
        let qhash = quoted.sha256tree(&mut allocator);
        let sig = sign_agg_sig_me(
            &identity.synthetic_private_key,
            qhash.bytes(),
            &coin.to_coin_id(),
            &Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA),
        );
        let tx = CoinSpend {
            coin: coin.clone(),
            bundle: Spend {
                puzzle: identity.puzzle.clone(),
                solution: Program::from_nodeptr(&mut allocator, solution).unwrap().into(),
                signature: sig,
            },
        };

        let result = s.push_tx(&mut allocator, &[tx]).expect("ok");
        assert_eq!(result.code, 1, "should be accepted into mempool");

        // Before farming: old coin still visible, new coin not yet
        let still_there = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        assert!(still_there.iter().any(|c| c.to_coin_id() == coin.to_coin_id()),
            "coin should still exist before farming");

        s.farm_block(&identity.puzzle_hash);

        // After farming: old coin gone (spent), new coin exists
        let id1_coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        assert!(!id1_coins.iter().any(|c| c.to_coin_id() == coin.to_coin_id()),
            "spent coin should be gone after farming");

        let id2_coins = s.get_my_coins(&identity2.puzzle_hash).expect("ok");
        assert_eq!(id2_coins.len(), 1, "new coin should exist");
        let (_, _, new_amt) = id2_coins[0].get_coin_string_parts().unwrap();
        assert_eq!(new_amt, amt, "new coin should have the transferred amount");
    }));

    res.push(("test_simulator_double_spend_rejected", &|| {
        let seed: [u8; 32] = [4; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let pk: PrivateKey = rng.gen();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        s.farm_block(&identity.puzzle_hash);
        let coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        let coin = &coins[0];
        let (_, _, amt) = coin.get_coin_string_parts().unwrap();

        let spend_coin = |allocator: &mut AllocEncoder| -> CoinSpend {
            let conditions = ((CREATE_COIN, (identity.puzzle_hash.clone(), (amt.clone(), ()))), ())
                .to_clvm(allocator)
                .into_gen()
                .unwrap();
            let solution = solution_for_conditions(allocator, conditions).unwrap();
            let quoted = conditions.to_quoted_program(allocator).unwrap();
            let qhash = quoted.sha256tree(allocator);
            let sig = sign_agg_sig_me(
                &identity.synthetic_private_key,
                qhash.bytes(),
                &coin.to_coin_id(),
                &Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA),
            );
            CoinSpend {
                coin: coin.clone(),
                bundle: Spend {
                    puzzle: identity.puzzle.clone(),
                    solution: Program::from_nodeptr(allocator, solution).unwrap().into(),
                    signature: sig,
                },
            }
        };

        let tx1 = spend_coin(&mut allocator);
        let r1 = s.push_tx(&mut allocator, &[tx1]).expect("ok");
        assert_eq!(r1.code, 1, "first spend should succeed");

        s.farm_block(&identity.puzzle_hash);

        let tx2 = spend_coin(&mut allocator);
        let r2 = s.push_tx(&mut allocator, &[tx2]).expect("ok");
        assert_eq!(r2.code, 3, "second spend of same coin should be rejected");
    }));

    res.push(("test_simulator_nonexistent_coin_rejected", &|| {
        let seed: [u8; 32] = [5; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let pk: PrivateKey = rng.gen();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        let fake_coin = CoinString::from_parts(
            &CoinID::new(Hash::from_slice(&[99u8; 32])),
            &identity.puzzle_hash,
            &Amount::new(1000),
        );

        let conditions = ((CREATE_COIN, (identity.puzzle_hash.clone(), (Amount::new(1000), ()))), ())
            .to_clvm(&mut allocator)
            .into_gen()
            .unwrap();
        let solution = solution_for_conditions(&mut allocator, conditions).unwrap();
        let quoted = conditions.to_quoted_program(&mut allocator).unwrap();
        let qhash = quoted.sha256tree(&mut allocator);
        let sig = sign_agg_sig_me(
            &identity.synthetic_private_key,
            qhash.bytes(),
            &fake_coin.to_coin_id(),
            &Hash::from_slice(&AGG_SIG_ME_ADDITIONAL_DATA),
        );
        let tx = CoinSpend {
            coin: fake_coin,
            bundle: Spend {
                puzzle: identity.puzzle.clone(),
                solution: Program::from_nodeptr(&mut allocator, solution).unwrap().into(),
                signature: sig,
            },
        };

        let result = s.push_tx(&mut allocator, &[tx]).expect("ok");
        assert_eq!(result.code, 3, "spending non-existent coin should be rejected");
    }));

    res.push(("test_simulator_bad_signature_rejected", &|| {
        let seed: [u8; 32] = [6; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let pk: PrivateKey = rng.gen();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        s.farm_block(&identity.puzzle_hash);
        let coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        let coin = &coins[0];
        let (_, _, amt) = coin.get_coin_string_parts().unwrap();

        let conditions = ((CREATE_COIN, (identity.puzzle_hash.clone(), (amt.clone(), ()))), ())
            .to_clvm(&mut allocator)
            .into_gen()
            .unwrap();
        let solution = solution_for_conditions(&mut allocator, conditions).unwrap();

        let tx = CoinSpend {
            coin: coin.clone(),
            bundle: Spend {
                puzzle: identity.puzzle.clone(),
                solution: Program::from_nodeptr(&mut allocator, solution).unwrap().into(),
                signature: Aggsig::default(),
            },
        };

        let result = s.push_tx(&mut allocator, &[tx]).expect("ok");
        assert_eq!(result.code, 3, "bad signature should be rejected");
    }));

    res.push(("test_simulator_get_puzzle_and_solution", &|| {
        let seed: [u8; 32] = [7; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let pk: PrivateKey = rng.gen();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        s.farm_block(&identity.puzzle_hash);
        let coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        let coin = &coins[0];
        let coin_id = coin.to_coin_id();

        let ps_before = s.get_puzzle_and_solution(&coin_id).expect("ok");
        assert!(ps_before.is_none(), "unspent coin should have no puzzle/solution");

        let (_, _, coin_amt) = coin.get_coin_string_parts().unwrap();
        s.spend_coin_to_puzzle_hash(
            &mut allocator,
            &identity,
            &identity.puzzle,
            coin,
            &[(identity.puzzle_hash.clone(), coin_amt)],
        )
        .expect("should spend");
        s.farm_block(&identity.puzzle_hash);

        let ps_after = s.get_puzzle_and_solution(&coin_id).expect("ok");
        assert!(ps_after.is_some(), "spent coin should have puzzle/solution stored");

        let (puzzle, solution) = ps_after.unwrap();
        assert!(!puzzle.to_hex().is_empty(), "puzzle should have content");
        assert!(!solution.to_hex().is_empty(), "solution should have content");
    }));

    res.push(("test_simulator_mempool_not_applied_before_farm", &|| {
        let seed: [u8; 32] = [8; 32];
        let mut rng = ChaCha8Rng::from_seed(seed);
        let mut allocator = AllocEncoder::new();
        let s = Simulator::new_strict();
        let pk: PrivateKey = rng.gen();
        let identity = ChiaIdentity::new(&mut allocator, pk).expect("should create");

        s.farm_block(&identity.puzzle_hash);
        let coins = s.get_my_coins(&identity.puzzle_hash).expect("ok");
        let coin = &coins[0];

        let pk2: PrivateKey = rng.gen();
        let identity2 = ChiaIdentity::new(&mut allocator, pk2).expect("should create");

        s.transfer_coin_amount(
            &mut allocator,
            &identity2.puzzle_hash,
            &identity,
            coin,
            Amount::new(100),
        )
        .expect("should transfer");

        let id2_before_farm = s.get_my_coins(&identity2.puzzle_hash).expect("ok");
        assert!(id2_before_farm.is_empty(), "new coins should not exist before farm_block");

        s.farm_block(&identity.puzzle_hash);

        let id2_after_farm = s.get_my_coins(&identity2.puzzle_hash).expect("ok");
        assert_eq!(id2_after_farm.len(), 1, "new coin should exist after farm_block");
    }));

    res
}
