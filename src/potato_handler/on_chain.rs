use std::borrow::Borrow;
use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

use rand::Rng;

use log::debug;

use serde::{Deserialize, Serialize};
use serde_json_any_key::*;

use crate::channel_handler::types::ChannelHandlerEnv;
use crate::channel_handler::types::{
    AcceptTransactionState, CoinSpentInformation, OnChainGameState, PotatoMoveCachedData,
    ReadableMove,
};
use crate::channel_handler::ChannelHandler;
use crate::common::types::{
    Amount, CoinCondition, CoinSpend, CoinString, Error, GameID, Hash, Program, PuzzleHash,
    SpendBundle, Timeout,
};
use crate::potato_handler::effects::{Effect, GameNotification, ResyncInfo};
use crate::potato_handler::types::{GameAction, PotatoHandlerImpl, PotatoState};
use crate::referee::types::{RefereeOnChainTransaction, SlashOutcome, TheirTurnCoinSpentResult};
use crate::referee::Referee;

enum PendingMoveKind {
    /// From do_on_chain_move: we computed the move locally and can restore the
    /// post-move referee if our tx wins, or re-queue the move if preempted.
    OurMove {
        post_move_referee: Rc<Referee>,
        post_move_last_ph: PuzzleHash,
    },
}

struct PendingMoveSavedState {
    coin: CoinString,
    expected_ph: PuzzleHash,
    game_id: GameID,
    kind: PendingMoveKind,
}

#[derive(Serialize, Deserialize)]
pub struct OnChainGameHandler {
    have_potato: PotatoState,
    channel_timeout: Timeout,
    player_ch: ChannelHandler,
    game_action_queue: VecDeque<GameAction>,
    #[serde(with = "any_key_map")]
    game_map: HashMap<CoinString, OnChainGameState>,
    #[serde(skip)]
    pending_move: Option<PendingMoveSavedState>,
}

impl std::fmt::Debug for OnChainGameHandler {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(formatter, "OnChainGameHandler(..)")
    }
}

impl OnChainGameHandler {
    pub fn new(
        have_potato: PotatoState,
        channel_timeout: Timeout,
        player_ch: ChannelHandler,
        game_action_queue: VecDeque<GameAction>,
        game_map: HashMap<CoinString, OnChainGameState>,
    ) -> Self {
        OnChainGameHandler {
            have_potato,
            channel_timeout,
            player_ch,
            game_action_queue,
            game_map,
            pending_move: None,
        }
    }

    fn try_emit_terminal(
        &self,
        _game_id: &GameID,
        notification: GameNotification,
    ) -> Option<Effect> {
        Some(Effect::from(notification))
    }

    pub fn get_game_coin(&self, game_id: &GameID) -> Option<CoinString> {
        self.game_map
            .iter()
            .find(|(_, g)| g.game_id == *game_id)
            .map(|(coin, _)| coin.clone())
    }

    pub fn remove_game_coin_info(&mut self, coin_id: &CoinString) -> Option<(GameID, bool)> {
        self.game_map
            .remove(coin_id)
            .map(|def| (def.game_id, def.our_turn))
    }

    fn do_on_chain_redo_move<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        game_id: GameID,
        coin: CoinString,
        cached_move: Rc<PotatoMoveCachedData>,
    ) -> Result<Effect, Error> {
        let saved_referee = cached_move
            .saved_post_move_referee
            .as_ref()
            .ok_or_else(|| {
                Error::StrErr("RedoMove: no saved post-move referee in cached data".to_string())
            })?;
        let saved_ph = cached_move
            .saved_post_move_last_ph
            .as_ref()
            .ok_or_else(|| {
                Error::StrErr("RedoMove: no saved post-move last_ph in cached data".to_string())
            })?;

        let (pre_referee, pre_last_ph) = self.player_ch.save_game_state(&game_id)?;

        self.player_ch
            .restore_game_state(&game_id, saved_referee.clone(), saved_ph.clone())?;

        let transaction =
            self.player_ch
                .get_transaction_for_game_move(env.allocator, &game_id, &coin, true)?;

        let new_ph = self.player_ch.get_game_outcome_puzzle_hash(env, &game_id)?;

        let (post_referee, post_last_ph) = self.player_ch.save_game_state(&game_id)?;

        self.player_ch
            .restore_game_state(&game_id, pre_referee, pre_last_ph)?;

        self.pending_move = Some(PendingMoveSavedState {
            coin: coin.clone(),
            expected_ph: new_ph,
            game_id: game_id.clone(),
            kind: PendingMoveKind::OurMove {
                post_move_referee: post_referee,
                post_move_last_ph: post_last_ph,
            },
        });

        Ok(Effect::SpendTransaction(SpendBundle {
            name: Some("on chain redo move".to_string()),
            spends: vec![CoinSpend {
                coin: coin.clone(),
                bundle: transaction.bundle.clone(),
            }],
        }))
    }
}

