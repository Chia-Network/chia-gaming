use std::collections::{HashMap, HashSet, VecDeque};

use clvm_traits::{clvm_curried_args, ToClvm};
use clvm_utils::CurriedProgram;
use clvmr::{run_program, NodePtr};

use serde::{Deserialize, Serialize};

use crate::channel_state::types::{ChannelCoinSpendInfo, ChannelEnv, ReadableMove};
use crate::channel_state::ChannelState;
use crate::common::types::{
    chia_dialect, Aggsig, Amount, CoinCondition, CoinSpend, CoinString, Error, GameID, Hash,
    IntoErr, Program, ProgramRef, PuzzleHash, Spend, SpendBundle, Timeout, MAX_BLOCK_COST_CLVM,
};
use crate::game_session::PeerLifecyclePhase;
use crate::session_phases::effects::{
    format_coin, CancelReason, ChannelStatus, ChannelStatusSnapshot, CoinOfInterest, Effect,
    GameNotification, GameStatusKind, ResyncInfo, SettlementOutcome,
};
use crate::session_phases::handler_base::{
    build_channel_to_unroll_bundle, classify_unroll, ChannelStateBase, UnrollOutcome,
};
use crate::session_phases::on_chain::{
    OnChainPhase, OnChainPhaseArgs, PendingMoveKind, PendingMoveSavedState,
};
use crate::session_phases::types::{GameAction, PotatoState, SpendWalletReceiver};

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
pub struct SpendChannelCoinPhase {
    state: SpendChannelCoinState,
    base: ChannelStateBase,

    advisory: Option<String>,
    was_stale: bool,
    terminal_reward_coin: Option<CoinString>,

    expected_clean_shutdown_solution: Option<ProgramRef>,

    last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,

    #[serde(skip)]
    replacement: Option<Box<OnChainPhase>>,
}

impl std::fmt::Debug for SpendChannelCoinPhase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "SpendChannelCoinPhase({:?})", self.state)
    }
}

impl SpendChannelCoinPhase {
    pub fn set_advisory(&mut self, advisory: Option<String>) {
        self.advisory = advisory;
    }

    pub fn new(
        channel_state: Option<ChannelState>,
        channel_coin: CoinString,
        game_action_queue: VecDeque<GameAction>,
        have_potato: PotatoState,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
        last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,
    ) -> Self {
        SpendChannelCoinPhase {
            state: SpendChannelCoinState::ChannelSpend { channel_coin },
            base: ChannelStateBase::new(
                channel_state,
                game_action_queue,
                have_potato,
                channel_timeout,
                unroll_timeout,
            ),
            advisory: None,
            was_stale: false,
            terminal_reward_coin: None,
            expected_clean_shutdown_solution: None,
            last_channel_coin_spend_info,
            replacement: None,
        }
    }

    /// Create a handler that enters at the point where the channel coin has
    /// been detected as spent but we haven't yet received the puzzle/solution.
    /// Used when OffChainPhase passively detects the channel coin spend
    /// (opponent went on-chain).
    pub fn new_at_channel_conditions(
        channel_state: Option<ChannelState>,
        channel_coin: CoinString,
        game_action_queue: VecDeque<GameAction>,
        have_potato: PotatoState,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
        expected_clean_shutdown_solution: Option<ProgramRef>,
    ) -> Self {
        SpendChannelCoinPhase {
            state: SpendChannelCoinState::ChannelConditions { channel_coin },
            base: ChannelStateBase::new(
                channel_state,
                game_action_queue,
                have_potato,
                channel_timeout,
                unroll_timeout,
            ),
            advisory: None,
            was_stale: false,
            terminal_reward_coin: None,
            expected_clean_shutdown_solution,
            last_channel_coin_spend_info: None,
            replacement: None,
        }
    }

