use std::borrow::Borrow;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

use rand::Rng;

use log::debug;

use serde::{Deserialize, Serialize};
use serde_json_any_key::*;

use crate::channel_handler::types::{
    AcceptTransactionState, CoinSpentInformation, OnChainGameState, ReadableMove,
};
use crate::channel_handler::ChannelHandler;
use clvm_traits::ClvmEncoder;
use crate::common::types::{
    Amount, CoinCondition, CoinSpend, CoinString, Error, GameID, Hash, IntoErr, Program,
    SpendBundle, Timeout,
};
use crate::channel_handler::types::ChannelHandlerEnv;
use crate::potato_handler::effects::{Effect, GameNotification};
use crate::potato_handler::types::{
    GameAction, PotatoHandlerImpl, PotatoState, ShutdownActionHolder,
};
use crate::referee::types::{RefereeOnChainTransaction, SlashOutcome, TheirTurnCoinSpentResult};
use crate::shutdown::ShutdownConditions;

#[derive(Serialize, Deserialize)]
pub struct OnChainPotatoHandler {
    have_potato: PotatoState,
    channel_timeout: Timeout,
    player_ch: ChannelHandler,
    game_action_queue: VecDeque<GameAction>,
    #[serde(with = "any_key_map")]
    game_map: HashMap<CoinString, OnChainGameState>,
}

impl std::fmt::Debug for OnChainPotatoHandler {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(formatter, "OnChainPotatoHandler(..)")
    }
}

impl OnChainPotatoHandler {
    pub fn new(
        have_potato: PotatoState,
        channel_timeout: Timeout,
        player_ch: ChannelHandler,
        game_action_queue: VecDeque<GameAction>,
        game_map: HashMap<CoinString, OnChainGameState>,
    ) -> Self {
        OnChainPotatoHandler {
            have_potato,
            channel_timeout,
            player_ch,
            game_action_queue,
            game_map,
        }
    }

    pub fn enable_cheating_for_game(
        &mut self,
        game_id: &GameID,
        make_move: &[u8],
    ) -> Result<bool, Error> {
        self.player_ch
            .enable_cheating_for_game(game_id, make_move)
    }

    pub fn get_game_coin(&self, game_id: &GameID) -> Option<CoinString> {
        self.game_map
            .iter()
            .find(|(_, g)| g.game_id == *game_id)
            .map(|(coin, _)| coin.clone())
    }

    pub fn remove_game_coin_info(&mut self, coin_id: &CoinString) -> Option<(GameID, bool)> {
        self.game_map.remove(coin_id).map(|def| (def.game_id, def.our_turn))
    }

    fn no_live_games(&self) -> bool {
        self.game_map.is_empty()
            || self
                .game_map
                .values()
                .all(|g| matches!(g.accept, AcceptTransactionState::Finished))
    }
}

impl PotatoHandlerImpl for OnChainPotatoHandler {
    fn channel_handler(&self) -> &ChannelHandler {
        &self.player_ch
    }

    fn my_move_in_game(&self, game_id: &GameID) -> Option<bool> {
        self.player_ch.game_is_my_turn(game_id)
    }

    fn channel_handler_mut(&mut self) -> &mut ChannelHandler {
        &mut self.player_ch
    }

    fn into_channel_handler(self) -> ChannelHandler {
        self.player_ch
    }

    fn amount(&self) -> Amount {
        self.player_ch.amount(true)
    }

    fn get_our_current_share(&self) -> Option<Amount> {
        None
    }

    fn get_their_current_share(&self) -> Option<Amount> {
        None
    }

    fn check_game_coin_spent(
        &mut self,
        coin_id: &CoinString,
    ) -> Result<(bool, Option<Effect>), Error>
    {
        if self.game_map.contains_key(coin_id) {
            return Ok((true, Some(Effect::RequestPuzzleAndSolution(coin_id.clone()))));
        }

        Ok((false, None))
    }

