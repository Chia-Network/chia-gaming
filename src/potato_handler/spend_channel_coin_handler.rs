use std::collections::{HashMap, HashSet, VecDeque};

use clvmr::{run_program, NodePtr};

use serde::{Deserialize, Serialize};

use crate::channel_handler::types::{ChannelCoinSpendInfo, ChannelHandlerEnv, ReadableMove};
use crate::channel_handler::ChannelHandler;
use crate::common::types::{
    chia_dialect, Aggsig, Amount, CoinCondition, CoinSpend, CoinString, Error, GameID, Hash,
    IntoErr, Program, PuzzleHash, Spend, SpendBundle, Timeout,
};
use crate::peer_container::PeerHandler;
use crate::potato_handler::effects::{
    format_coin, CancelReason, ChannelState, ChannelStatusSnapshot, Effect, GameNotification,
    GameStatusKind, GameStatusOtherParams, ResyncInfo,
};
use crate::potato_handler::handler_base::{
    build_channel_to_unroll_bundle, classify_unroll, ChannelHandlerBase, UnrollOutcome,
};
use crate::potato_handler::on_chain::{
    OnChainGameHandler, OnChainGameHandlerArgs, PendingMoveKind, PendingMoveSavedState,
};
use crate::potato_handler::types::{GameAction, PotatoState, SpendWalletReceiver};

#[derive(Debug, Serialize, Deserialize)]
enum SpendChannelCoinState {
    ChannelSpend {
        channel_coin: CoinString,
    },
    ChannelConditions {
        channel_coin: CoinString,
    },
    UnrollTimeoutOrSpend {
        unroll_coin: CoinString,
        state_number: usize,
    },
    UnrollSpend {
        unroll_coin: CoinString,
        state_number: usize,
        reward_coin: Option<CoinString>,
    },
    UnrollConditions {
        unroll_coin: CoinString,
        state_number: usize,
    },
}

#[derive(Serialize, Deserialize)]
pub struct SpendChannelCoinHandler {
    state: SpendChannelCoinState,
    base: ChannelHandlerBase,

    advisory: Option<String>,
    was_stale: bool,
    terminal_reward_coin: Option<CoinString>,

    expected_clean_shutdown: Option<(PuzzleHash, Amount)>,

    #[serde(skip)]
    last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,

    #[serde(skip)]
    replacement: Option<Box<OnChainGameHandler>>,
}

impl std::fmt::Debug for SpendChannelCoinHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SpendChannelCoinHandler({:?})", self.state)
    }
}

impl SpendChannelCoinHandler {
    pub fn set_advisory(&mut self, advisory: Option<String>) {
        self.advisory = advisory;
    }

    pub fn new(
        channel_handler: Option<ChannelHandler>,
        channel_coin: CoinString,
        game_action_queue: VecDeque<GameAction>,
        have_potato: PotatoState,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
    ) -> Self {
        SpendChannelCoinHandler {
            state: SpendChannelCoinState::ChannelSpend { channel_coin },
            base: ChannelHandlerBase::new(
                channel_handler,
                game_action_queue,
                have_potato,
                channel_timeout,
                unroll_timeout,
            ),
            advisory: None,
            was_stale: false,
            terminal_reward_coin: None,
            expected_clean_shutdown: None,
            last_channel_coin_spend_info: None,
            replacement: None,
        }
    }

    /// Create a handler that enters at the point where the channel coin has
    /// been detected as spent but we haven't yet received the puzzle/solution.
    /// Used when PotatoHandler passively detects the channel coin spend
    /// (opponent went on-chain).
    pub fn new_at_channel_conditions(
        channel_handler: Option<ChannelHandler>,
        channel_coin: CoinString,
        game_action_queue: VecDeque<GameAction>,
        have_potato: PotatoState,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
    ) -> Self {
        SpendChannelCoinHandler {
            state: SpendChannelCoinState::ChannelConditions { channel_coin },
            base: ChannelHandlerBase::new(
                channel_handler,
                game_action_queue,
                have_potato,
                channel_timeout,
                unroll_timeout,
            ),
            advisory: None,
            was_stale: false,
            terminal_reward_coin: None,
            expected_clean_shutdown: None,
            last_channel_coin_spend_info: None,
            replacement: None,
        }
    }