    /// Create a handler for the clean shutdown path.  The handler watches the
    /// channel coin spend and checks whether the clean shutdown transaction
    /// or an unroll landed.  We store the exact solution we expect on-chain so
    /// detection is a direct comparison.
    pub fn new_for_clean_shutdown(
        channel_state: Option<ChannelState>,
        channel_coin: CoinString,
        clean_shutdown_solution: ProgramRef,
        game_action_queue: VecDeque<GameAction>,
        have_potato: PotatoState,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
        last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,
    ) -> Self {
        SpendChannelCoinPhase {
            state: SpendChannelCoinState::ChannelSpend { channel_coin },
            base: ChannelStateBase::new(
                channel_state,
                game_action_queue,
                have_potato,
                channel_timeout,
                unroll_timeout,
            ),
            advisory: None,
            was_stale: false,
            terminal_reward_coin: None,
            expected_clean_shutdown_solution: Some(clean_shutdown_solution),
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

    pub fn get_reward_puzzle_hash(&self, env: &mut ChannelEnv<'_>) -> Result<PuzzleHash, Error> {
        self.base.get_reward_puzzle_hash(env)
    }

    pub fn get_game_state_id(&mut self, env: &mut ChannelEnv<'_>) -> Result<Option<Hash>, Error> {
        self.base.get_game_state_id(env)
    }

    pub fn take_next_phase(&mut self) -> Option<Box<OnChainPhase>> {
        self.replacement.take()
    }

    // --- Peer messages (delegated) ---

    pub fn received_message(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        self.base.received_message_passive(msg)
    }

    pub fn has_queued_message(&self) -> bool {
        false
    }

    pub fn process_queued_message(
        &mut self,
        _env: &mut ChannelEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }

    // --- Game actions (parked in queue via base) ---

    pub fn make_move(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        self.base.park_move(id, readable, new_entropy);
        Ok(vec![])
    }

    pub fn accept_settlement(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        self.base.park_accept_settlement(id);
        Ok(vec![])
    }

    pub fn cheat_game(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        game_id: &GameID,
        mover_share: Amount,
        entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        self.base.park_cheat(game_id, mover_share, entropy);
        Ok(vec![])
    }

    /// Impatience signal: broadcast our latest unroll tx while still waiting
    /// for the channel coin to be spent.  Only available when we have cached
    /// spend info and are still watching the channel coin. Otherwise this is a
    /// no-op (already past channel watch, or opponent-led with no cache).
    pub fn go_on_chain(&mut self, env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error> {
        let channel_coin = match &self.state {
            SpendChannelCoinState::ChannelSpend { channel_coin }
            | SpendChannelCoinState::ChannelConditions { channel_coin } => channel_coin.clone(),
            _ => return Ok(vec![]),
        };
        let Some(saved) = self.last_channel_coin_spend_info.take() else {
            return Ok(vec![]);
        };
        let ch = self.base.channel_state()?;
        let bundle =
            build_channel_to_unroll_bundle(env, ch, &channel_coin, &saved, "impatience unroll")?;
        Ok(vec![Effect::SpendTransaction(bundle, None)])
    }

    #[cfg(test)]
    pub fn force_unroll_spend(&self, env: &mut ChannelEnv<'_>) -> Result<SpendBundle, Error> {
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
        let ch = self.base.channel_state()?;
        build_channel_to_unroll_bundle(env, ch, channel_coin, saved, "force unroll")
    }

    // --- Coin event handlers ---

    pub fn coin_spent(
        &mut self,
        _env: &mut ChannelEnv<'_>,
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

    pub fn coin_created(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        Ok(None)
    }

    pub fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelEnv<'_>,
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
                        self.transition_to_failed_terminal()?;
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
                        self.transition_to_failed_terminal()?;
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
                        self.transition_to_failed_terminal()?;
                    }
                }
                return Ok((effects, None));
            }
            _ => {}
        }

