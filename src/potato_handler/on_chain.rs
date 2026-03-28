use std::collections::{HashMap, VecDeque};
use std::rc::Rc;

use serde::{Deserialize, Serialize};
use serde_json_any_key::*;

use crate::channel_handler::types::ChannelHandlerEnv;
use crate::channel_handler::types::{
    AcceptTransactionState, ChannelHandlerPrivateKeys, CoinSpentInformation, LiveGame,
    OnChainGameState, ReadableMove,
};
use crate::common::types::{
    AllocEncoder, Amount, CoinCondition, CoinSpend, CoinString, Error, GameID, Hash, Program,
    PuzzleHash, Sha256Input, Spend, SpendBundle, Timeout,
};
use crate::peer_container::PeerHandler;
use crate::potato_handler::effects::{
    format_coin, ChannelState, ChannelStatusSnapshot, Effect, GameNotification, GameStatusKind,
    GameStatusOtherParams, ResyncInfo,
};
use crate::potato_handler::types::{GameAction, PotatoState};
use crate::referee::types::{GameMoveDetails, SlashOutcome, TheirTurnCoinSpentResult};
use crate::referee::Referee;

use std::borrow::Borrow;

pub enum PendingMoveKind {
    OurMove {
        post_move_referee: Rc<Referee>,
        post_move_last_ph: PuzzleHash,
    },
}

pub struct PendingMoveSavedState {
    pub expected_ph: PuzzleHash,
    pub game_id: GameID,
    pub kind: PendingMoveKind,
}

#[derive(Serialize, Deserialize)]
pub struct OnChainGameHandler {
    have_potato: PotatoState,
    channel_timeout: Timeout,
    game_action_queue: VecDeque<GameAction>,
    #[serde(with = "any_key_map")]
    game_map: HashMap<CoinString, OnChainGameState>,
    #[serde(skip)]
    pending_moves: HashMap<CoinString, PendingMoveSavedState>,

    // Extracted from ChannelHandler at transition time.
    private_keys: ChannelHandlerPrivateKeys,
    reward_puzzle_hash: PuzzleHash,
    their_reward_puzzle_hash: PuzzleHash,
    my_out_of_game_balance: Amount,
    their_out_of_game_balance: Amount,
    my_allocated_balance: Amount,
    their_allocated_balance: Amount,
    live_games: Vec<LiveGame>,
    pending_accept_timeouts: Vec<LiveGame>,
    unroll_advance_timeout: Timeout,
    is_initial_potato: bool,
    state_number: usize,
    was_stale: bool,
    terminal_reward_coin: Option<CoinString>,
}

impl std::fmt::Debug for OnChainGameHandler {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> Result<(), std::fmt::Error> {
        write!(formatter, "OnChainGameHandler(..)")
    }
}

pub struct OnChainGameHandlerArgs {
    pub have_potato: PotatoState,
    pub channel_timeout: Timeout,
    pub game_action_queue: VecDeque<GameAction>,
    pub game_map: HashMap<CoinString, OnChainGameState>,
    pub pending_moves: HashMap<CoinString, PendingMoveSavedState>,
    pub private_keys: ChannelHandlerPrivateKeys,
    pub reward_puzzle_hash: PuzzleHash,
    pub their_reward_puzzle_hash: PuzzleHash,
    pub my_out_of_game_balance: Amount,
    pub their_out_of_game_balance: Amount,
    pub my_allocated_balance: Amount,
    pub their_allocated_balance: Amount,
    pub live_games: Vec<LiveGame>,
    pub pending_accept_timeouts: Vec<LiveGame>,
    pub unroll_advance_timeout: Timeout,
    pub is_initial_potato: bool,
    pub state_number: usize,
    pub was_stale: bool,
    pub terminal_reward_coin: Option<CoinString>,
}

impl OnChainGameHandler {
    pub fn new(args: OnChainGameHandlerArgs) -> Self {
        OnChainGameHandler {
            have_potato: args.have_potato,
            channel_timeout: args.channel_timeout,
            game_action_queue: args.game_action_queue,
            game_map: args.game_map,
            pending_moves: args.pending_moves,
            private_keys: args.private_keys,
            reward_puzzle_hash: args.reward_puzzle_hash,
            their_reward_puzzle_hash: args.their_reward_puzzle_hash,
            my_out_of_game_balance: args.my_out_of_game_balance,
            their_out_of_game_balance: args.their_out_of_game_balance,
            my_allocated_balance: args.my_allocated_balance,
            their_allocated_balance: args.their_allocated_balance,
            live_games: args.live_games,
            pending_accept_timeouts: args.pending_accept_timeouts,
            unroll_advance_timeout: args.unroll_advance_timeout,
            is_initial_potato: args.is_initial_potato,
            state_number: args.state_number,
            was_stale: args.was_stale,
            terminal_reward_coin: args.terminal_reward_coin,
        }
    }

    pub fn is_failed(&self) -> bool {
        false
    }

    fn try_emit_terminal(
        &self,
        _game_id: &GameID,
        notification: GameNotification,
    ) -> Option<Effect> {
        Some(Effect::Notify(notification))
    }

    // --- Getters (duplicated from ChannelHandler) ---

    pub fn amount(&self) -> Amount {
        self.my_allocated_balance.clone() + self.their_allocated_balance.clone()
    }