    /// Create a handler for the clean shutdown path.  The handler watches the
    /// channel coin spend and checks whether the clean shutdown transaction or
    /// an unroll landed.
    pub fn new_for_clean_shutdown(
        channel_handler: Option<ChannelHandler>,
        channel_coin: CoinString,
        expected_puzzle_hash: PuzzleHash,
        expected_amount: Amount,
        game_action_queue: VecDeque<GameAction>,
        have_potato: PotatoState,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
        last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,
    ) -> Self {
        SpendChannelCoinHandler {
            state: SpendChannelCoinState::ChannelSpend { channel_coin },
            base: ChannelHandlerBase::new(
                channel_handler,
                game_action_queue,
                have_potato,
                channel_timeout,
                unroll_timeout,
            ),
            advisory: None,
            was_stale: false,
            terminal_reward_coin: None,
            expected_clean_shutdown: Some((expected_puzzle_hash, expected_amount)),
            last_channel_coin_spend_info,
            replacement: None,
        }
    }

    // --- Delegated query methods ---

    pub fn amount(&self) -> Amount {
        self.base.amount()
    }
    pub fn get_our_current_share(&self) -> Option<Amount> {
        self.base.get_our_current_share()
    }
    pub fn get_their_current_share(&self) -> Option<Amount> {
        self.base.get_their_current_share()
    }
    pub fn has_potato(&self) -> bool {
        self.base.has_potato()
    }