impl PotatoHandlerImpl for OnChainGameHandler {
    fn channel_handler(&self) -> &ChannelHandler {
        &self.player_ch
    }

    fn my_move_in_game(&self, game_id: &GameID) -> Option<bool> {
        self.game_map
            .values()
            .find(|g| g.game_id == *game_id)
            .map(|g| g.our_turn)
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
    ) -> Result<(bool, Option<Effect>), Error> {
        if self.game_map.contains_key(coin_id) {
            return Ok((
                true,
                Some(Effect::RequestPuzzleAndSolution(coin_id.clone())),
            ));
        }

        Ok((false, None))
    }

    fn handle_game_coin_spent<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        coin_id: &CoinString,
        puzzle: &Program,
        solution: &Program,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        let mut effects = Vec::new();
        let mut resync_info: Option<ResyncInfo> = None;
        let mut unblock_queue = false;
        let initial_potato = self.player_ch.is_initial_potato();

        debug!("{initial_potato} handle game coin spent {coin_id:?}");

        let is_pending = self
            .pending_move
            .as_ref()
            .map(|p| p.coin == *coin_id)
            .unwrap_or(false);

        if is_pending {
            let conditions =
                CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;
            let create = conditions.iter().find_map(|c| match c {
                CoinCondition::CreateCoin(ph, amt) => Some((ph.clone(), amt.clone())),
                _ => None,
            });

            if let Some((create_ph, create_amt)) = create {
                let pending = self.pending_move.take().unwrap();

                let old_def = self.game_map.remove(coin_id).ok_or_else(|| {
                    Error::StrErr("pending move coin not in game_map".to_string())
                })?;
                self.have_potato = PotatoState::Present;

                let new_coin =
                    CoinString::from_parts(&coin_id.to_coin_id(), &create_ph, &create_amt);

                if create_ph == pending.expected_ph {
                    // Our transaction won the race.
                    let PendingMoveKind::OurMove {
                        post_move_referee,
                        post_move_last_ph,
                        ..
                    } = pending.kind;
                    self.player_ch.restore_game_state(
                        &pending.game_id,
                        post_move_referee,
                        post_move_last_ph,
                    )?;

                    let gt = old_def.game_timeout.clone();
                    self.game_map.insert(
                        new_coin.clone(),
                        OnChainGameState {
                            puzzle_hash: create_ph,
                            our_turn: false,
                            ..old_def
                        },
                    );

                    effects.push(Effect::RegisterCoin {
                        coin: new_coin,
                        timeout: gt,
                        name: Some("our on-chain move confirmed"),
                    });
                    effects.extend(self.next_action(env)?);
                    return Ok((effects, None));
                }

                // Our transaction lost the race (preempted by opponent).
                // Re-insert the game into game_map and fall through to
                // the standard coin-spent processing path, which will
                // call their_turn_coin_spent to advance the referee.
                self.game_map.insert(
                    pending.coin.clone(),
                    OnChainGameState {
                        our_turn: false,
                        ..old_def
                    },
                );
            }
        }

        let old_definition = if let Some(old_definition) = self.game_map.remove(coin_id) {
            self.have_potato = PotatoState::Present;
            old_definition
        } else {
            debug!("coin spent for coin {coin_id:?} not in game map");
            return Ok((effects, None));
        };