        Ok((effects, None))
    }

    // --- Internal methods ---

    /// Create a terminal OnChainPhase replacement with an empty game map
    /// to represent a failed channel.
    fn transition_to_failed_terminal(&mut self) -> Result<(), Error> {
        let ch = self.base.channel_state.as_mut().ok_or_else(|| {
            Error::StrErr(
                "transition_to_failed_terminal: channel_state required".to_string(),
            )
        })?;
        let on_chain = OnChainPhase::new_terminal(
            ch,
            self.was_stale,
            false,
            self.terminal_reward_coin.clone(),
            self.advisory.clone(),
        );
        self.replacement = Some(Box::new(on_chain));
        Ok(())
    }

    /// Create a terminal OnChainPhase replacement with an empty game map
    /// to represent a completed channel (clean shutdown or no-game unroll).
    fn transition_to_completed_terminal(&mut self, resolved_clean: bool) -> Result<(), Error> {
        let ch = self.base.channel_state.as_mut().ok_or_else(|| {
            Error::StrErr(
                "transition_to_completed_terminal: channel_state required".to_string(),
            )
        })?;
        let on_chain = OnChainPhase::new_terminal(
            ch,
            self.was_stale,
            resolved_clean,
            self.terminal_reward_coin.clone(),
            None,
        );
        self.replacement = Some(Box::new(on_chain));
        Ok(())
    }

    /// Build the unroll-via-timeout spend for `unroll_coin` at `on_chain_state`.
    /// Pure: does not mutate handler state or submit.  The transaction manager
    /// holds the returned bundle and submits it once the unroll coin reaches its
    /// relative timeout age (and resubmits it across reorgs).
    fn build_unroll_timeout_spend(
        &self,
        env: &mut ChannelEnv<'_>,
        unroll_coin: &CoinString,
        on_chain_state: usize,
    ) -> Result<SpendBundle, Error> {
        let player_ch = self.base.channel_state()?;
        let matching_unroll = player_ch.get_historical_unroll_for_state(on_chain_state)?;
        let curried_unroll_puzzle = CurriedProgram {
            program: env.unroll_puzzle.clone(),
            args: clvm_curried_args!(
                player_ch.get_aggregate_unroll_public_key(),
                matching_unroll.state_number,
                matching_unroll.conditions_hash.clone()
            ),
        }
        .to_clvm(env.allocator)
        .into_gen()?;
        let curried_unroll_program =
            crate::common::types::Puzzle::from_nodeptr(env.allocator, curried_unroll_puzzle)?;
        let timeout_solution = matching_unroll
            .timeout_conditions
            .to_nodeptr(env.allocator)?;
        let timeout_solution_program = Program::from_nodeptr(env.allocator, timeout_solution)?;

        Ok(SpendBundle {
            name: Some("create unroll (timeout)".to_string()),
            spends: vec![CoinSpend {
                bundle: Spend {
                    puzzle: curried_unroll_program,
                    solution: timeout_solution_program.into(),
                    signature: Aggsig::default(),
                },
                coin: unroll_coin.clone(),
            }],
        })
    }

    fn handle_channel_coin_spent(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<Vec<Effect>, Error> {
        let (puzzle, solution) = puzzle_and_solution.ok_or_else(|| {
            Error::StrErr("Retrieve of puzzle and solution failed for channel coin".to_string())
        })?;

        let mut effects = Vec::new();

        // Clean shutdown detection: compare the on-chain solution directly
        // to the one we co-signed.
        if let Some(ref expected_solution) = self.expected_clean_shutdown_solution {
            if *solution == *expected_solution.pref() {
                effects.push(Effect::Log("[clean-end] clean shutdown landed".to_string()));
                {
                    let ch = self.base.channel_state_mut()?;
                    for (id, amount, _game_finished) in ch.drain_cached_accept_settlements() {
                        effects.push(Effect::Notify(GameNotification::game_settled(
                            id,
                            SettlementOutcome::AcceptSettlement,
                            amount,
                            None,
                        )));
                    }
                }
                // Record the change coin we receive so the resolved coin id
                // stays visible in the protocol-state pretty-print (it flows
                // into the terminal OnChainPhase's terminal_reward_coin).
                self.terminal_reward_coin = {
                    let conditions =
                        CoinCondition::from_puzzle_and_solution(env.allocator, puzzle, solution)?;
                    let player_ch = self.base.channel_state()?;
                    let reward_puzzle_hash = player_ch.get_reward_puzzle_hash(env)?;
                    let channel_coin_id = coin_id.to_coin_id();
                    conditions.iter().find_map(|c| {
                        if let CoinCondition::CreateCoin(ph, amt) = c {
                            if *ph == reward_puzzle_hash && *amt > Amount::default() {
                                return Some(CoinString::from_parts(&channel_coin_id, ph, amt));
                            }
                        }
                        None
                    })
                };
                self.transition_to_completed_terminal(true)?;
                return Ok(effects);
            }
        }

        let run_puzzle = puzzle.to_nodeptr(env.allocator)?;
        let run_args = solution.to_nodeptr(env.allocator)?;
        let conditions_result = run_program(
            env.allocator.allocator(),
            &chia_dialect(),
            run_puzzle,
            run_args,
            MAX_BLOCK_COST_CLVM,
        )
        .into_gen()?;
        let conditions_nodeptr = conditions_result.1;

        // Not a clean shutdown — an unroll landed.  Find the unroll coin
        // by matching its puzzle hash against our known unroll puzzle hashes.
        let channel_conditions = CoinCondition::from_nodeptr(env.allocator, conditions_nodeptr)?;
        let unroll_coin = {
            let ch = self.base.channel_state()?;
            let map = ch.unroll_puzzle_hash_map();

            channel_conditions.iter().find_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    if map.contains_key(ph) {
                        return Some(CoinString::from_parts(&coin_id.to_coin_id(), ph, amt));
                    }
                }
                None
            })
        };

        let unroll_coin = match unroll_coin {
            Some(c) => c,
            None => {
                return Err(Error::StrErr(
                    "No CREATE_COIN in channel spend matches a known unroll puzzle hash"
                        .to_string(),
                ));
            }
        };

        {
            let ch = self.base.channel_state_mut()?;
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
        env: &mut ChannelEnv<'_>,
        conditions_nodeptr: NodePtr,
        unroll_coin: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();

        let on_chain_state = {
            let player_ch = self.base.channel_state()?;
            let (state_number, _) =
                player_ch.resolve_unroll_from_conditions(env, conditions_nodeptr)?;
            state_number
        };

        let outcome = {
            let player_ch = self.base.channel_state()?;
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
                effects.push(Effect::SpendTransaction(bundle, None));
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
                    spend: None,
                });
            }
            UnrollOutcome::WaitForTimeout => {
                // Build the unroll-via-timeout claim up front and hand it to the
                // transaction manager, which submits it once the unroll coin
                // reaches its relative timeout age (and resubmits across reorgs).
                // We stay in UnrollTimeoutOrSpend until the coin is actually
                // spent; `coin_spent` then drives the confirmation path.
                match self.build_unroll_timeout_spend(env, unroll_coin, on_chain_state) {
                    Ok(spend) => {
                        self.state = SpendChannelCoinState::UnrollTimeoutOrSpend {
                            unroll_coin: unroll_coin.clone(),
                            state_number: on_chain_state,
                        };
                        effects.push(Effect::RegisterCoin {
                            coin: unroll_coin.clone(),
                            timeout: self.base.unroll_timeout.clone(),
                            name: Some("unroll"),
                            spend: Some(spend),
                        });
                    }
                    Err(e) => {
                        let reason = format!(
                            "timeout unroll build failed for state {on_chain_state}: {e:?}"
                        );
                        effects.push(Effect::Log(format!("[unroll-error] {reason}")));
                        effects.extend(self.base.emit_failure_cleanup());
                        self.advisory = Some(reason);
                        self.transition_to_failed_terminal()?;
                    }
                }
            }
            UnrollOutcome::Unrecoverable(reason) => {
                effects.push(Effect::Log(format!("[unroll-error] {reason}",)));
                effects.extend(self.base.emit_failure_cleanup());
                self.advisory = Some(reason);
                self.transition_to_failed_terminal()?;
            }
        }

        Ok(effects)
    }

    fn finish_on_chain_transition(
        &mut self,
        env: &mut ChannelEnv<'_>,
        unroll_coin: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
        on_chain_state: usize,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        let (puzzle, solution) = puzzle_and_solution
            .ok_or_else(|| Error::StrErr("no conditions for unroll coin".to_string()))?;

        let (mut game_map, on_chain_reward_coin, preempt_resolved) = {
            let player_ch = self.base.channel_state_mut()?;

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

            let preempt_resolved =
                player_ch.drain_preempt_resolved_accept_settlements(&surviving_ids);

            (game_map_inner, reward_coin, preempt_resolved)
        };

        self.terminal_reward_coin = on_chain_reward_coin.clone();

        for (game_id, our_share, _game_finished) in &preempt_resolved {
            effects.push(Effect::Notify(GameNotification::game_settled(
                *game_id,
                SettlementOutcome::AcceptSettlement,
                our_share.clone(),
                on_chain_reward_coin.clone(),
            )));
        }

        if game_map.is_empty() {
            self.transition_to_completed_terminal(false)?;
            return Ok(effects);
        }

        // Zero-reward early-out. Missing local game bookkeeping (e.g. stale
        // opponent unroll) is a per-game EndedError, not "pretend valuable."
        {
            let player_ch = self.base.channel_state_mut()?;
            let mut zero_reward_games = Vec::new();
            let mut missing_games = Vec::new();
            for (coin, state) in game_map.iter() {
                if state.timeout_claim_armed || !state.our_turn {
                    match player_ch.get_game_our_current_share(&state.game_id) {
                        Ok(share) if share == Amount::default() => {
                            zero_reward_games.push((
                                coin.clone(),
                                state.game_id,
                                state.our_turn,
                                state.timeout_claim_armed,
                            ));
                        }
                        Ok(_) => {}
                        Err(_) => {
                            missing_games.push((coin.clone(), state.game_id));
                        }
                    }
                } else if player_ch.is_redo_zero_reward(&state.game_id)? {
                    zero_reward_games.push((
                        coin.clone(),
                        state.game_id,
                        state.our_turn,
                        state.timeout_claim_armed,
                    ));
                }
            }
            for (coin, game_id) in &missing_games {
                game_map.remove(coin);
                effects.push(Effect::Notify(GameNotification::GameStatus {
                    id: *game_id,
                    status: GameStatusKind::EndedError,
                    my_reward: None,
                    coin_id: Some(coin.clone()),
                    reason: Some(
                        "game absent from local state at unroll (possible stale unroll)"
                            .to_string(),
                    ),
                    other_params: None,
                }));
            }
            for (coin, game_id, our_turn, accepted) in &zero_reward_games {
                game_map.remove(coin);
                let outcome = if *accepted {
                    SettlementOutcome::ForfeitedWeAccepted
                } else if *our_turn {
                    SettlementOutcome::ForfeitedSkippedReveal
                } else {
                    SettlementOutcome::ForfeitedOpponentWon
                };
                effects.push(Effect::Notify(GameNotification::game_settled(
                    *game_id,
                    outcome,
                    Amount::default(),
                    None,
                )));
            }
        }

        if game_map.is_empty() {
            self.transition_to_completed_terminal(false)?;
            return Ok(effects);
        }

        // Match take_cached_move_for_game: Replaying iff a cached send-move
        // exists for this game id (not a puzzle-hash soft-match that can disagree).
        let replaying_ids: HashSet<GameID> = {
            let player_ch = self.base.channel_state()?;
            game_map
                .iter()
                .filter_map(|(_, state)| {
                    if state.our_turn && player_ch.has_cached_move_for_game(&state.game_id) {
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
            // The wallet registration (with the eager timeout claim) is emitted
            // below by the constructed OnChainPhase, which owns the
            // live games needed to build each claim.
        }

        let mut pending_moves: HashMap<CoinString, PendingMoveSavedState> = HashMap::new();
        {
            let redo_candidates: Vec<(CoinString, GameID)> = game_map
                .iter()
                .filter(|(_, state)| state.our_turn)
                .map(|(coin, state)| (coin.clone(), state.game_id))
                .collect();

            let player_ch = self.base.channel_state_mut()?;
            for (coin, game_id) in redo_candidates {
                let expect_redo = replaying_ids.contains(&game_id);
                let cached_move = match player_ch.take_cached_move_for_game(&game_id) {
                    Some(m) => m,
                    None if expect_redo => {
                        return Err(Error::StrErr(format!(
                            "redo: Replaying status for game {:?} but no cached move",
                            game_id
                        )));
                    }
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

                effects.push(Effect::SpendTransaction(
                    SpendBundle {
                        name: Some("on chain redo move".to_string()),
                        spends: vec![CoinSpend {
                            coin: coin.clone(),
                            bundle: transaction,
                        }],
                    },
                    None,
                ));
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
            .channel_state
            .take()
            .ok_or_else(|| Error::StrErr("no channel handler yet".to_string()))?;

        let on_chain = OnChainPhase::new(OnChainPhaseArgs {
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
            pending_settlements: player_ch.take_pending_settlements(),
            unroll_advance_timeout: player_ch.unroll_advance_timeout().clone(),
            is_initial_potato: player_ch.is_initial_potato(),
            state_number: player_ch.state_number(),
            was_stale: self.was_stale,
            resolved_clean: false,
            terminal_reward_coin: self.terminal_reward_coin.clone(),
        });
        self.replacement = Some(Box::new(on_chain));
        if let Some(on_chain) = self.replacement.as_mut() {
            effects.extend(on_chain.register_initial_game_coins(env)?);
            effects.extend(on_chain.process_queued_action(env)?);
        }

        Ok(effects)
    }
}

impl SpendWalletReceiver for SpendChannelCoinPhase {
    fn coin_created(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        SpendChannelCoinPhase::coin_created(self, env, coin_id)
    }
    fn coin_spent(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinPhase::coin_spent(self, env, coin_id)
    }
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        SpendChannelCoinPhase::coin_puzzle_and_solution(self, env, coin_id, puzzle_and_solution)
    }
}

#[typetag::serde]
impl PeerLifecyclePhase for SpendChannelCoinPhase {
    fn has_queued_message(&self) -> bool {
        SpendChannelCoinPhase::has_queued_message(self)
    }
    fn process_queued_message(&mut self, env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinPhase::process_queued_message(self, env)
    }
    fn received_message(
        &mut self,
        env: &mut ChannelEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinPhase::received_message(self, env, msg)
    }
    fn coin_spent(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinPhase::coin_spent(self, env, coin_id)
    }
    fn coin_created(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        SpendChannelCoinPhase::coin_created(self, env, coin_id)
    }
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        SpendChannelCoinPhase::coin_puzzle_and_solution(self, env, coin_id, puzzle_and_solution)
    }
    fn make_move(
        &mut self,
        env: &mut ChannelEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinPhase::make_move(self, env, id, readable, new_entropy)
    }
    fn accept_settlement(
        &mut self,
        env: &mut ChannelEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinPhase::accept_settlement(self, env, id)
    }
    fn cheat_game(
        &mut self,
        env: &mut ChannelEnv<'_>,
        game_id: &GameID,
        mover_share: Amount,
        entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinPhase::cheat_game(self, env, game_id, mover_share, entropy)
    }
    fn take_next_phase(&mut self) -> Option<Box<dyn PeerLifecyclePhase>> {
        SpendChannelCoinPhase::take_next_phase(self).map(|oc| oc as Box<dyn PeerLifecyclePhase>)
    }
    fn go_on_chain(
        &mut self,
        env: &mut ChannelEnv<'_>,
        _got_error: bool,
    ) -> Result<Vec<Effect>, Error> {
        SpendChannelCoinPhase::go_on_chain(self, env)
    }
    fn channel_status_snapshot(&self) -> Option<ChannelStatusSnapshot> {
        let (state, coin) = match &self.state {
            SpendChannelCoinState::ChannelSpend { channel_coin }
            | SpendChannelCoinState::ChannelConditions { channel_coin } => {
                let s = if self.expected_clean_shutdown_solution.is_some() {
                    ChannelStatus::ShutdownTransactionPending
                } else {
                    ChannelStatus::GoingOnChain
                };
                (s, Some(channel_coin.clone()))
            }
            SpendChannelCoinState::UnrollTimeoutOrSpend { unroll_coin, .. }
            | SpendChannelCoinState::UnrollSpend { unroll_coin, .. }
            | SpendChannelCoinState::UnrollConditions { unroll_coin, .. } => {
                (ChannelStatus::Unrolling, Some(unroll_coin.clone()))
            }
        };
        let (our_balance, their_balance, game_allocated) =
            if let Some(ch) = self.base.channel_state.as_ref() {
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
    fn coins_of_interest(&self) -> Vec<(CoinOfInterest, CoinString)> {
        let mut coins = match &self.state {
            SpendChannelCoinState::ChannelSpend { channel_coin }
            | SpendChannelCoinState::ChannelConditions { channel_coin } => {
                vec![(CoinOfInterest::Channel, channel_coin.clone())]
            }
            SpendChannelCoinState::UnrollTimeoutOrSpend { unroll_coin, .. }
            | SpendChannelCoinState::UnrollSpend { unroll_coin, .. }
            | SpendChannelCoinState::UnrollConditions { unroll_coin, .. } => {
                vec![(CoinOfInterest::Unroll, unroll_coin.clone())]
            }
        };
        if let Some(reward) = self.terminal_reward_coin.as_ref() {
            coins.push((CoinOfInterest::Change, reward.clone()));
        }
        coins
    }
    fn channel_state(&self) -> Result<&ChannelState, Error> {
        self.base.channel_state()
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