    pub fn get_our_current_share(&self) -> Option<Amount> {
        None
    }

    pub fn get_their_current_share(&self) -> Option<Amount> {
        None
    }

    pub fn get_reward_puzzle_hash(&self) -> PuzzleHash {
        self.reward_puzzle_hash.clone()
    }

    pub fn get_opponent_reward_puzzle_hash(&self) -> PuzzleHash {
        self.their_reward_puzzle_hash.clone()
    }

    fn get_game_by_id(&self, game_id: &GameID) -> Result<usize, Error> {
        self.live_games
            .iter()
            .position(|g| &g.game_id == game_id)
            .map(Ok)
            .unwrap_or_else(|| {
                Err(Error::StrErr(
                    "no live game with the given game id".to_string(),
                ))
            })
    }

    pub fn has_live_game(&self, game_id: &GameID) -> bool {
        self.live_games.iter().any(|g| &g.game_id == game_id)
    }

    pub fn game_is_my_turn(&self, game_id: &GameID) -> Option<bool> {
        for g in self.live_games.iter() {
            if g.game_id == *game_id {
                return Some(g.is_my_turn());
            }
        }
        None
    }

    pub fn is_game_finished(&self, game_id: &GameID) -> bool {
        self.get_game_by_id(game_id)
            .map(|idx| self.live_games[idx].is_my_turn() && self.live_games[idx].is_game_over())
            .unwrap_or(false)
    }

    pub fn get_game_amount(&self, game_id: &GameID) -> Result<Amount, Error> {
        if let Some(g) = self.live_games.iter().find(|g| g.game_id == *game_id) {
            return Ok(g.get_amount());
        }
        if let Some(g) = self
            .pending_accept_timeouts
            .iter()
            .find(|g| g.game_id == *game_id)
        {
            return Ok(g.get_amount());
        }
        Err(Error::StrErr(format!(
            "get_game_amount: game {:?} not found",
            game_id
        )))
    }

    pub fn get_game_our_current_share(&self, game_id: &GameID) -> Result<Amount, Error> {
        if let Some(g) = self.live_games.iter().find(|g| g.game_id == *game_id) {
            return g.get_our_current_share();
        }
        if let Some(g) = self
            .pending_accept_timeouts
            .iter()
            .find(|g| g.game_id == *game_id)
        {
            return g.get_our_current_share();
        }
        Err(Error::StrErr(format!(
            "get_game_our_current_share: game {:?} not found",
            game_id
        )))
    }

    pub fn enable_cheating_for_game(
        &mut self,
        game_id: &GameID,
        make_move: &[u8],
        mover_share: Amount,
    ) -> Result<bool, Error> {
        let game_idx = self.get_game_by_id(game_id)?;
        Ok(self.live_games[game_idx].enable_cheating(make_move, mover_share))
    }

    pub fn get_game_state_id(&self, allocator: &mut AllocEncoder) -> Result<Option<Hash>, Error> {
        let mut bytes: Vec<u8> = Vec::with_capacity(self.live_games.len() * 32);
        for l in self.live_games.iter() {
            let ph = l.current_puzzle_hash(allocator)?;
            bytes.extend_from_slice(ph.bytes());
        }
        Ok(Some(Sha256Input::Bytes(&bytes).hash()))
    }

    // --- Game coin tracking ---

    pub fn get_game_coin(&self, game_id: &GameID) -> Option<CoinString> {
        self.game_map
            .iter()
            .find(|(_, g)| g.game_id == *game_id)
            .map(|(coin, _)| coin.clone())
    }

    pub fn my_move_in_game(&self, game_id: &GameID) -> Option<bool> {
        self.game_map
            .values()
            .find(|g| g.game_id == *game_id)
            .map(|g| g.our_turn)
    }

    pub fn remove_game_coin_info(&mut self, coin_id: &CoinString) -> Option<(GameID, bool)> {
        self.game_map
            .remove(coin_id)
            .map(|def| (def.game_id, def.our_turn))
    }

    pub fn game_map_is_empty(&self) -> bool {
        self.game_map.is_empty()
    }

    // --- Methods moved from ChannelHandler ---

    fn save_game_state(&self, game_id: &GameID) -> Result<(Rc<Referee>, PuzzleHash), Error> {
        let idx = self.get_game_by_id(game_id)?;
        Ok(self.live_games[idx].save_referee_state())
    }

    fn restore_game_state(
        &mut self,
        game_id: &GameID,
        referee: Rc<Referee>,
        last_ph: PuzzleHash,
    ) -> Result<(), Error> {
        let idx = self.get_game_by_id(game_id)?;
        self.live_games[idx].restore_referee_state(referee, last_ph);
        Ok(())
    }

    fn on_chain_our_move(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        readable_move: &ReadableMove,
        entropy: Hash,
        existing_coin: &CoinString,
    ) -> Result<(PuzzleHash, PuzzleHash, usize, GameMoveDetails, Spend), Error> {
        let game_idx = self.get_game_by_id(game_id)?;

        let last_puzzle_hash = self.live_games[game_idx].last_puzzle_hash();
        let state_number = self.state_number;

        let move_result = self.live_games[game_idx].internal_make_move(
            env.allocator,
            readable_move,
            entropy,
            state_number,
        )?;

        let tx =
            self.live_games[game_idx].get_transaction_for_move(env.allocator, existing_coin)?;

        let post_outcome = self.live_games[game_idx].outcome_puzzle_hash(env.allocator)?;

        Ok((
            last_puzzle_hash,
            post_outcome,
            self.state_number,
            move_result.details.clone(),
            tx,
        ))
    }