    fn handle_game_coin_spent<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        coin_id: &CoinString,
        puzzle: &Program,
        solution: &Program,
    ) -> Result<Vec<Effect>, Error>
    {
        let mut effects = Vec::new();
        let mut unblock_queue = false;
        let initial_potato = self.player_ch.is_initial_potato();

        debug!("{initial_potato} handle game coin spent {coin_id:?}");

        let old_definition = if let Some(old_definition) = self.game_map.remove(coin_id) {
            self.have_potato = PotatoState::Present;
            debug!("{initial_potato} we have game coin {old_definition:?}");
            old_definition
        } else {
            debug!("{initial_potato} we don't have game coin!",);
            return Ok(effects);
        };

        if let Some(slash_amount) = old_definition.pending_slash_amount {
            debug!("{initial_potato} pending slash coin was spent - slash succeeded");
            effects.push(Effect::Notification(GameNotification::WeSlashedOpponent {
                id: old_definition.game_id.clone(),
            }));
            effects.push(Effect::GameFinished {
                id: old_definition.game_id.clone(),
                mover_share: slash_amount,
            });
            effects.extend(self.next_action(env)?);
            return Ok(effects);
        }

        let conditions =
            CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;

        let reward_spend = self
            .player_ch
            .handle_reward_spends(env, coin_id, &conditions)?;

        let result =
            self.player_ch
                .game_coin_spent(env, &old_definition.game_id, coin_id, &conditions);

        let game_already_ended = matches!(
            &result,
            Err(Error::StrErr(msg)) if msg.contains("nonexistent game id")
        );
        let their_turn_result = if let Ok(result) = result {
            result
        } else {
            debug!("failed result {result:?}");
            if !old_definition.our_turn && !game_already_ended {
                effects.push(Effect::Notification(GameNotification::OpponentMadeImpossibleSpend {
                    id: old_definition.game_id.clone(),
                }));
            }
            CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Timedout {
                my_reward_coin_string: None,
            })
        };

        if let Some(spend_bundle) = &reward_spend {
            effects.push(Effect::SpendTransaction(spend_bundle.clone()));
        }

        debug!(
            "{initial_potato} game coin spent result from channel handler {their_turn_result:?}"
        );

        if old_definition.our_turn {
            let is_expected = matches!(
                &their_turn_result,
                CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Expected(..))
                    | CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Timedout { .. })
                    | CoinSpentInformation::OurReward(..)
                    | CoinSpentInformation::OurSpend(..)
            );
            if !is_expected {
                effects.push(Effect::Notification(GameNotification::OurTurnCoinSpentUnexpectedly {
                    id: old_definition.game_id.clone(),
                }));
            }
        }

        match their_turn_result {
            CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Expected(
                state_number,
                ph,
                amt,
                redo,
            )) => {
                debug!("{initial_potato} got an expected spend {ph:?} {amt:?}");
                let new_coin_id = CoinString::from_parts(&coin_id.to_coin_id(), &ph, &amt);

                debug!("{initial_potato} changing game map");
                let game_id = old_definition.game_id.clone();
                self.game_map.insert(
                    new_coin_id.clone(),
                    OnChainGameState {
                        puzzle_hash: ph.clone(),
                        our_turn: true,
                        ..old_definition
                    },
                );

                effects.push(Effect::RegisterCoin {
                    coin: new_coin_id.clone(),
                    timeout: self.channel_timeout.clone(),
                    name: Some("coin gives their turn"),
                });

                if let Some(redo_data) = &redo {
                    // The Expected path in the referee may return self.clone()
                    // without advancing TheirTurn→MyTurn, so game_is_my_turn()
                    // can be stale. Instead, check whether the new on-chain
                    // coin matches the state our cached move was made from.
                    let is_my_turn = ph == redo_data.match_puzzle_hash;
                    if is_my_turn {
                        debug!(
                            "{} redo back at potato handler",
                            self.player_ch.is_initial_potato()
                        );
                        let (_old_ph, new_ph, _state_number, _move_result, transaction) = {
                            self.player_ch.on_chain_our_move(
                                env,
                                &redo_data.game_id,
                                &redo_data.move_data,
                                redo_data.move_entropy.clone(),
                                &new_coin_id,
                            )?
                        };

                        let post_redo_coin = CoinString::from_parts(
                            &new_coin_id.to_coin_id(),
                            &new_ph,
                            &amt,
                        );
                        debug!(
                            "{initial_potato} redo created post-redo coin {post_redo_coin:?}"
                        );

                        effects.push(Effect::SpendTransaction(SpendBundle {
                            name: Some("redo move from data".to_string()),
                            spends: vec![CoinSpend {
                                coin: new_coin_id.clone(),
                                bundle: transaction.bundle.clone(),
                            }],
                        }));

                        // Update game_map: remove the pre-redo entry, insert the
                        // post-redo coin with our_turn=false (it's now their turn
                        // after our redo).
                        if let Some(mut game_def) = self.game_map.remove(&new_coin_id) {
                            game_def.puzzle_hash = new_ph;
                            game_def.our_turn = false;
                            self.game_map.insert(post_redo_coin.clone(), game_def);
                        }

                        effects.push(Effect::RegisterCoin {
                            coin: post_redo_coin,
                            timeout: self.channel_timeout.clone(),
                            name: Some("post redo game coin"),
                        });
                    }

                    debug!("{initial_potato} expected spend {ph:?}");
                    effects.push(Effect::ResyncMove {
                        id: game_id,
                        state_number,
                        is_my_turn,
                    });
                } else {
                    // No redo: the opponent's move is complete. Emit ResyncMove
                    // so the test/UI knows it's our turn. Use unblock_queue to
                    // drain any pending on-chain actions.
                    let is_my_turn = matches!(
                        self.player_ch.game_is_my_turn(&game_id),
                        Some(true)
                    );
                    debug!("{initial_potato} expected spend (no redo) {ph:?} is_my_turn={is_my_turn}");
                    effects.push(Effect::ResyncMove {
                        id: game_id,
                        state_number,
                        is_my_turn,
                    });
                    unblock_queue = true;
                }
            }
            CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Timedout {
                my_reward_coin_string,
                ..
            }) => {
                debug!("{initial_potato} timed out {my_reward_coin_string:?}");
                let amount = my_reward_coin_string
                    .as_ref()
                    .and_then(|c| c.to_parts())
                    .map(|(_, _, amt)| amt.clone())
                    .unwrap_or_default();
                if !game_already_ended {
                    if old_definition.our_turn {
                        if old_definition.accepted {
                            effects.push(Effect::Notification(GameNotification::AcceptFinished {
                                id: old_definition.game_id.clone(),
                                amount: amount.clone(),
                            }));
                        } else {
                            effects.push(Effect::Notification(GameNotification::WeTimedOut {
                                id: old_definition.game_id.clone(),
                                amount: amount.clone(),
                            }));
                        }
                    } else {
                        let has_rem = conditions.iter().any(|c| matches!(c, CoinCondition::Rem(_)));
                        if has_rem {
                            effects.push(Effect::Notification(GameNotification::OpponentSlashedUs {
                                id: old_definition.game_id.clone(),
                            }));
                        } else {
                            effects.push(Effect::Notification(GameNotification::WeTimedOutOpponent {
                                id: old_definition.game_id.clone(),
                                amount: amount.clone(),
                            }));
                        }
                    }
                }
                effects.push(Effect::GameFinished {
                    id: old_definition.game_id.clone(),
                    mover_share: amount,
                });
                unblock_queue = true;
            }
            CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Moved {
                new_coin_string,
                state_number,
                readable,
                mover_share,
                ..
            }) => {
                debug!(
                    "{initial_potato} got a their spend {new_coin_string:?} from ph {:?}",
                    old_definition.puzzle_hash
                );
                let (puzzle_hash, amt) =
                    if let Some((orig_coin_id, ph, amt)) = new_coin_string.to_parts() {
                        assert_eq!(coin_id.to_coin_id(), orig_coin_id);
                        (ph, amt)
                    } else {
                        return Err(Error::StrErr("bad coin explode".to_string()));
                    };

                let game_id = old_definition.game_id.clone();
                debug!("{initial_potato} got their coin spend with new puzzle hash {puzzle_hash:?} {amt:?}");
                debug!("{initial_potato} changing game map");
                self.game_map.insert(
                    new_coin_string.clone(),
                    OnChainGameState {
                        puzzle_hash,
                        our_turn: true,
                        ..old_definition
                    },
                );

                effects.push(Effect::OpponentMoved {
                    id: game_id,
                    state_number,
                    readable,
                    mover_share,
                });
                effects.push(Effect::RegisterCoin {
                    coin: new_coin_string,
                    timeout: self.channel_timeout.clone(),
                    name: Some("coin gives my turn"),
                });

                unblock_queue = true;
            }
            CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Slash(outcome)) => {
                debug!("{initial_potato} slash {outcome:?}");
                self.have_potato = PotatoState::Present;

                effects.push(Effect::Notification(GameNotification::OpponentPlayedIllegalMove {
                    id: old_definition.game_id.clone(),
                }));

                match outcome.borrow() {
                    SlashOutcome::Reward {
                        my_reward_coin_string,
                        transaction,
                    } => {
                        let amount = my_reward_coin_string
                            .to_parts()
                            .map(|(_, _, amt)| amt.clone())
                            .unwrap_or_default();
                        effects.push(Effect::SpendTransaction(SpendBundle {
                            name: Some("slash move".to_string()),
                            spends: vec![*transaction.clone()],
                        }));
                        let slash_coin = transaction.coin.clone();
                        debug!("{initial_potato} tracking slash coin {slash_coin:?} for pending outcome");
                        self.game_map.insert(
                            slash_coin.clone(),
                            OnChainGameState {
                                pending_slash_amount: Some(amount),
                                our_turn: false,
                                ..old_definition
                            },
                        );
                        effects.push(Effect::RegisterCoin {
                            coin: slash_coin,
                            timeout: self.channel_timeout.clone(),
                            name: Some("pending slash"),
                        });
                    }
                    SlashOutcome::NoReward => {
                        effects.push(Effect::Notification(GameNotification::OpponentSlashedUs {
                            id: old_definition.game_id.clone(),
                        }));
                        effects.push(Effect::GameFinished {
                            id: old_definition.game_id.clone(),
                            mover_share: Amount::default(),
                        });
                    }
                }
            }
            CoinSpentInformation::OurReward(_, amt) => {
                debug!("{initial_potato} our reward coin was spent");
                if !old_definition.our_turn {
                    effects.push(Effect::Notification(GameNotification::WeTimedOutOpponent {
                        id: old_definition.game_id.clone(),
                        amount: amt,
                    }));
                }
                effects.push(Effect::GameFinished {
                    id: old_definition.game_id.clone(),
                    mover_share: Amount::default(),
                });
                unblock_queue = true;
            }
            CoinSpentInformation::OurSpend(ph, amt) => {
                debug!("{initial_potato} got an our spend {ph:?} {amt:?}");
                let new_coin_id = CoinString::from_parts(&coin_id.to_coin_id(), &ph, &amt);
                debug!("{initial_potato} changing game map");
                self.game_map.insert(
                    new_coin_id.clone(),
                    OnChainGameState {
                        puzzle_hash: ph,
                        our_turn: false,
                        ..old_definition
                    },
                );

                effects.push(Effect::RegisterCoin {
                    coin: new_coin_id,
                    timeout: self.channel_timeout.clone(),
                    name: Some("coin gives their turn"),
                });

                unblock_queue = true;
            }
        }

        if unblock_queue {
            debug!(
                "{initial_potato} do another action, actions {:?}",
                self.game_action_queue
            );
            effects.extend(self.next_action(env)?);
        }

        Ok(effects)
    }

    fn coin_timeout_reached<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error>
    {
        let mut effects = Vec::new();

        if let Some(mut game_def) = self.game_map.remove(coin_id) {
            let initial_potato = self.player_ch.is_initial_potato();
            let game_id = game_def.game_id.clone();
            let state_number = game_def.state_number;
            debug!("{initial_potato} timeout coin {coin_id:?}, do accept");

            if let Some(slash_amount) = game_def.pending_slash_amount {
                debug!("{initial_potato} pending slash coin timed out - opponent successfully cheated");
                effects.push(Effect::Notification(GameNotification::OpponentSuccessfullyCheated {
                    id: game_id.clone(),
                    amount: slash_amount,
                }));
                effects.push(Effect::GameFinished {
                    id: game_id,
                    mover_share: Amount::default(),
                });
                effects.extend(self.next_action(env)?);
                return Ok(effects);
            }

            let coin_amount = coin_id
                .to_parts()
                .map(|(_, _, amt)| amt)
                .unwrap_or_default();

            if let AcceptTransactionState::Determined(tx) = &game_def.accept {
                debug!("{initial_potato} accept tx {tx:?}");
                self.have_potato = PotatoState::Present;

                debug!("Spend reward coins downstream of the timeout");

                let spend_bundle = {
                    let mut total_spends = vec![CoinSpend {
                        coin: coin_id.clone(),
                        bundle: tx.bundle.clone(),
                    }];

                    let conditions = CoinCondition::from_puzzle_and_solution(
                        env.allocator,
                        &tx.bundle.puzzle.to_program(),
                        &tx.bundle.solution.p(),
                    )?;

                    if let Some(mut spend_bundle) =
                        self.player_ch
                            .handle_reward_spends(env, coin_id, &conditions)?
                    {
                        total_spends.append(&mut spend_bundle.spends);
                    }

                    SpendBundle {
                        name: Some("redo accept".to_string()),
                        spends: total_spends,
                    }
                };

                effects.push(Effect::SpendTransaction(spend_bundle));

                if game_def.our_turn {
                    if game_def.accepted {
                        effects.push(Effect::Notification(GameNotification::AcceptFinished {
                            id: game_id.clone(),
                            amount: coin_amount.clone(),
                        }));
                    } else {
                        effects.push(Effect::Notification(GameNotification::WeTimedOut {
                            id: game_id.clone(),
                            amount: coin_amount.clone(),
                        }));
                    }
                } else {
                    effects.push(Effect::Notification(GameNotification::WeTimedOutOpponent {
                        id: game_id.clone(),
                        amount: coin_amount.clone(),
                    }));
                }

                effects.push(Effect::GameFinished {
                    id: game_id.clone(),
                    mover_share: coin_amount,
                });
            } else {
                let our_turn = game_def.our_turn;
                let accepted = game_def.accepted;
                game_def.accept = AcceptTransactionState::Finished;
                self.game_map.insert(coin_id.clone(), game_def);

                let result_transaction = {
                    match self
                        .player_ch
                        .accept_or_timeout_game_on_chain(env, &game_id, coin_id)
                    {
                        Ok(tx) => tx,
                        Err(_) => return self.next_action(env),
                    }
                };

                self.have_potato = PotatoState::Present;
                if let Some(tx) = result_transaction {
                    debug!("{initial_potato} accept: have transaction {tx:?}");
                    self.have_potato = PotatoState::Absent;
                    effects.push(Effect::SpendTransaction(SpendBundle {
                        name: Some(format!("{initial_potato} accept transaction")),
                        spends: vec![CoinSpend {
                            coin: coin_id.clone(),
                            bundle: tx.bundle.clone(),
                        }],
                    }));
                } else {
                    debug!("{initial_potato} Accepted game when our share was zero");
                    debug!("when action queue is {:?}", self.game_action_queue);
                }

                if our_turn {
                    if accepted {
                        effects.push(Effect::Notification(GameNotification::AcceptFinished {
                            id: game_id.clone(),
                            amount: coin_amount.clone(),
                        }));
                    } else {
                        effects.push(Effect::Notification(GameNotification::WeTimedOut {
                            id: game_id.clone(),
                            amount: coin_amount.clone(),
                        }));
                    }
                } else {
                    effects.push(Effect::Notification(GameNotification::WeTimedOutOpponent {
                        id: game_id.clone(),
                        amount: coin_amount.clone(),
                    }));
                }
            }

            let readable = {
                let nil = env
                    .allocator
                    .encode_atom(clvm_traits::Atom::Borrowed(&[]))
                    .into_gen()?;
                ReadableMove::from_nodeptr(env.allocator, nil)?
            };
            let mover_share = Amount::default();

            effects.push(Effect::OpponentMoved {
                id: game_id,
                state_number,
                readable,
                mover_share,
            });
            effects.extend(self.next_action(env)?);
        }

        Ok(effects)
    }

    fn next_action<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<Vec<Effect>, Error>
    {
        if let Some(action) = self.game_action_queue.pop_front() {
            return self.do_on_chain_action(env, action);
        }

        Ok(Vec::new())
    }

    fn do_on_chain_move<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        current_coin: &CoinString,
        game_id: GameID,
        readable_move: ReadableMove,
        entropy: Hash,
    ) -> Result<Vec<Effect>, Error>
    {
        let (initial_potato, (old_ph, new_ph, state_number, move_result, transaction)) = {
            let initial_potato = self.player_ch.is_initial_potato();
            let my_turn = self.player_ch.game_is_my_turn(&game_id);
            if my_turn != Some(true) {
                debug!(
                    "{initial_potato} trying to do game action when not my turn {readable_move:?}"
                );
                self.game_action_queue.push_front(GameAction::Move(
                    game_id,
                    readable_move,
                    entropy,
                ));
                return Ok(Vec::new());
            }

            debug!("{initial_potato} do on chain move {readable_move:?} cc {current_coin:?}");

            (
                initial_potato,
                self.player_ch.on_chain_our_move(
                    env,
                    &game_id,
                    &readable_move,
                    entropy,
                    current_coin,
                )?,
            )
        };

        debug!("{initial_potato} old_ph {old_ph:?}");
        debug!("{initial_potato} new_ph {new_ph:?}");

        if let Some((_, ph, _)) = current_coin.to_parts() {
            assert_eq!(old_ph, ph);
        }

        debug!("{initial_potato} created puzzle hash for move {new_ph:?}");
        let old_definition = if let Some(old_def) = self.game_map.remove(current_coin) {
            old_def
        } else {
            return Err(Error::StrErr("no such game".to_string()));
        };

        let new_coin =
            CoinString::from_parts(&current_coin.to_coin_id(), &new_ph, &transaction.amount);

        debug!("{initial_potato} changing game map");
        self.game_map.insert(
            new_coin.clone(),
            OnChainGameState {
                puzzle_hash: new_ph,
                our_turn: false,
                state_number: state_number,
                ..old_definition
            },
        );

        let effects = vec![
            Effect::RegisterCoin {
                coin: new_coin,
                timeout: self.channel_timeout.clone(),
                name: Some("game coin for my turn"),
            },
            Effect::SpendTransaction(SpendBundle {
                name: Some("on chain move".to_string()),
                spends: vec![CoinSpend {
                    coin: current_coin.clone(),
                    bundle: transaction.bundle.clone(),
                }],
            }),
            Effect::SelfMove {
                id: game_id,
                state_number,
                move_made: move_result.basic.move_made.clone(),
            },
        ];

        Ok(effects)
    }

    fn do_on_chain_action<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        action: GameAction,
    ) -> Result<Vec<Effect>, Error>
    {
        let initial_potato = self.player_ch.is_initial_potato();
        let get_current_coin = |game_id: &GameID| -> Result<CoinString, Error> {
            if let Some((current, _game)) = self.game_map.iter().find(|g| g.1.game_id == *game_id) {
                Ok(current.clone())
            } else {
                Err(Error::StrErr(format!(
                    "no matching game in {:?}",
                    self.game_map
                )))
            }
        };

        debug!("{initial_potato} do_on_chain_action {action:?}");
        debug!("{initial_potato} have collection {:?}", self.game_map);

        match action {
            GameAction::LocalStartGame => {
                Err(Error::StrErr("can't start game on chain".to_string()))
            }
            GameAction::Move(game_id, readable_move, hash) => {
                let current_coin = get_current_coin(&game_id)?;
                self.do_on_chain_move(env, &current_coin, game_id, readable_move, hash)
            }
            GameAction::RedoMove(coin, new_ph, tx, _move_data, amt) => {
                self.have_potato = PotatoState::Absent;

                let new_coin = CoinString::from_parts(&coin.to_coin_id(), &new_ph, &amt);
                debug!("the redo move was for puzzle hash {new_ph:?}");
                debug!("the redo move turned into {new_coin:?}");
                debug!(
                    "the redo move turned into id {:?}",
                    new_coin.to_coin_id()
                );

                Ok(vec![
                    Effect::SpendTransaction(SpendBundle {
                        name: Some("redo move".to_string()),
                        spends: vec![CoinSpend {
                            coin: coin.clone(),
                            bundle: tx.bundle.clone(),
                        }],
                    }),
                    Effect::RegisterCoin {
                        coin: new_coin,
                        timeout: self.channel_timeout.clone(),
                        name: Some("post redo game coin"),
                    },
                ])
            }
            GameAction::RedoAccept(_game_id, coin, _new_ph, tx) => {
                let mut effects = Vec::new();
                if let Some(def) = self.game_map.get_mut(&coin) {
                    debug!("redoaccept: outcome coin is said to be {coin:?}");
                    debug!("redoaccept: tx {tx:?}");

                    self.have_potato = PotatoState::Absent;
                    debug!("{initial_potato} redo accept: register for timeout {coin:?}");
                    let tx_borrow: &RefereeOnChainTransaction = tx.borrow();
                    def.accept = AcceptTransactionState::Determined(Box::new(tx_borrow.clone()));
                    effects.push(Effect::RegisterCoin {
                        coin,
                        timeout: self.channel_timeout.clone(),
                        name: Some("redo accept wait"),
                    });
                }
                Ok(effects)
            }
            GameAction::Accept(game_id) => {
                let current_coin = get_current_coin(&game_id)?;
                let my_turn = self.player_ch.game_is_my_turn(&game_id);
                debug!(
                    "{initial_potato} on chain (my turn {my_turn:?}): accept game coin {current_coin:?}",
                );

                if let Some(def) = self.game_map.get_mut(&current_coin) {
                    def.accepted = true;
                }

                Ok(Vec::new())
            }
            GameAction::Shutdown(conditions) => {
                if !self.no_live_games() {
                    debug!("Can't shut down yet, still have games");
                    self.game_action_queue
                        .push_front(GameAction::Shutdown(conditions));
                    return Ok(Vec::new());
                }

                debug!("notify shutdown complete");
                Ok(vec![Effect::ShutdownComplete {
                    reward_coin: None,
                }])
            }
            GameAction::SendPotato => Ok(Vec::new()),
        }
    }

    fn shut_down(
        &mut self,
        conditions: Rc<dyn ShutdownConditions>,
    ) -> Result<(bool, Option<Effect>), Error>
    {
        if !self.no_live_games() {
            debug!(
                "{} waiting for all games to be done",
                self.player_ch.is_initial_potato()
            );
            self.game_action_queue
                .push_back(GameAction::Shutdown(ShutdownActionHolder(conditions)));
            return Ok((false, None));
        }

        Ok((true, Some(Effect::ShutdownComplete {
            reward_coin: None,
        })))
    }

    fn get_game_state_id<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<Option<Hash>, Error>
    {
        self.player_ch.get_game_state_id(env).map(Some)
    }
}