    pub fn get_reward_puzzle_hash(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<PuzzleHash, Error> {
        self.base.get_reward_puzzle_hash(env)
    }

    pub fn get_game_state_id(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Option<Hash>, Error> {
        self.base.get_game_state_id(env)
    }

    pub fn take_replacement(&mut self) -> Option<Box<OnChainGameHandler>> {
        self.replacement.take()
    }

    // --- Peer messages (delegated) ---

    pub fn received_message(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        self.base.received_message_passive(msg)
    }

    pub fn has_pending_incoming(&self) -> bool {
        false
    }

    pub fn process_incoming_message(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }

    // --- Game actions (parked in queue via base) ---

    pub fn make_move(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        self.base.park_move(id, readable, new_entropy);
        Ok(vec![])
    }

    pub fn accept_timeout(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        self.base.park_accept_timeout(id);
        Ok(vec![])
    }

    pub fn cheat_game(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        mover_share: Amount,
        entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        self.base.park_cheat(game_id, mover_share, entropy);
        Ok(vec![])
    }

    /// Impatience signal: broadcast our latest unroll tx while still waiting
    /// for the channel coin to be spent.  Only available when we have cached
    /// spend info (initiator-side clean shutdown that hasn't received a
    /// response yet).
    pub fn go_on_chain(&mut self, env: &mut ChannelHandlerEnv<'_>) -> Result<Vec<Effect>, Error> {
        let saved = match self.last_channel_coin_spend_info.take() {
            Some(s) => s,
            None => return Ok(vec![]),
        };
        let channel_coin = match &self.state {
            SpendChannelCoinState::ChannelSpend { channel_coin }
            | SpendChannelCoinState::ChannelConditions { channel_coin } => channel_coin.clone(),
            _ => return Ok(vec![]),
        };
        let ch = self.base.channel_handler()?;
        let bundle =
            build_channel_to_unroll_bundle(env, ch, &channel_coin, &saved, "impatience unroll")?;
        Ok(vec![Effect::SpendTransaction(bundle)])
    }

    #[cfg(test)]
    pub fn force_unroll_spend(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<SpendBundle, Error> {
        let saved = self.last_channel_coin_spend_info.as_ref().ok_or_else(|| {
            Error::StrErr("force_unroll_spend: no channel coin spend info cached".to_string())
        })?;
        let channel_coin = match &self.state {
            SpendChannelCoinState::ChannelSpend { channel_coin }
            | SpendChannelCoinState::ChannelConditions { channel_coin } => channel_coin,
            _ => {
                return Err(Error::StrErr(
                    "force_unroll_spend: not in channel-watching state".to_string(),
                ))
            }
        };
        let ch = self.base.channel_handler()?;
        build_channel_to_unroll_bundle(env, ch, channel_coin, saved, "force unroll")
    }

    // --- Coin event handlers ---

    pub fn coin_spent(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();

        match &self.state {
            SpendChannelCoinState::ChannelSpend { channel_coin } if coin_id == channel_coin => {
                self.state = SpendChannelCoinState::ChannelConditions {
                    channel_coin: channel_coin.clone(),
                };
                effects.push(Effect::Log(format!(
                    "[spend-channel:channel-coin-spent] {}",
                    format_coin(coin_id)
                )));
                effects.push(Effect::RequestPuzzleAndSolution(coin_id.clone()));
                return Ok(effects);
            }
            SpendChannelCoinState::UnrollSpend {
                unroll_coin,
                state_number,
                ..
            } if coin_id == unroll_coin => {
                self.state = SpendChannelCoinState::UnrollConditions {
                    unroll_coin: unroll_coin.clone(),
                    state_number: *state_number,
                };
                effects.push(Effect::Log(format!(
                    "[spend-channel:unroll-coin-spent] {}",
                    format_coin(coin_id)
                )));
                effects.push(Effect::RequestPuzzleAndSolution(coin_id.clone()));
                return Ok(effects);
            }
            SpendChannelCoinState::UnrollTimeoutOrSpend {
                unroll_coin,
                state_number,
            } if coin_id == unroll_coin => {
                self.state = SpendChannelCoinState::UnrollConditions {
                    unroll_coin: unroll_coin.clone(),
                    state_number: *state_number,
                };
                effects.push(Effect::Log(format!(
                    "[spend-channel:unroll-coin-spent] {}",
                    format_coin(coin_id)
                )));
                effects.push(Effect::RequestPuzzleAndSolution(coin_id.clone()));
                return Ok(effects);
            }
            _ => {}
        }

        effects.push(Effect::Log(format!(
            "[spend-channel:coin-spent] {}",
            format_coin(coin_id),
        )));
        Ok(effects)
    }

    pub fn coin_timeout_reached(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();

        let unroll_timed_out = match &self.state {
            SpendChannelCoinState::UnrollTimeoutOrSpend {
                unroll_coin,
                state_number,
            } if coin_id == unroll_coin => Some(*state_number),
            SpendChannelCoinState::UnrollSpend {
                unroll_coin,
                state_number,
                ..
            } if coin_id == unroll_coin => Some(*state_number),
            _ => None,
        };

        if let Some(on_chain_state) = unroll_timed_out {
            effects.push(Effect::Log(format!(
                "[unroll-timeout] state={on_chain_state}",
            )));
            match self.do_unroll_spend_to_games(env, coin_id, on_chain_state) {
                Ok(effect) => {
                    effects.extend(effect);
                }
                Err(e) => {
                    let reason = format!("timeout unroll failed for state {on_chain_state}: {e:?}");
                    effects.push(Effect::Log(format!("[unroll-error] {reason}")));
                    effects.extend(self.base.emit_failure_cleanup());
                    self.advisory = Some(reason);
                    self.transition_to_failed_terminal();
                }
            }
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

        match &self.state {
            SpendChannelCoinState::ChannelConditions { channel_coin }
                if *coin_id == *channel_coin =>
            {
                match self.handle_channel_coin_spent(env, coin_id, puzzle_and_solution) {
                    Ok(effect) => effects.extend(effect),
                    Err(e) => {
                        let reason = format!("channel coin spent to non-unroll: {e:?}");
                        effects.push(Effect::Log(format!("[channel-error] {reason}")));
                        effects.extend(self.base.emit_failure_cleanup());
                        self.advisory = Some(reason);
                        self.transition_to_failed_terminal();
                    }
                }
                return Ok((effects, None));
            }
            SpendChannelCoinState::UnrollSpend {
                unroll_coin,
                state_number,
                ..
            } if *coin_id == *unroll_coin => {
                match self.finish_on_chain_transition(
                    env,
                    coin_id,
                    puzzle_and_solution,
                    *state_number,
                ) {
                    Ok(transition_effects) => effects.extend(transition_effects),
                    Err(e) => {
                        let reason = format!("unroll coin spent with unexpected state: {e:?}");
                        effects.push(Effect::Log(format!("[unroll-error] {reason}")));
                        effects.extend(self.base.emit_failure_cleanup());
                        self.advisory = Some(reason);
                        self.transition_to_failed_terminal();
                    }
                }
                return Ok((effects, None));
            }
            SpendChannelCoinState::UnrollConditions {
                unroll_coin,
                state_number,
            } if *coin_id == *unroll_coin => {
                let sn = *state_number;
                match self.finish_on_chain_transition(env, coin_id, puzzle_and_solution, sn) {
                    Ok(transition_effects) => effects.extend(transition_effects),
                    Err(e) => {
                        let reason = format!("unroll coin spent with unexpected state: {e:?}");
                        effects.push(Effect::Log(format!("[unroll-error] {reason}")));
                        effects.extend(self.base.emit_failure_cleanup());
                        self.advisory = Some(reason);
                        self.transition_to_failed_terminal();
                    }
                }
                return Ok((effects, None));
            }
            _ => {}
        }

        Ok((effects, None))
    }

    // --- Internal methods ---

    /// Create a terminal OnChainGameHandler replacement with an empty game map
    /// to represent a failed channel.
    fn transition_to_failed_terminal(&mut self) {
        let on_chain = OnChainGameHandler::new_terminal(
            self.base.channel_handler.as_mut(),
            self.was_stale,
            false,
            self.terminal_reward_coin.clone(),
            self.advisory.clone(),
        );
        self.replacement = Some(Box::new(on_chain));
    }

    /// Create a terminal OnChainGameHandler replacement with an empty game map
    /// to represent a completed channel (clean shutdown or no-game unroll).
    fn transition_to_completed_terminal(&mut self, resolved_clean: bool) {
        let on_chain = OnChainGameHandler::new_terminal(
            self.base.channel_handler.as_mut(),
            self.was_stale,
            resolved_clean,
            self.terminal_reward_coin.clone(),
            None,
        );
        self.replacement = Some(Box::new(on_chain));
    }

    fn do_unroll_spend_to_games(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        unroll_coin: &CoinString,
        on_chain_state: usize,
    ) -> Result<Vec<Effect>, Error> {
        let spend_bundle = {
            let player_ch = self.base.channel_handler()?;
            let matching_unroll = player_ch.get_unroll_for_state(on_chain_state)?;
            let curried_unroll_puzzle = matching_unroll
                .coin
                .make_curried_unroll_puzzle(env, &player_ch.get_aggregate_unroll_public_key())?;
            let curried_unroll_program =
                crate::common::types::Puzzle::from_nodeptr(env.allocator, curried_unroll_puzzle)?;
            let timeout_solution = matching_unroll.coin.make_timeout_unroll_solution(env)?;
            let timeout_solution_program = Program::from_nodeptr(env.allocator, timeout_solution)?;

            eprintln!(
                "[sig-diag] do_unroll_spend_to_games state={} sig=identity_point (no AGG_SIG required)",
                on_chain_state,
            );

            SpendBundle {
                name: Some("create unroll (timeout)".to_string()),
                spends: vec![CoinSpend {
                    bundle: Spend {
                        puzzle: curried_unroll_program,
                        solution: timeout_solution_program.into(),
                        signature: Aggsig::default(),
                    },
                    coin: unroll_coin.clone(),
                }],
            }
        };

        self.state = SpendChannelCoinState::UnrollSpend {
            unroll_coin: unroll_coin.clone(),
            state_number: on_chain_state,
            reward_coin: None,
        };

        Ok(vec![
            Effect::Log(format!(
                "[sig-diag] timeout spend bundle: state={on_chain_state} sig=identity_point"
            )),
            Effect::SpendTransaction(spend_bundle),
        ])
    }

    fn handle_channel_coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<Vec<Effect>, Error> {
        let (puzzle, solution) = puzzle_and_solution.ok_or_else(|| {
            Error::StrErr("Retrieve of puzzle and solution failed for channel coin".to_string())
        })?;

        let mut effects = Vec::new();

        let run_puzzle = puzzle.to_nodeptr(env.allocator)?;
        let run_args = solution.to_nodeptr(env.allocator)?;
        let conditions_result = run_program(
            env.allocator.allocator(),
            &chia_dialect(),
            run_puzzle,
            run_args,
            0,
        )
        .into_gen()?;
        let conditions_nodeptr = conditions_result.1;

        let channel_conditions = CoinCondition::from_nodeptr(env.allocator, conditions_nodeptr);

        // Check if clean shutdown transaction landed (change coin with expected
        // puzzle hash and amount present in the conditions).
        if let Some((ref expected_ph, ref expected_amt)) = self.expected_clean_shutdown {
            let is_clean = if *expected_amt > Amount::default() {
                channel_conditions.iter().any(|c| {
                    matches!(c, CoinCondition::CreateCoin(ph, amt) if *ph == *expected_ph && *amt == *expected_amt)
                })
            } else {
                !channel_conditions
                    .iter()
                    .any(|c| matches!(c, CoinCondition::Rem(_)))
            };

            if is_clean {
                effects.push(Effect::Log("[clean-end] clean shutdown landed".to_string()));
                {
                    let ch = self.base.channel_handler_mut()?;
                    for (id, amount, game_finished) in ch.drain_cached_accept_timeouts() {
                        let finished_params = if game_finished {
                            Some(GameStatusOtherParams {
                                game_finished: Some(true),
                                ..Default::default()
                            })
                        } else {
                            None
                        };
                        effects.push(Effect::Notify(GameNotification::GameStatus {
                            id,
                            status: GameStatusKind::EndedWeTimedOut,
                            my_reward: Some(amount),
                            coin_id: None,
                            reason: None,
                            other_params: finished_params,
                        }));
                    }
                }
                self.transition_to_completed_terminal(true);
                return Ok(effects);
            }
        }

        // Not a clean shutdown — an unroll landed.  Find the unroll coin.
        let unroll_coin = channel_conditions
            .iter()
            .find_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    let created = CoinString::from_parts(&coin_id.to_coin_id(), ph, amt);
                    return Some(created);
                }
                None
            })
            .ok_or_else(|| {
                Error::StrErr("channel conditions didn't include a coin creation".to_string())
            })?;

        {
            let ch = self.base.channel_handler_mut()?;
            let cancelled_ids = ch.cancel_all_proposals();
            for id in cancelled_ids {
                effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                    id,
                    reason: CancelReason::WentOnChain,
                }));
            }
        }

        effects.extend(self.handle_unroll_from_channel_conditions(
            env,
            conditions_nodeptr,
            &unroll_coin,
        )?);

        Ok(effects)
    }

    fn handle_unroll_from_channel_conditions(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        conditions_nodeptr: NodePtr,
        unroll_coin: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();

        let on_chain_state = {
            let player_ch = self.base.channel_handler()?;
            player_ch.unrolling_state_from_conditions(env, conditions_nodeptr)?
        };

        let outcome = {
            let player_ch = self.base.channel_handler()?;
            classify_unroll(
                player_ch,
                env,
                conditions_nodeptr,
                unroll_coin,
                on_chain_state,
            )?
        };

        effects.push(Effect::Log(format!(
            "[unroll-started] {} state={on_chain_state}",
            format_coin(unroll_coin),
        )));

        match outcome {
            UnrollOutcome::Preempted(bundle) => {
                let sig_hex = bundle
                    .spends
                    .first()
                    .map(|s| hex::encode(s.bundle.signature.bytes()))
                    .unwrap_or_default();
                effects.push(Effect::Log(format!(
                    "[sig-diag] preempt spend: state={on_chain_state} agg_sig={sig_hex}",
                )));
                effects.push(Effect::SpendTransaction(bundle));
                effects.push(Effect::Log(format!(
                    "[unroll-preempt] state={on_chain_state}",
                )));
                self.state = SpendChannelCoinState::UnrollSpend {
                    unroll_coin: unroll_coin.clone(),
                    state_number: on_chain_state,
                    reward_coin: None,
                };
                effects.push(Effect::RegisterCoin {
                    coin: unroll_coin.clone(),
                    timeout: self.base.unroll_timeout.clone(),
                    name: Some("unroll"),
                });
            }
            UnrollOutcome::WaitForTimeout => {
                self.state = SpendChannelCoinState::UnrollTimeoutOrSpend {
                    unroll_coin: unroll_coin.clone(),
                    state_number: on_chain_state,
                };
                effects.push(Effect::RegisterCoin {
                    coin: unroll_coin.clone(),
                    timeout: self.base.unroll_timeout.clone(),
                    name: Some("unroll"),
                });
            }
            UnrollOutcome::Unrecoverable(reason) => {
                effects.push(Effect::Log(format!("[unroll-error] {reason}",)));
                effects.extend(self.base.emit_failure_cleanup());
                self.advisory = Some(reason);
                self.transition_to_failed_terminal();
            }
        }

        Ok(effects)
    }

    fn finish_on_chain_transition(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        unroll_coin: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
        on_chain_state: usize,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        let (puzzle, solution) = puzzle_and_solution
            .ok_or_else(|| Error::StrErr("no conditions for unroll coin".to_string()))?;

        let (mut game_map, on_chain_reward_coin, preempt_resolved) = {
            let player_ch = self.base.channel_handler_mut()?;

            let mut pre_game_ids: HashSet<GameID> = player_ch.live_game_ids().into_iter().collect();
            let in_flight_proposal_ids: HashSet<GameID> = player_ch
                .pending_proposal_accept_game_ids()
                .into_iter()
                .collect();
            pre_game_ids.extend(in_flight_proposal_ids.iter().cloned());

            let conditions =
                CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;

            let reward_puzzle_hash = player_ch.get_reward_puzzle_hash(env)?;
            let their_reward_puzzle_hash = player_ch.get_opponent_reward_puzzle_hash();
            let unroll_coin_id = unroll_coin.to_coin_id();
            let reward_coin = conditions.iter().find_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    if *ph == reward_puzzle_hash && *amt > Amount::default() {
                        return Some(CoinString::from_parts(&unroll_coin_id, ph, amt));
                    }
                }
                None
            });
            let is_stale = player_ch
                .timeout_state_number()
                .is_some_and(|t| on_chain_state + 1 < t);

            let created_coins: Vec<(PuzzleHash, Amount)> = conditions
                .iter()
                .filter_map(|c| {
                    if let CoinCondition::CreateCoin(ph, amt) = c {
                        if *amt > Amount::default()
                            && *ph != reward_puzzle_hash
                            && *ph != their_reward_puzzle_hash
                        {
                            return Some((ph.clone(), amt.clone()));
                        }
                    }
                    None
                })
                .collect();

            if is_stale {
                self.was_stale = true;
            }

            let game_map_inner = player_ch.set_state_for_coins(env, unroll_coin, &created_coins)?;

            let surviving_ids: HashSet<GameID> =
                game_map_inner.values().map(|def| def.game_id).collect();
            for missing_id in pre_game_ids.difference(&surviving_ids) {
                if in_flight_proposal_ids.contains(missing_id) {
                    effects.push(Effect::Notify(GameNotification::GameStatus {
                        id: *missing_id,
                        status: GameStatusKind::EndedCancelled,
                        my_reward: None,
                        coin_id: None,
                        reason: None,
                        other_params: None,
                    }));
                } else {
                    let reason = if is_stale {
                        "live game absent from stale unroll"
                    } else {
                        "live game absent from unroll"
                    };
                    effects.push(Effect::Notify(GameNotification::GameStatus {
                        id: *missing_id,
                        status: GameStatusKind::EndedError,
                        my_reward: None,
                        coin_id: None,
                        reason: Some(reason.to_string()),
                        other_params: None,
                    }));
                }
            }

            let preempt_resolved = player_ch.drain_preempt_resolved_accept_timeouts(&surviving_ids);

            (game_map_inner, reward_coin, preempt_resolved)
        };

        self.terminal_reward_coin = on_chain_reward_coin.clone();

        for (game_id, our_share, _game_finished) in &preempt_resolved {
            effects.push(Effect::Notify(GameNotification::GameStatus {
                id: *game_id,
                status: GameStatusKind::EndedWeTimedOut,
                my_reward: Some(our_share.clone()),
                coin_id: on_chain_reward_coin.clone(),
                reason: Some("preempt resolved: game accepted off-chain before unroll".to_string()),
                other_params: None,
            }));
        }

        if game_map.is_empty() {
            let resolved_clean = self.is_clean_shutdown_from_reward(&on_chain_reward_coin);
            self.transition_to_completed_terminal(resolved_clean);
            return Ok(effects);
        }

        // Zero-reward early-out
        {
            let player_ch = self.base.channel_handler_mut()?;
            let mut zero_reward_games = Vec::new();
            for (coin, state) in game_map.iter() {
                let dominated = if state.accepted {
                    player_ch
                        .get_game_our_current_share(&state.game_id)
                        .map(|s| s == Amount::default())
                        .unwrap_or(false)
                } else if !state.our_turn {
                    player_ch
                        .get_game_our_current_share(&state.game_id)
                        .map(|s| s == Amount::default())
                        .unwrap_or(false)
                } else {
                    player_ch.is_redo_zero_reward(coin, &state.game_id)
                };
                if dominated {
                    zero_reward_games.push((
                        coin.clone(),
                        state.game_id,
                        state.game_finished,
                        state.our_turn,
                        state.accepted,
                    ));
                }
            }
            for (coin, game_id, game_finished, our_turn, accepted) in &zero_reward_games {
                game_map.remove(coin);
                let finished_params = if *game_finished {
                    Some(GameStatusOtherParams {
                        game_finished: Some(true),
                        ..Default::default()
                    })
                } else {
                    None
                };
                let (status, reason) = if *our_turn || *accepted {
                    (
                        GameStatusKind::EndedWeTimedOut,
                        if *accepted {
                            "zero reward: game was accepted but our share is zero"
                        } else {
                            "zero reward: our replayed move yields nothing"
                        },
                    )
                } else {
                    (
                        GameStatusKind::EndedOpponentTimedOut,
                        "zero reward: opponent's turn and our share is zero",
                    )
                };
                effects.push(Effect::Notify(GameNotification::GameStatus {
                    id: *game_id,
                    status,
                    my_reward: Some(Amount::default()),
                    coin_id: None,
                    reason: Some(reason.to_string()),
                    other_params: finished_params,
                }));
            }
        }

        if game_map.is_empty() {
            let resolved_clean = self.is_clean_shutdown_from_reward(&on_chain_reward_coin);
            self.transition_to_completed_terminal(resolved_clean);
            return Ok(effects);
        }

        let replaying_ids: HashSet<GameID> = {
            let player_ch = self.base.channel_handler()?;
            game_map
                .iter()
                .filter_map(|(coin, state)| {
                    if state.our_turn && player_ch.has_redo_for_game_coin(coin, &state.game_id) {
                        Some(state.game_id)
                    } else {
                        None
                    }
                })
                .collect()
        };

        for (coin, state) in game_map.iter() {
            effects.push(Effect::Notify(GameNotification::GameStatus {
                id: state.game_id,
                status: if replaying_ids.contains(&state.game_id) {
                    GameStatusKind::Replaying
                } else if state.our_turn {
                    GameStatusKind::OnChainMyTurn
                } else {
                    GameStatusKind::OnChainTheirTurn
                },
                my_reward: None,
                coin_id: Some(coin.clone()),
                reason: None,
                other_params: None,
            }));
            effects.push(Effect::RegisterCoin {
                coin: coin.clone(),
                timeout: state.game_timeout.clone(),
                name: Some("game coin"),
            });
        }

        let mut pending_moves: HashMap<CoinString, PendingMoveSavedState> = HashMap::new();
        {
            let redo_candidates: Vec<(CoinString, GameID)> = game_map
                .iter()
                .filter(|(_, state)| state.our_turn)
                .map(|(coin, state)| (coin.clone(), state.game_id))
                .collect();

            let player_ch = self.base.channel_handler_mut()?;
            for (coin, game_id) in redo_candidates {
                let cached_move = match player_ch.take_cached_move_for_game(&game_id) {
                    Some(m) => m,
                    None => continue,
                };

                let saved_referee = cached_move
                    .saved_post_move_referee
                    .clone()
                    .ok_or_else(|| Error::StrErr("redo: no saved post-move referee".to_string()))?;
                let saved_ph = cached_move
                    .saved_post_move_last_ph
                    .clone()
                    .ok_or_else(|| Error::StrErr("redo: no saved post-move last_ph".to_string()))?;

                let (pre_referee, pre_last_ph) = player_ch.save_game_state(&game_id)?;
                player_ch.restore_game_state(&game_id, saved_referee, saved_ph)?;

                let transaction =
                    player_ch.get_transaction_for_game_move(env.allocator, &game_id, &coin)?;
                let new_ph = player_ch.get_game_outcome_puzzle_hash(env, &game_id)?;
                let (post_referee, post_last_ph) = player_ch.save_game_state(&game_id)?;

                player_ch.restore_game_state(&game_id, pre_referee, pre_last_ph)?;

                pending_moves.insert(
                    coin.clone(),
                    PendingMoveSavedState {
                        expected_ph: new_ph,
                        game_id,
                        kind: PendingMoveKind::OurMove {
                            post_move_referee: post_referee,
                            post_move_last_ph: post_last_ph,
                        },
                    },
                );

                effects.push(Effect::SpendTransaction(SpendBundle {
                    name: Some("on chain redo move".to_string()),
                    spends: vec![CoinSpend {
                        coin: coin.clone(),
                        bundle: transaction,
                    }],
                }));
            }
        }

        let mut on_chain_queue = VecDeque::new();
        while let Some(action) = self.base.game_action_queue.pop_front() {
            match &action {
                GameAction::CleanShutdown => {}
                _ => on_chain_queue.push_back(action),
            }
        }

        let mut player_ch = self
            .base
            .channel_handler
            .take()
            .ok_or_else(|| Error::StrErr("no channel handler yet".to_string()))?;

        let mut on_chain = OnChainGameHandler::new(OnChainGameHandlerArgs {
            have_potato: PotatoState::Present,
            channel_timeout: self.base.channel_timeout.clone(),
            game_action_queue: on_chain_queue,
            game_map,
            pending_moves,
            private_keys: player_ch.private_keys().clone(),
            reward_puzzle_hash: player_ch.my_reward_puzzle_hash().clone(),
            their_reward_puzzle_hash: player_ch.their_reward_puzzle_hash().clone(),
            my_out_of_game_balance: player_ch.my_out_of_game_balance(),
            their_out_of_game_balance: player_ch.their_out_of_game_balance(),
            my_allocated_balance: player_ch.my_allocated_balance(),
            their_allocated_balance: player_ch.their_allocated_balance(),
            live_games: player_ch.take_live_games(),
            pending_accept_timeouts: player_ch.take_pending_accept_timeouts(),
            unroll_advance_timeout: player_ch.unroll_advance_timeout().clone(),
            is_initial_potato: player_ch.is_initial_potato(),
            state_number: player_ch.state_number(),
            was_stale: self.was_stale,
            resolved_clean: false,
            terminal_reward_coin: self.terminal_reward_coin.clone(),
        });
        effects.extend(on_chain.next_action(env)?);
        self.replacement = Some(Box::new(on_chain));

        Ok(effects)
    }

    /// Check whether the reward coin from a resolved unroll matches our
    /// expected clean shutdown parameters.
    fn is_clean_shutdown_from_reward(&self, reward_coin: &Option<CoinString>) -> bool {
        let (expected_ph, expected_amt) = match &self.expected_clean_shutdown {
            Some(pair) => pair,
            None => return false,
        };
        if *expected_amt == Amount::default() {
            return reward_coin.is_none();
        }
        if let Some(coin) = reward_coin {
            if let Some((_, ph, amt)) = coin.to_parts() {
                return ph == *expected_ph && amt == *expected_amt;
            }
        }
        false
    }
}