    fn game_coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        coin_string: &CoinString,
        conditions: &[CoinCondition],
    ) -> Result<CoinSpentInformation, Error> {
        let reward_puzzle_hash = self.reward_puzzle_hash.clone();

        let (ph, amt) = if let Some((ph, amt)) = conditions
            .iter()
            .filter_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    return Some((ph.clone(), amt.clone()));
                }
                None
            })
            .next()
        {
            (ph, amt)
        } else {
            return Err(Error::StrErr("bad coin".to_string()));
        };

        if reward_puzzle_hash == ph {
            return Ok(CoinSpentInformation::OurReward(ph.clone(), amt.clone()));
        }

        let live_game_idx = self.get_game_by_id(game_id)?;
        let state_number = self.state_number;

        let our_on_chain_ph = self.live_games[live_game_idx].current_puzzle_hash(env.allocator)?;
        let our_outcome_ph = self.live_games[live_game_idx].outcome_puzzle_hash(env.allocator)?;
        if ph == our_on_chain_ph || ph == our_outcome_ph {
            let coin_being_spent_ph = coin_string.to_parts().map(|(_, p, _)| p);
            let matches_spent = coin_being_spent_ph.as_ref() == Some(&ph);
            if !matches_spent {
                self.live_games[live_game_idx].last_referee_puzzle_hash = ph.clone();
                return Ok(CoinSpentInformation::TheirSpend(
                    TheirTurnCoinSpentResult::Expected(state_number, ph, amt, None),
                ));
            }
        }

        let spent_result = self.live_games[live_game_idx].their_turn_coin_spent(
            env.allocator,
            coin_string,
            conditions,
            state_number,
        )?;
        Ok(CoinSpentInformation::TheirSpend(spent_result))
    }

    fn accept_or_timeout_game_on_chain(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        coin: &CoinString,
    ) -> Result<Option<Spend>, Error> {
        if let Ok(game_idx) = self.get_game_by_id(game_id) {
            let tx = self.live_games[game_idx].get_transaction_for_timeout(env.allocator, coin)?;
            self.live_games.remove(game_idx);
            Ok(tx)
        } else if let Some(idx) = self
            .pending_accept_timeouts
            .iter()
            .position(|g| g.game_id == *game_id)
        {
            let tx = self.pending_accept_timeouts[idx]
                .get_transaction_for_timeout(env.allocator, coin)?;
            self.pending_accept_timeouts.remove(idx);
            Ok(tx)
        } else {
            Ok(None)
        }
    }

    // --- Existing on-chain logic ---

    pub fn check_game_coin_spent(
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

    pub fn handle_game_coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle: &Program,
        solution: &Program,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        let mut effects = Vec::new();
        let mut resync_info: Option<ResyncInfo> = None;
        let mut unblock_queue = false;

        if let Some(pending) = self.pending_moves.remove(coin_id) {
            let conditions =
                CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;
            let create = conditions.iter().find_map(|c| match c {
                CoinCondition::CreateCoin(ph, amt) => Some((ph.clone(), amt.clone())),
                _ => None,
            });

            if let Some((create_ph, create_amt)) = create {
                let old_def = self.game_map.remove(coin_id).ok_or_else(|| {
                    Error::StrErr("pending move coin not in game_map".to_string())
                })?;
                self.have_potato = PotatoState::Present;

                let new_coin =
                    CoinString::from_parts(&coin_id.to_coin_id(), &create_ph, &create_amt);

                if create_ph == pending.expected_ph {
                    let PendingMoveKind::OurMove {
                        post_move_referee,
                        post_move_last_ph,
                        ..
                    } = pending.kind;
                    self.restore_game_state(
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

                    effects.push(Effect::Notify(GameNotification::GameStatus {
                        id: pending.game_id,
                        status: GameStatusKind::OnChainTheirTurn,
                        my_reward: None,
                        coin_id: Some(new_coin.clone()),
                        reason: None,
                        other_params: Some(GameStatusOtherParams {
                            readable: None,
                            mover_share: None,
                            illegal_move_detected: None,
                            moved_by_us: Some(true),
                        }),
                    }));
                    effects.push(Effect::RegisterCoin {
                        coin: new_coin,
                        timeout: gt,
                        name: Some("our on-chain move confirmed"),
                    });
                    effects.extend(self.next_action(env)?);
                    return Ok((effects, None));
                }

                self.game_map.insert(
                    coin_id.clone(),
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
            return Ok((effects, None));
        };

        if old_definition.pending_slash_amount.is_some() {
            let conditions =
                CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;
            let reward_ph = self.reward_puzzle_hash.clone();
            let parent_coin_id = coin_id.to_coin_id();
            let reward_coin = conditions.iter().find_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    if *ph == reward_ph && *amt > Amount::default() {
                        return Some(CoinString::from_parts(&parent_coin_id, ph, amt));
                    }
                }
                None
            });
            if let Some(ref rc) = reward_coin {
                effects.push(Effect::DebugLog(format!(
                    "[slash-on-chain] {} reward={}",
                    format_coin(coin_id),
                    format_coin(rc),
                )));
            }
            let notification = if let Some(reward_coin) = reward_coin {
                GameNotification::GameStatus {
                    id: old_definition.game_id,
                    status: GameStatusKind::EndedWeSlashedOpponent,
                    my_reward: Some(reward_coin.amount().unwrap_or_default()),
                    coin_id: Some(reward_coin),
                    reason: None,
                    other_params: None,
                }
            } else {
                effects.push(Effect::DebugLog(format!(
                    "[game-error] {} slash succeeded but no reward coin found",
                    format_coin(coin_id),
                )));
                GameNotification::GameStatus {
                    id: old_definition.game_id,
                    status: GameStatusKind::EndedError,
                    my_reward: None,
                    coin_id: None,
                    reason: Some("slash succeeded but no reward coin found".to_string()),
                    other_params: None,
                }
            };
            if let Some(eff) = self.try_emit_terminal(&old_definition.game_id, notification) {
                effects.push(eff);
            }
            effects.extend(self.next_action(env)?);
            return Ok((effects, None));
        }

        let conditions = CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;

        if old_definition.accepted {
            let reward_ph = self.reward_puzzle_hash.clone();
            let their_reward_ph = self.their_reward_puzzle_hash.clone();

            let our_reward_coin = conditions.iter().find_map(|c| match c {
                CoinCondition::CreateCoin(ph, amt) if *ph == reward_ph => {
                    Some((ph.clone(), amt.clone()))
                }
                _ => None,
            });

            if let Some((ph, amt)) = our_reward_coin {
                if !old_definition.notification_sent {
                    let reward_coin = if amt > Amount::default() {
                        Some(CoinString::from_parts(&coin_id.to_coin_id(), &ph, &amt))
                    } else {
                        None
                    };
                    if let Some(eff) = self.try_emit_terminal(
                        &old_definition.game_id,
                        GameNotification::GameStatus {
                            id: old_definition.game_id,
                            status: GameStatusKind::EndedWeTimedOut,
                            my_reward: Some(amt),
                            coin_id: reward_coin,
                            reason: None,
                            other_params: None,
                        },
                    ) {
                        effects.push(eff);
                    }
                }
            } else {
                let is_timeout = conditions.iter().any(
                    |c| matches!(c, CoinCondition::CreateCoin(ph, _) if *ph == their_reward_ph),
                );

                if is_timeout {
                    if !old_definition.notification_sent {
                        if let Some(eff) = self.try_emit_terminal(
                            &old_definition.game_id,
                            GameNotification::GameStatus {
                                id: old_definition.game_id,
                                status: GameStatusKind::EndedWeTimedOut,
                                my_reward: Some(Amount::default()),
                                coin_id: None,
                                reason: None,
                                other_params: None,
                            },
                        ) {
                            effects.push(eff);
                        }
                    }
                } else {
                    let created = conditions.iter().find_map(|c| match c {
                        CoinCondition::CreateCoin(ph, amt) => Some((ph.clone(), amt.clone())),
                        _ => None,
                    });
                    if let Some((ph, amt)) = created {
                        let new_coin = CoinString::from_parts(&coin_id.to_coin_id(), &ph, &amt);
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
                        effects.push(Effect::Notify(GameNotification::GameStatus {
                            id: old_definition.game_id,
                            status: if !old_definition.our_turn {
                                GameStatusKind::OnChainMyTurn
                            } else {
                                GameStatusKind::OnChainTheirTurn
                            },
                            my_reward: None,
                            coin_id: Some(new_coin.clone()),
                            reason: None,
                            other_params: None,
                        }));
                        effects.push(Effect::RegisterCoin {
                            coin: new_coin,
                            timeout: gt,
                            name: Some("accepted game coin advanced by redo"),
                        });
                    }
                }
            }

            effects.extend(self.next_action(env)?);
            return Ok((effects, None));
        }

        if !self.has_live_game(&old_definition.game_id) {
            effects.extend(self.next_action(env)?);
            return Ok((effects, None));
        }

        let result = self.game_coin_spent(env, &old_definition.game_id, coin_id, &conditions);

        let their_turn_result = if let Ok(result) = result {
            result
        } else {
            let reason = format!("game_coin_spent failed: {result:?}");
            effects.push(Effect::DebugLog(format!(
                "[game-error] {} {reason}",
                format_coin(coin_id),
            )));
            if let Some(eff) = self.try_emit_terminal(
                &old_definition.game_id,
                GameNotification::GameStatus {
                    id: old_definition.game_id,
                    status: GameStatusKind::EndedError,
                    my_reward: None,
                    coin_id: None,
                    reason: Some(reason),
                    other_params: None,
                },
            ) {
                effects.push(eff);
            }
            effects.extend(self.next_action(env)?);
            return Ok((effects, None));
        };

        if old_definition.our_turn {
            let is_expected = matches!(
                &their_turn_result,
                CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Expected(..))
                    | CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Timedout { .. })
                    | CoinSpentInformation::OurReward(..)
            );
            if !is_expected {
                let reason = format!("our turn coin spent unexpectedly: {their_turn_result:?}");
                effects.push(Effect::DebugLog(format!(
                    "[game-error] {} {reason}",
                    format_coin(coin_id),
                )));
                if let Some(eff) = self.try_emit_terminal(
                    &old_definition.game_id,
                    GameNotification::GameStatus {
                        id: old_definition.game_id,
                        status: GameStatusKind::EndedError,
                        my_reward: None,
                        coin_id: None,
                        reason: Some(reason),
                        other_params: None,
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
                let new_coin_id = CoinString::from_parts(&coin_id.to_coin_id(), &ph, &amt);
                effects.push(Effect::DebugLog(format!(
                    "[move-on-chain] {} new_coin={}",
                    format_coin(coin_id),
                    format_coin(&new_coin_id),
                )));

                let game_id = old_definition.game_id;
                // This path is an observed on-chain spend of the current game coin.
                // Turn ownership on the next coin must flip from the previous tracked coin,
                // regardless of whether live_games' off-chain referee view has drifted.
                let is_my_turn = !old_definition.our_turn;

                let gt = old_definition.game_timeout.clone();
                self.game_map.insert(
                    new_coin_id.clone(),
                    OnChainGameState {
                        puzzle_hash: ph.clone(),
                        our_turn: is_my_turn,
                        ..old_definition
                    },
                );

                effects.push(Effect::Notify(GameNotification::GameStatus {
                    id: old_definition.game_id,
                    status: if is_my_turn {
                        GameStatusKind::OnChainMyTurn
                    } else {
                        GameStatusKind::OnChainTheirTurn
                    },
                    my_reward: None,
                    coin_id: Some(new_coin_id.clone()),
                    reason: None,
                    other_params: None,
                }));
                effects.push(Effect::RegisterCoin {
                    coin: new_coin_id,
                    timeout: gt,
                    name: Some(if is_my_turn {
                        "expected spend - my turn"
                    } else {
                        "expected spend - their turn"
                    }),
                });
                if self.is_game_finished(&game_id) {
                    self.game_action_queue
                        .push_back(GameAction::AcceptTimeout(game_id));
                }

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
                let amount = my_reward_coin_string
                    .as_ref()
                    .and_then(|c| c.to_parts())
                    .map(|(_, _, amt)| amt.clone())
                    .unwrap_or_default();
                let is_slash = !old_definition.our_turn
                    && conditions
                        .iter()
                        .any(|c| matches!(c, CoinCondition::Rem(_)));
                let label = if is_slash {
                    "slash-on-chain"
                } else {
                    "timeout-on-chain"
                };
                if let Some(ref rc) = my_reward_coin_string {
                    effects.push(Effect::DebugLog(format!(
                        "[{label}] {} reward={}",
                        format_coin(coin_id),
                        format_coin(rc),
                    )));
                } else {
                    effects.push(Effect::DebugLog(format!(
                        "[{label}] {} no reward",
                        format_coin(coin_id),
                    )));
                }
                if !old_definition.notification_sent {
                    let notif = if old_definition.our_turn {
                        GameNotification::GameStatus {
                            id: old_definition.game_id,
                            status: GameStatusKind::EndedWeTimedOut,
                            my_reward: Some(amount.clone()),
                            coin_id: my_reward_coin_string.clone(),
                            reason: None,
                            other_params: None,
                        }
                    } else if is_slash {
                        GameNotification::GameStatus {
                            id: old_definition.game_id,
                            status: GameStatusKind::EndedOpponentSlashedUs,
                            my_reward: None,
                            coin_id: None,
                            reason: None,
                            other_params: None,
                        }
                    } else {
                        GameNotification::GameStatus {
                            id: old_definition.game_id,
                            status: GameStatusKind::EndedOpponentTimedOut,
                            my_reward: Some(amount.clone()),
                            coin_id: my_reward_coin_string.clone(),
                            reason: None,
                            other_params: None,
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
                state_number: _state_number,
                readable,
                mover_share,
                ..
            }) => {
                effects.push(Effect::DebugLog(format!(
                    "[move-on-chain] {} new_coin={} mover_share={mover_share}",
                    format_coin(coin_id),
                    format_coin(&new_coin_string),
                )));
                let (puzzle_hash, _amt) =
                    if let Some((orig_coin_id, ph, amt)) = new_coin_string.to_parts() {
                        game_assert_eq!(
                            coin_id.to_coin_id(),
                            orig_coin_id,
                            "coin parent mismatch in their spend"
                        );
                        (ph, amt)
                    } else {
                        return Err(Error::StrErr("bad coin explode".to_string()));
                    };

                let game_id = old_definition.game_id;
                let gt = old_definition.game_timeout.clone();
                self.game_map.insert(
                    new_coin_string.clone(),
                    OnChainGameState {
                        puzzle_hash: puzzle_hash.clone(),
                        our_turn: true,
                        ..old_definition
                    },
                );

                effects.push(Effect::Notify(GameNotification::GameStatus {
                    id: old_definition.game_id,
                    status: GameStatusKind::OnChainMyTurn,
                    my_reward: None,
                    coin_id: Some(new_coin_string.clone()),
                    reason: None,
                    other_params: Some(GameStatusOtherParams {
                        readable: None,
                        mover_share: None,
                        illegal_move_detected: None,
                        moved_by_us: None,
                    }),
                }));

                effects.push(Effect::Notify(GameNotification::GameStatus {
                    id: game_id,
                    status: GameStatusKind::MyTurn,
                    my_reward: None,
                    coin_id: None,
                    reason: None,
                    other_params: Some(GameStatusOtherParams {
                        readable: Some(readable),
                        mover_share: Some(mover_share),
                        illegal_move_detected: None,
                        moved_by_us: None,
                    }),
                }));
                effects.push(Effect::RegisterCoin {
                    coin: new_coin_string,
                    timeout: gt,
                    name: Some("coin gives my turn"),
                });

                unblock_queue = true;
            }
            CoinSpentInformation::TheirSpend(TheirTurnCoinSpentResult::Slash(outcome)) => {
                self.have_potato = PotatoState::Present;

                effects.push(Effect::DebugLog(format!(
                    "[slash-on-chain] {}",
                    format_coin(coin_id),
                )));
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
                        effects.push(Effect::Notify(GameNotification::GameStatus {
                            id: old_definition.game_id,
                            status: GameStatusKind::IllegalMoveDetected,
                            my_reward: None,
                            coin_id: Some(slash_coin.clone()),
                            reason: None,
                            other_params: Some(GameStatusOtherParams {
                                readable: None,
                                mover_share: Some(cheating_move_mover_share.clone()),
                                illegal_move_detected: Some(true),
                                moved_by_us: None,
                            }),
                        }));
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
                        effects.push(Effect::Notify(GameNotification::GameStatus {
                            id: old_definition.game_id,
                            status: GameStatusKind::IllegalMoveDetected,
                            my_reward: None,
                            coin_id: None,
                            reason: None,
                            other_params: Some(GameStatusOtherParams {
                                readable: None,
                                mover_share: None,
                                illegal_move_detected: Some(true),
                                moved_by_us: None,
                            }),
                        }));
                        if let Some(eff) = self.try_emit_terminal(
                            &old_definition.game_id,
                            GameNotification::GameStatus {
                                id: old_definition.game_id,
                                status: GameStatusKind::EndedOpponentSlashedUs,
                                my_reward: None,
                                coin_id: None,
                                reason: None,
                                other_params: None,
                            },
                        ) {
                            effects.push(eff);
                        }
                    }
                }
            }
            CoinSpentInformation::OurReward(ph, amt) => {
                let reward_coin_debug = CoinString::from_parts(&coin_id.to_coin_id(), &ph, &amt);
                effects.push(Effect::DebugLog(format!(
                    "[timeout-on-chain] {} reward={}",
                    format_coin(coin_id),
                    format_coin(&reward_coin_debug),
                )));
                if !old_definition.notification_sent {
                    let reward_coin = if amt > Amount::default() {
                        Some(CoinString::from_parts(&coin_id.to_coin_id(), &ph, &amt))
                    } else {
                        None
                    };
                    let notif = if old_definition.our_turn {
                        GameNotification::GameStatus {
                            id: old_definition.game_id,
                            status: GameStatusKind::EndedWeTimedOut,
                            my_reward: Some(amt),
                            coin_id: reward_coin,
                            reason: None,
                            other_params: None,
                        }
                    } else {
                        GameNotification::GameStatus {
                            id: old_definition.game_id,
                            status: GameStatusKind::EndedOpponentTimedOut,
                            my_reward: Some(amt),
                            coin_id: reward_coin,
                            reason: None,
                            other_params: None,
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
            effects.extend(self.next_action(env)?);
        }

        Ok((effects, resync_info))
    }

    pub fn coin_timeout_reached(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();

        if let Some(game_def) = self.game_map.remove(coin_id) {
            let initial_potato = self.is_initial_potato;
            let game_id = game_def.game_id;

            effects.push(Effect::DebugLog(format!(
                "[timeout-on-chain] {}",
                format_coin(coin_id),
            )));

            if let Some(_slash_amount) = game_def.pending_slash_amount {
                let our_reward = game_def.cheating_move_mover_share.unwrap_or_default();
                let reward_coin = if our_reward > Amount::default() {
                    let reward_ph = self.reward_puzzle_hash.clone();
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
                    GameNotification::GameStatus {
                        id: game_id,
                        status: GameStatusKind::EndedOpponentSuccessfullyCheated,
                        my_reward: Some(our_reward),
                        coin_id: reward_coin,
                        reason: None,
                        other_params: None,
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
                    &tx.puzzle.to_program(),
                    &tx.solution.p(),
                )?;

                let reward_ph = self.reward_puzzle_hash.clone();
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
                            bundle: tx.as_ref().clone(),
                        }],
                    };
                    effects.push(Effect::SpendTransaction(spend_bundle));
                }

                let notif = if game_def.our_turn || game_def.accepted {
                    GameNotification::GameStatus {
                        id: game_id,
                        status: GameStatusKind::EndedWeTimedOut,
                        my_reward: Some(our_reward),
                        coin_id: reward_coin,
                        reason: None,
                        other_params: None,
                    }
                } else {
                    GameNotification::GameStatus {
                        id: game_id,
                        status: GameStatusKind::EndedOpponentTimedOut,
                        my_reward: Some(our_reward),
                        coin_id: reward_coin,
                        reason: None,
                        other_params: None,
                    }
                };
                if let Some(eff) = self.try_emit_terminal(&game_id, notif) {
                    effects.push(eff);
                }
            } else {
                let our_turn = game_def.our_turn;
                let accepted = game_def.accepted;
                let already_notified = game_def.notification_sent;
                self.game_map.insert(coin_id.clone(), game_def);

                let result_transaction =
                    self.accept_or_timeout_game_on_chain(env, &game_id, coin_id)?;

                if let Some(game_def) = self.game_map.get_mut(coin_id) {
                    game_def.accept = AcceptTransactionState::Finished;
                    game_def.notification_sent = true;
                }

                self.have_potato = PotatoState::Present;
                let (reward_coin, our_reward) = if let Some(tx) = result_transaction {
                    self.have_potato = PotatoState::Absent;

                    let conditions = CoinCondition::from_puzzle_and_solution(
                        env.allocator,
                        &tx.puzzle.to_program(),
                        &tx.solution.p(),
                    )?;
                    let reward_ph = self.reward_puzzle_hash.clone();
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
                                bundle: tx,
                            }],
                        }));
                    }
                    (reward_coin, our_reward)
                } else {
                    (None, Amount::default())
                };

                if !already_notified {
                    let notif = if our_turn || accepted {
                        GameNotification::GameStatus {
                            id: game_id,
                            status: GameStatusKind::EndedWeTimedOut,
                            my_reward: Some(our_reward),
                            coin_id: reward_coin,
                            reason: None,
                            other_params: None,
                        }
                    } else {
                        GameNotification::GameStatus {
                            id: game_id,
                            status: GameStatusKind::EndedOpponentTimedOut,
                            my_reward: Some(our_reward),
                            coin_id: reward_coin,
                            reason: None,
                            other_params: None,
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

    pub fn next_action(&mut self, env: &mut ChannelHandlerEnv<'_>) -> Result<Vec<Effect>, Error> {
        if let Some(action) = self.game_action_queue.pop_front() {
            return self.do_on_chain_action(env, action);
        }

        Ok(Vec::new())
    }

    pub fn do_on_chain_move(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        current_coin: &CoinString,
        game_id: GameID,
        readable_move: ReadableMove,
        entropy: Hash,
    ) -> Result<Option<Effect>, Error> {
        let my_turn = self.my_move_in_game(&game_id);
        if my_turn.is_none() {
            return Ok(None);
        }
        if my_turn == Some(false) {
            self.game_action_queue
                .push_back(GameAction::Move(game_id, readable_move, entropy));
            return Ok(None);
        }

        let game_amount = self.get_game_amount(&game_id)?;
        let (pre_referee, pre_last_ph) = self.save_game_state(&game_id)?;

        let (old_ph, new_ph, _state_number, move_result, transaction) =
            self.on_chain_our_move(env, &game_id, &readable_move, entropy.clone(), current_coin)?;

        if move_result.basic.mover_share == game_amount && move_result.basic.max_move_size > 0 {
            self.restore_game_state(&game_id, pre_referee, pre_last_ph)?;
            self.game_map.retain(|_, def| def.game_id != game_id);
            return Ok(Some(Effect::Notify(GameNotification::GameStatus {
                id: game_id,
                status: GameStatusKind::EndedWeTimedOut,
                my_reward: Some(Amount::default()),
                coin_id: None,
                reason: None,
                other_params: None,
            })));
        }

        let (post_referee, post_last_ph) = self.save_game_state(&game_id)?;

        self.restore_game_state(&game_id, pre_referee, pre_last_ph.clone())?;

        if let Some((_, ph, _)) = current_coin.to_parts() {
            game_assert_eq!(
                old_ph,
                ph,
                "do_on_chain_move: pre-move puzzle hash mismatch"
            );
        }

        self.pending_moves.insert(
            current_coin.clone(),
            PendingMoveSavedState {
                expected_ph: new_ph.clone(),
                game_id,
                kind: PendingMoveKind::OurMove {
                    post_move_referee: post_referee,
                    post_move_last_ph: post_last_ph,
                },
            },
        );

        Ok(Some(Effect::SpendTransaction(SpendBundle {
            name: Some("on chain move".to_string()),
            spends: vec![CoinSpend {
                coin: current_coin.clone(),
                bundle: transaction,
            }],
        })))
    }

    pub fn do_on_chain_action(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        action: GameAction,
    ) -> Result<Vec<Effect>, Error> {
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

        match action {
            GameAction::Move(game_id, readable_move, hash) => match get_current_coin(&game_id) {
                Ok(current_coin) => {
                    if self.pending_moves.contains_key(&current_coin) {
                        self.game_action_queue.push_back(GameAction::Move(
                            game_id,
                            readable_move,
                            hash,
                        ));
                        return Ok(Vec::new());
                    }
                    Ok(self
                        .do_on_chain_move(env, &current_coin, game_id, readable_move, hash)?
                        .into_iter()
                        .collect())
                }
                Err(_) => self.next_action(env),
            },
            GameAction::Cheat(game_id, mover_share, entropy) => match get_current_coin(&game_id) {
                Ok(current_coin) => {
                    if self.pending_moves.contains_key(&current_coin) {
                        self.game_action_queue.push_back(GameAction::Cheat(
                            game_id,
                            mover_share,
                            entropy,
                        ));
                        return Ok(Vec::new());
                    }
                    let my_turn = self.my_move_in_game(&game_id);
                    if my_turn == Some(true) {
                        self.enable_cheating_for_game(&game_id, &[0x80], mover_share)?;
                        let readable_move =
                            ReadableMove::from_program(Rc::new(Program::from_bytes(&[0x80])));
                        Ok(self
                            .do_on_chain_move(env, &current_coin, game_id, readable_move, entropy)?
                            .into_iter()
                            .collect())
                    } else if my_turn.is_none() {
                        Ok(Vec::new())
                    } else {
                        self.game_action_queue.push_back(GameAction::Cheat(
                            game_id,
                            mover_share,
                            entropy,
                        ));
                        Ok(Vec::new())
                    }
                }
                Err(_) => self.next_action(env),
            },
            GameAction::AcceptTimeout(game_id) => {
                if let Ok(current_coin) = get_current_coin(&game_id) {
                    let our_share = self.get_game_our_current_share(&game_id);
                    if matches!(our_share, Ok(ref s) if *s == Amount::default()) {
                        self.game_map.remove(&current_coin);
                        return Ok(vec![Effect::Notify(GameNotification::GameStatus {
                            id: game_id,
                            status: GameStatusKind::EndedWeTimedOut,
                            my_reward: Some(Amount::default()),
                            coin_id: None,
                            reason: None,
                            other_params: None,
                        })]);
                    }
                    if let Some(def) = self.game_map.get_mut(&current_coin) {
                        def.accepted = true;
                    }
                }
                Ok(Vec::new())
            }
            GameAction::CleanShutdown => Ok(Vec::new()),
            GameAction::SendPotato => Ok(Vec::new()),
            GameAction::QueuedProposal(_, _)
            | GameAction::QueuedAcceptProposal(_)
            | GameAction::QueuedCancelProposal(_) => Ok(vec![]),
        }
    }

    // --- Peer-container-facing API ---

    pub fn has_pending_incoming(&self) -> bool {
        !self.game_action_queue.is_empty()
    }

    pub fn process_incoming_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        self.next_action(env)
    }

    pub fn make_move(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        self.do_on_chain_action(env, GameAction::Move(*id, readable.clone(), new_entropy))
    }

    pub fn accept_timeout(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        self.do_on_chain_action(env, GameAction::AcceptTimeout(*id))
    }

    pub fn cheat_game(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        mover_share: Amount,
        entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        self.do_on_chain_action(env, GameAction::Cheat(*game_id, mover_share, entropy))
    }

    pub fn coin_spent(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        let (matched, effect) = self.check_game_coin_spent(coin_id)?;
        let mut effects: Vec<Effect> = effect.into_iter().collect();
        if matched {
            effects.insert(
                0,
                Effect::DebugLog(format!(
                    "[on-chain:game-coin-spent] {}",
                    format_coin(coin_id),
                )),
            );
        } else {
            effects.push(Effect::DebugLog(format!(
                "[on-chain:coin-spent] {}",
                format_coin(coin_id),
            )));
        }
        Ok(effects)
    }

    pub fn coin_created(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        Ok(None)
    }

    pub fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        let mut effects = Vec::new();
        if let Some((p, s)) = puzzle_and_solution {
            let (game_effects, resync) = self.handle_game_coin_spent(env, coin_id, p, s)?;
            effects.extend(game_effects);
            return Ok((effects, resync));
        } else if let Some((game_id, our_turn)) = self.remove_game_coin_info(coin_id) {
            let reason = if our_turn {
                "our turn coin spent unexpectedly".to_string()
            } else {
                "opponent made impossible spend".to_string()
            };
            effects.push(Effect::DebugLog(format!(
                "[game-error] {} {reason}",
                format_coin(coin_id),
            )));
            let notification = GameNotification::GameStatus {
                id: game_id,
                status: GameStatusKind::EndedError,
                my_reward: None,
                coin_id: None,
                reason: Some(reason),
                other_params: None,
            };
            effects.push(Effect::Notify(notification));
            effects.extend(self.next_action(env)?);
            return Ok((effects, None));
        }
        Ok((effects, None))
    }
}