        if old_definition.pending_slash_amount.is_some() {
            debug!("{initial_potato} pending slash coin was spent - slash succeeded");
            let conditions =
                CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;
            let reward_ph = self.player_ch.get_reward_puzzle_hash(env)?;
            let parent_coin_id = coin_id.to_coin_id();
            let reward_coin = conditions
                .iter()
                .find_map(|c| {
                    if let CoinCondition::CreateCoin(ph, amt) = c {
                        if *ph == reward_ph && *amt > Amount::default() {
                            return Some(CoinString::from_parts(&parent_coin_id, ph, amt));
                        }
                    }
                    None
                })
                .unwrap_or_default();
            if let Some(eff) = self.try_emit_terminal(
                &old_definition.game_id,
                GameNotification::WeSlashedOpponent {
                    id: old_definition.game_id.clone(),
                    reward_coin,
                },
            ) {
                effects.push(eff);
            }
            effects.extend(self.next_action(env)?);
            return Ok((effects, None));
        }

        let conditions = CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;

        if old_definition.accepted {
            let reward_ph = self.player_ch.get_reward_puzzle_hash(env)?;
            let created = conditions.iter().find_map(|c| match c {
                CoinCondition::CreateCoin(ph, amt) => Some((ph.clone(), amt.clone())),
                _ => None,
            });

            if let Some((ph, amt)) = created {
                if ph == reward_ph {
                    if !old_definition.notification_sent {
                        let reward_coin = if amt > Amount::default() {
                            Some(CoinString::from_parts(&coin_id.to_coin_id(), &ph, &amt))
                        } else {
                            None
                        };
                        if let Some(eff) = self.try_emit_terminal(
                            &old_definition.game_id,
                            GameNotification::WeTimedOut {
                                id: old_definition.game_id.clone(),
                                our_reward: amt,
                                reward_coin,
                            },
                        ) {
                            effects.push(eff);
                        }
                    }
                } else {
                    // The accepted coin was spent by a game move (e.g. the
                    // opponent's redo) rather than a timeout.  Carry the
                    // accepted flag forward to the new game coin so we keep
                    // waiting for the eventual timeout.
                    let new_coin = CoinString::from_parts(&coin_id.to_coin_id(), &ph, &amt);
                    debug!(
                        "{initial_potato} accepted coin advanced by redo: tracking new coin {new_coin:?}"
                    );
                    let gt = old_definition.game_timeout.clone();
                    self.game_map.insert(
                        new_coin.clone(),
                        OnChainGameState {
                            puzzle_hash: ph,
                            our_turn: !old_definition.our_turn,
                            accepted: true,
                            ..old_definition
                        },
                    );
                    effects.push(Effect::RegisterCoin {
                        coin: new_coin,
                        timeout: gt,
                        name: Some("accepted game coin advanced by redo"),
                    });
                }
            }

            effects.extend(self.next_action(env)?);
            return Ok((effects, None));
        }

        if !self.player_ch.has_live_game(&old_definition.game_id) {
            debug!(
                "game {:?} already ended, skipping coin spent",
                old_definition.game_id
            );
            effects.extend(self.next_action(env)?);
            return Ok((effects, None));
        }

        let result =
            self.player_ch
                .game_coin_spent(env, &old_definition.game_id, coin_id, &conditions);

        let their_turn_result = if let Ok(result) = result {
            result
        } else {
            debug!("failed result {result:?}");
            if let Some(eff) = self.try_emit_terminal(
                &old_definition.game_id,
                GameNotification::GameError {
                    id: old_definition.game_id.clone(),
                    reason: format!("game_coin_spent failed: {result:?}"),
                },
            ) {
                effects.push(eff);
            }
            effects.extend(self.next_action(env)?);
            return Ok((effects, None));
        };

        debug!(
            "{initial_potato} game coin spent result from channel handler {their_turn_result:?}"
        );