impl SpendWalletReceiver for SpendChannelCoinHandler {
    fn coin_created(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        SpendChannelCoinHandler::coin_created(self, env, coin_id)
    }
    fn coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinHandler::coin_spent(self, env, coin_id)
    }
    fn coin_timeout_reached(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinHandler::coin_timeout_reached(self, env, coin_id)
    }
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        SpendChannelCoinHandler::coin_puzzle_and_solution(self, env, coin_id, puzzle_and_solution)
    }
}

#[typetag::serde]
impl PeerHandler for SpendChannelCoinHandler {
    fn has_pending_incoming(&self) -> bool {
        SpendChannelCoinHandler::has_pending_incoming(self)
    }
    fn process_incoming_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinHandler::process_incoming_message(self, env)
    }
    fn received_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinHandler::received_message(self, env, msg)
    }
    fn coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinHandler::coin_spent(self, env, coin_id)
    }
    fn coin_timeout_reached(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinHandler::coin_timeout_reached(self, env, coin_id)
    }
    fn coin_created(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        SpendChannelCoinHandler::coin_created(self, env, coin_id)
    }
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        SpendChannelCoinHandler::coin_puzzle_and_solution(self, env, coin_id, puzzle_and_solution)
    }
    fn make_move(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinHandler::make_move(self, env, id, readable, new_entropy)
    }
    fn accept_timeout(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinHandler::accept_timeout(self, env, id)
    }
    fn cheat_game(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        mover_share: Amount,
        entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinHandler::cheat_game(self, env, game_id, mover_share, entropy)
    }
    fn take_replacement(&mut self) -> Option<Box<dyn PeerHandler>> {
        SpendChannelCoinHandler::take_replacement(self).map(|oc| oc as Box<dyn PeerHandler>)
    }
    fn go_on_chain(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        _got_error: bool,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinHandler::go_on_chain(self, env)
    }
    fn channel_status_snapshot(&self) -> Option<ChannelStatusSnapshot> {
        let (state, coin) = match &self.state {
            SpendChannelCoinState::ChannelSpend { channel_coin }
            | SpendChannelCoinState::ChannelConditions { channel_coin } => {
                let s = if self.expected_clean_shutdown.is_some() {
                    ChannelState::ShutdownTransactionPending
                } else {
                    ChannelState::GoingOnChain
                };
                (s, Some(channel_coin.clone()))
            }
            SpendChannelCoinState::UnrollTimeoutOrSpend { unroll_coin, .. }
            | SpendChannelCoinState::UnrollSpend { unroll_coin, .. }
            | SpendChannelCoinState::UnrollConditions { unroll_coin, .. } => {
                (ChannelState::Unrolling, Some(unroll_coin.clone()))
            }
        };
        let (our_balance, their_balance, game_allocated) =
            if let Some(ch) = self.base.channel_handler.as_ref() {
                (
                    Some(ch.my_out_of_game_balance()),
                    Some(ch.their_out_of_game_balance()),
                    Some(ch.total_game_allocated()),
                )
            } else {
                (None, None, None)
            };
        Some(ChannelStatusSnapshot {
            state,
            advisory: self.advisory.clone(),
            coin,
            our_balance,
            their_balance,
            game_allocated,
            have_potato: None,
        })
    }
    fn channel_handler(&self) -> Result<&ChannelHandler, Error> {
        self.base.channel_handler()
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