#[typetag::serde]
impl PeerHandler for OnChainGameHandler {
    fn has_pending_incoming(&self) -> bool {
        OnChainGameHandler::has_pending_incoming(self)
    }

    fn process_incoming_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        OnChainGameHandler::process_incoming_message(self, env)
    }

    fn received_message(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }

    fn coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        OnChainGameHandler::coin_spent(self, env, coin_id)
    }

    fn coin_timeout_reached(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        OnChainGameHandler::coin_timeout_reached(self, env, coin_id)
    }

    fn coin_created(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        OnChainGameHandler::coin_created(self, env, coin_id)
    }

    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        OnChainGameHandler::coin_puzzle_and_solution(self, env, coin_id, puzzle_and_solution)
    }

    fn make_move(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        OnChainGameHandler::make_move(self, env, id, readable, new_entropy)
    }

    fn accept_timeout(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        OnChainGameHandler::accept_timeout(self, env, id)
    }

    fn cheat_game(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        mover_share: Amount,
        entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        OnChainGameHandler::cheat_game(self, env, game_id, mover_share, entropy)
    }

    fn take_replacement(&mut self) -> Option<Box<dyn PeerHandler>> {
        None
    }

    fn channel_status_snapshot(&self) -> Option<ChannelStatusSnapshot> {
        Some(ChannelStatusSnapshot {
            state: if self.was_stale {
                ChannelState::ResolvedStale
            } else {
                ChannelState::ResolvedUnrolled
            },
            advisory: None,
            coin: self.terminal_reward_coin.clone(),
            our_balance: Some(self.my_out_of_game_balance.clone()),
            their_balance: Some(self.their_out_of_game_balance.clone()),
            game_allocated: None,
        })
    }

    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