        if old_definition.our_turn {
            let is_expected = matches!(
                &their_turn_result,
                CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Expected(..))
                    | CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Timedout { .. })
                    | CoinSpentInformation::OurReward(..)
            );
            if !is_expected {
                if let Some(eff) = self.try_emit_terminal(
                    &old_definition.game_id,
                    GameNotification::GameError {
                        id: old_definition.game_id.clone(),
                        reason: format!("our turn coin spent unexpectedly: {their_turn_result:?}"),
                    },
                ) {
                    effects.push(eff);
                }
                effects.extend(self.next_action(env)?);
                return Ok((effects, None));
            }
        }

        match their_turn_result {
            CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Expected(
                state_number,
                ph,
                amt,
                _redo,
            )) => {
                debug!("{initial_potato} got an expected spend {ph:?} {amt:?}");
                let new_coin_id = CoinString::from_parts(&coin_id.to_coin_id(), &ph, &amt);

                let game_id = old_definition.game_id.clone();
                let is_my_turn = matches!(self.player_ch.game_is_my_turn(&game_id), Some(true));

                // is_my_turn==false means the referee already processed
                // our move (it thinks it's "their turn"). The on-chain
                // coin hasn't seen that move yet, so check for a cached
                // redo to replay it.
                let mut on_chain_our_turn = is_my_turn;
                if !is_my_turn {
                    if let Some(cached) = self.player_ch.take_cached_move_for_game(&game_id) {
                        self.game_action_queue.push_back(GameAction::RedoMove(
                            game_id.clone(),
                            new_coin_id.clone(),
                            cached,
                        ));
                        on_chain_our_turn = true;
                    }
                }

                let gt = old_definition.game_timeout.clone();
                self.game_map.insert(
                    new_coin_id.clone(),
                    OnChainGameState {
                        puzzle_hash: ph.clone(),
                        our_turn: on_chain_our_turn,
                        ..old_definition
                    },
                );

                effects.push(Effect::RegisterCoin {
                    coin: new_coin_id,
                    timeout: gt,
                    name: Some(if on_chain_our_turn {
                        "expected spend - my turn"
                    } else {
                        "expected spend - their turn"
                    }),
                });
                resync_info = Some(ResyncInfo {
                    state_number,
                    is_my_turn,
                });
                unblock_queue = true;
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
                if !old_definition.notification_sent {
                    let notif = if old_definition.our_turn {
                        GameNotification::WeTimedOut {
                            id: old_definition.game_id.clone(),
                            our_reward: amount.clone(),
                            reward_coin: my_reward_coin_string.clone(),
                        }
                    } else {
                        let has_rem = conditions
                            .iter()
                            .any(|c| matches!(c, CoinCondition::Rem(_)));
                        if has_rem {
                            GameNotification::OpponentSlashedUs {
                                id: old_definition.game_id.clone(),
                            }
                        } else {
                            GameNotification::OpponentTimedOut {
                                id: old_definition.game_id.clone(),
                                our_reward: amount.clone(),
                                reward_coin: my_reward_coin_string.clone(),
                            }
                        }
                    };
                    if let Some(eff) = self.try_emit_terminal(&old_definition.game_id, notif) {
                        effects.push(eff);
                    }
                }
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
                let gt = old_definition.game_timeout.clone();
                debug!("{initial_potato} got their coin spend with new puzzle hash {puzzle_hash:?} {amt:?}");
                debug!("{initial_potato} changing game map");
                self.game_map.insert(
                    new_coin_string.clone(),
                    OnChainGameState {
                        puzzle_hash: puzzle_hash.clone(),
                        our_turn: true,
                        ..old_definition
                    },
                );

                // Opponent moved on-chain, advancing the game state.
                // If we had a cached move, check if it's now stale.
                if let Some(cached) = self.player_ch.take_cached_move_for_game(&game_id) {
                    if cached.match_puzzle_hash == puzzle_hash {
                        self.game_action_queue.push_back(GameAction::RedoMove(
                            game_id.clone(),
                            new_coin_string.clone(),
                            cached,
                        ));
                    } else {
                        debug!(
                            "{initial_potato} discarding stale cached move for game={game_id:?} \
                             cached_ph={:?} coin_ph={puzzle_hash:?}",
                            cached.match_puzzle_hash
                        );
                    }
                }

                effects.push(Effect::OpponentMoved {
                    id: game_id,
                    state_number,
                    readable,
                    mover_share,
                });
                effects.push(Effect::RegisterCoin {
                    coin: new_coin_string,
                    timeout: gt,
                    name: Some("coin gives my turn"),
                });

                unblock_queue = true;
            }
            CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Slash(outcome)) => {
                debug!("{initial_potato} slash {outcome:?}");
                self.have_potato = PotatoState::Present;

                effects.push(Effect::OpponentPlayedIllegalMove {
                    id: old_definition.game_id.clone(),
                });

                match outcome.borrow() {
                    SlashOutcome::Reward {
                        my_reward_coin_string,
                        transaction,
                        cheating_move_mover_share,
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
                        let gt = old_definition.game_timeout.clone();
                        debug!("{initial_potato} tracking slash coin {slash_coin:?} for pending outcome");
                        self.game_map.insert(
                            slash_coin.clone(),
                            OnChainGameState {
                                pending_slash_amount: Some(amount),
                                cheating_move_mover_share: Some(cheating_move_mover_share.clone()),
                                our_turn: false,
                                ..old_definition
                            },
                        );
                        effects.push(Effect::RegisterCoin {
                            coin: slash_coin,
                            timeout: gt,
                            name: Some("pending slash"),
                        });
                    }
                    SlashOutcome::NoReward => {
                        if let Some(eff) = self.try_emit_terminal(
                            &old_definition.game_id,
                            GameNotification::OpponentSlashedUs {
                                id: old_definition.game_id.clone(),
                            },
                        ) {
                            effects.push(eff);
                        }
                    }
                }
            }
            CoinSpentInformation::OurReward(ph, amt) => {
                debug!("{initial_potato} our reward coin was spent");
                if !old_definition.notification_sent {
                    let reward_coin = if amt > Amount::default() {
                        Some(CoinString::from_parts(&coin_id.to_coin_id(), &ph, &amt))
                    } else {
                        None
                    };
                    let notif = if old_definition.our_turn {
                        GameNotification::WeTimedOut {
                            id: old_definition.game_id.clone(),
                            our_reward: amt,
                            reward_coin,
                        }
                    } else {
                        GameNotification::OpponentTimedOut {
                            id: old_definition.game_id.clone(),
                            our_reward: amt,
                            reward_coin,
                        }
                    };
                    if let Some(eff) = self.try_emit_terminal(&old_definition.game_id, notif) {
                        effects.push(eff);
                    }
                }
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

        Ok((effects, resync_info))
    }

    fn coin_timeout_reached<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();

        if let Some(mut game_def) = self.game_map.remove(coin_id) {
            let initial_potato = self.player_ch.is_initial_potato();
            let game_id = game_def.game_id.clone();
            debug!("{initial_potato} timeout coin {coin_id:?}, do accept");

            if let Some(_slash_amount) = game_def.pending_slash_amount {
                debug!(
                    "{initial_potato} pending slash coin timed out - opponent successfully cheated"
                );
                let our_reward = game_def.cheating_move_mover_share.unwrap_or_default();
                let reward_coin = if our_reward > Amount::default() {
                    let reward_ph = self.player_ch.get_reward_puzzle_hash(env)?;
                    Some(CoinString::from_parts(
                        &coin_id.to_coin_id(),
                        &reward_ph,
                        &our_reward,
                    ))
                } else {
                    None
                };
                if let Some(eff) = self.try_emit_terminal(
                    &game_id,
                    GameNotification::OpponentSuccessfullyCheated {
                        id: game_id.clone(),
                        our_reward,
                        reward_coin,
                    },
                ) {
                    effects.push(eff);
                }
                effects.extend(self.next_action(env)?);
                return Ok(effects);
            }

            if let AcceptTransactionState::Determined(tx) = &game_def.accept {
                self.have_potato = PotatoState::Present;

                let conditions = CoinCondition::from_puzzle_and_solution(
                    env.allocator,
                    &tx.bundle.puzzle.to_program(),
                    &tx.bundle.solution.p(),
                )?;

                let reward_ph = self.player_ch.get_reward_puzzle_hash(env)?;
                let parent_coin_id = coin_id.to_coin_id();
                let reward_coin = conditions.iter().find_map(|c| {
                    if let CoinCondition::CreateCoin(ph, amt) = c {
                        if *ph == reward_ph && *amt > Amount::default() {
                            return Some(CoinString::from_parts(&parent_coin_id, ph, amt));
                        }
                    }
                    None
                });

                let our_reward = reward_coin
                    .as_ref()
                    .and_then(|rc| rc.amount())
                    .unwrap_or_default();

                if our_reward > Amount::default() {
                    let spend_bundle = SpendBundle {
                        name: Some("redo accept".to_string()),
                        spends: vec![CoinSpend {
                            coin: coin_id.clone(),
                            bundle: tx.bundle.clone(),
                        }],
                    };
                    effects.push(Effect::SpendTransaction(spend_bundle));
                }

                let notif = if game_def.our_turn {
                    GameNotification::WeTimedOut {
                        id: game_id.clone(),
                        our_reward,
                        reward_coin,
                    }
                } else {
                    GameNotification::OpponentTimedOut {
                        id: game_id.clone(),
                        our_reward,
                        reward_coin,
                    }
                };
                if let Some(eff) = self.try_emit_terminal(&game_id, notif) {
                    effects.push(eff);
                }
            } else {
                let our_turn = game_def.our_turn;
                let already_notified = game_def.notification_sent;
                game_def.accept = AcceptTransactionState::Finished;
                game_def.notification_sent = true;
                self.game_map.insert(coin_id.clone(), game_def);

                let result_transaction = {
                    match self
                        .player_ch
                        .accept_or_timeout_game_on_chain(env, &game_id, coin_id)
                    {
                        Ok(tx) => tx,
                        Err(e) => {
                            debug!("accept_or_timeout error: {e:?}");
                            return self.next_action(env);
                        }
                    }
                };

                self.have_potato = PotatoState::Present;
                let (reward_coin, our_reward) = if let Some(tx) = result_transaction {
                    self.have_potato = PotatoState::Absent;

                    let conditions = CoinCondition::from_puzzle_and_solution(
                        env.allocator,
                        &tx.bundle.puzzle.to_program(),
                        &tx.bundle.solution.p(),
                    )?;
                    let reward_ph = self.player_ch.get_reward_puzzle_hash(env)?;
                    let parent_coin_id = coin_id.to_coin_id();
                    let reward_coin = conditions.iter().find_map(|c| {
                        if let CoinCondition::CreateCoin(ph, amt) = c {
                            if *ph == reward_ph && *amt > Amount::default() {
                                return Some(CoinString::from_parts(&parent_coin_id, ph, amt));
                            }
                        }
                        None
                    });
                    let our_reward = reward_coin
                        .as_ref()
                        .and_then(|rc| rc.amount())
                        .unwrap_or_default();

                    if our_reward > Amount::default() {
                        effects.push(Effect::SpendTransaction(SpendBundle {
                            name: Some(format!("{initial_potato} accept transaction")),
                            spends: vec![CoinSpend {
                                coin: coin_id.clone(),
                                bundle: tx.bundle.clone(),
                            }],
                        }));
                    }
                    (reward_coin, our_reward)
                } else {
                    debug!("{initial_potato} Accepted game when our share was zero");
                    debug!("when action queue is {:?}", self.game_action_queue);
                    (None, Amount::default())
                };

                if !already_notified {
                    let notif = if our_turn {
                        GameNotification::WeTimedOut {
                            id: game_id.clone(),
                            our_reward,
                            reward_coin,
                        }
                    } else {
                        GameNotification::OpponentTimedOut {
                            id: game_id.clone(),
                            our_reward,
                            reward_coin,
                        }
                    };
                    if let Some(eff) = self.try_emit_terminal(&game_id, notif) {
                        effects.push(eff);
                    }
                }
            }

            effects.extend(self.next_action(env)?);
        }

        Ok(effects)
    }

    fn next_action<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<Vec<Effect>, Error> {
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
    ) -> Result<Option<Effect>, Error> {
        let initial_potato = self.player_ch.is_initial_potato();
        let my_turn = self.my_move_in_game(&game_id);
        if my_turn.is_none() {
            debug!("{initial_potato} discarding move for finished/absent game {game_id:?}");
            return Ok(None);
        }
        if my_turn == Some(false) {
            debug!("{initial_potato} trying to do game action when not my turn {readable_move:?}");
            self.game_action_queue
                .push_back(GameAction::Move(game_id, readable_move, entropy));
            return Ok(None);
        }

        debug!("{initial_potato} do on chain move {readable_move:?} cc {current_coin:?}");

        let (pre_referee, pre_last_ph) = self.player_ch.save_game_state(&game_id)?;

        let (old_ph, new_ph, _state_number, _move_result, transaction) = self
            .player_ch
            .on_chain_our_move(env, &game_id, &readable_move, entropy.clone(), current_coin)?;

        let (post_referee, post_last_ph) = self.player_ch.save_game_state(&game_id)?;

        self.player_ch
            .restore_game_state(&game_id, pre_referee, pre_last_ph.clone())?;

        if let Some((_, ph, _)) = current_coin.to_parts() {
            assert_eq!(old_ph, ph);
        }

        self.pending_move = Some(PendingMoveSavedState {
            coin: current_coin.clone(),
            expected_ph: new_ph.clone(),
            game_id: game_id.clone(),
            kind: PendingMoveKind::OurMove {
                post_move_referee: post_referee,
                post_move_last_ph: post_last_ph,
            },
        });

        Ok(Some(Effect::SpendTransaction(SpendBundle {
            name: Some("on chain move".to_string()),
            spends: vec![CoinSpend {
                coin: current_coin.clone(),
                bundle: transaction.bundle.clone(),
            }],
        })))
    }

    fn do_on_chain_action<R: Rng>(
        &mut self,
        env: &mut ChannelHandlerEnv<'_, R>,
        action: GameAction,
    ) -> Result<Vec<Effect>, Error> {
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

        match action {
            GameAction::Move(game_id, readable_move, hash) => match get_current_coin(&game_id) {
                Ok(current_coin) => Ok(self
                    .do_on_chain_move(env, &current_coin, game_id, readable_move, hash)?
                    .into_iter()
                    .collect()),
                Err(_) => {
                    debug!("{initial_potato} discarding Move for game no longer in game_map");
                    self.next_action(env)
                }
            },
            GameAction::Cheat(game_id, mover_share, entropy) => match get_current_coin(&game_id) {
                Ok(current_coin) => {
                    let my_turn = self.my_move_in_game(&game_id);
                    if my_turn == Some(true) {
                        self.player_ch
                            .enable_cheating_for_game(&game_id, &[0x80], mover_share)?;
                        let readable_move =
                            ReadableMove::from_program(Rc::new(Program::from_bytes(&[0x80])));
                        Ok(self
                            .do_on_chain_move(env, &current_coin, game_id, readable_move, entropy)?
                            .into_iter()
                            .collect())
                    } else if my_turn.is_none() {
                        debug!("{initial_potato} discarding Cheat for finished/absent game {game_id:?}");
                        Ok(Vec::new())
                    } else {
                        debug!("{initial_potato} Cheat: not our turn, deferring");
                        self.game_action_queue.push_back(GameAction::Cheat(
                            game_id,
                            mover_share,
                            entropy,
                        ));
                        Ok(Vec::new())
                    }
                }
                Err(_) => {
                    debug!("{initial_potato} discarding Cheat for game no longer in game_map");
                    self.next_action(env)
                }
            },
            GameAction::RedoMove(game_id, coin, cached_move) => {
                Ok(vec![self.do_on_chain_redo_move(
                    env,
                    game_id,
                    coin,
                    cached_move,
                )?])
            }
            GameAction::RedoAcceptTimeout(_game_id, coin, _new_ph, tx) => {
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
                        timeout: def.game_timeout.clone(),
                        name: Some("redo accept wait"),
                    });
                }
                Ok(effects)
            }
            GameAction::AcceptTimeout(game_id) => {
                let on_chain_turn = self.my_move_in_game(&game_id);
                if on_chain_turn != Some(true) {
                    debug!(
                        "{initial_potato} AcceptTimeout: not our turn ({on_chain_turn:?}), deferring"
                    );
                    self.game_action_queue
                        .push_back(GameAction::AcceptTimeout(game_id));
                    return Ok(Vec::new());
                }
                let current_coin = get_current_coin(&game_id)?;
                debug!("{initial_potato} on chain: accept game coin {current_coin:?}",);

                if let Some(def) = self.game_map.get_mut(&current_coin) {
                    def.accepted = true;
                }

                Ok(Vec::new())
            }
            GameAction::CleanShutdown => Ok(Vec::new()),
            GameAction::SendPotato => Ok(Vec::new()),
            GameAction::QueuedProposal(_, _)
            | GameAction::QueuedAcceptProposal(_)
            | GameAction::QueuedCancelProposal(_) => {
                debug!("ignoring proposal action on chain");
                Ok(vec![])
            }
        }
    }

    fn get_game_state_id<R: Rng>(
        &self,
        env: &mut ChannelHandlerEnv<'_, R>,
    ) -> Result<Option<Hash>, Error> {
        self.player_ch.get_game_state_id(env).map(Some)
    }
}
