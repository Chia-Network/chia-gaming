use std::collections::{HashMap, HashSet, VecDeque};

use clvmr::{run_program, NodePtr};

use serde::{Deserialize, Serialize};

use crate::channel_handler::types::{ChannelHandlerEnv, ReadableMove};
use crate::channel_handler::ChannelHandler;
use crate::common::types::{
    chia_dialect, Aggsig, Amount, CoinCondition, CoinSpend, CoinString, Error, GameID, Hash,
    IntoErr, Program, PuzzleHash, Spend, SpendBundle, Timeout,
};
use crate::peer_container::PeerHandler;
use crate::potato_handler::effects::{format_coin, Effect, GameNotification, ResyncInfo};
use crate::potato_handler::handler_base::{classify_unroll, ChannelHandlerBase, UnrollOutcome};
use crate::potato_handler::on_chain::{
    OnChainGameHandler, OnChainGameHandlerArgs, PendingMoveKind, PendingMoveSavedState,
};
use crate::potato_handler::types::{GameAction, PotatoState, SpendWalletReceiver};

#[derive(Debug, Serialize, Deserialize)]
enum UnrollState {
    WaitingForChannelSpend {
        channel_coin: CoinString,
    },
    WaitingForChannelConditions {
        channel_coin: CoinString,
    },
    WaitingForUnrollTimeoutOrSpend {
        unroll_coin: CoinString,
        state_number: usize,
    },
    WaitingForUnrollSpend {
        unroll_coin: CoinString,
        state_number: usize,
        reward_coin: Option<CoinString>,
    },
    WaitingForUnrollConditions {
        unroll_coin: CoinString,
        state_number: usize,
    },
    Completed,
    Failed,
}

#[derive(Serialize, Deserialize)]
pub struct UnrollWatchHandler {
    state: UnrollState,
    base: ChannelHandlerBase,

    #[serde(skip)]
    replacement: Option<Box<OnChainGameHandler>>,
}

impl std::fmt::Debug for UnrollWatchHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "UnrollWatchHandler({:?})", self.state)
    }
}

impl UnrollWatchHandler {
    pub fn new(
        channel_handler: Option<ChannelHandler>,
        channel_coin: CoinString,
        game_action_queue: VecDeque<GameAction>,
        have_potato: PotatoState,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
    ) -> Self {
        UnrollWatchHandler {
            state: UnrollState::WaitingForChannelSpend { channel_coin },
            base: ChannelHandlerBase::new(
                channel_handler,
                game_action_queue,
                have_potato,
                channel_timeout,
                unroll_timeout,
            ),
            replacement: None,
        }
    }

    /// Create an UnrollWatchHandler that enters at the point where the channel
    /// coin has been detected as spent but we haven't yet received the
    /// puzzle/solution.  Used when PotatoHandler passively detects the channel
    /// coin spend (opponent went on-chain).
    pub fn new_at_channel_conditions(
        channel_handler: Option<ChannelHandler>,
        channel_coin: CoinString,
        game_action_queue: VecDeque<GameAction>,
        have_potato: PotatoState,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
    ) -> Self {
        UnrollWatchHandler {
            state: UnrollState::WaitingForChannelConditions { channel_coin },
            base: ChannelHandlerBase::new(
                channel_handler,
                game_action_queue,
                have_potato,
                channel_timeout,
                unroll_timeout,
            ),
            replacement: None,
        }
    }

    /// Create an UnrollWatchHandler that enters directly at 3b (unroll coin
    /// already exists).  Used when entering Phase 3 from Phase 2a (shutdown
    /// detected an unroll instead of clean shutdown).
    pub fn new_at_unroll(
        channel_handler: Option<ChannelHandler>,
        unroll_coin: CoinString,
        state_number: usize,
        reward_coin: Option<CoinString>,
        game_action_queue: VecDeque<GameAction>,
        have_potato: PotatoState,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
    ) -> Self {
        UnrollWatchHandler {
            state: UnrollState::WaitingForUnrollSpend {
                unroll_coin,
                state_number,
                reward_coin,
            },
            base: ChannelHandlerBase::new(
                channel_handler,
                game_action_queue,
                have_potato,
                channel_timeout,
                unroll_timeout,
            ),
            replacement: None,
        }
    }

    /// Switch from WaitingForUnrollSpend to WaitingForUnrollTimeoutOrSpend.
    /// Used when entering Phase 3 from Phase 2a with timeout path.
    pub fn set_waiting_for_timeout(&mut self) {
        if let UnrollState::WaitingForUnrollSpend {
            unroll_coin,
            state_number,
            ..
        } = &self.state
        {
            self.state = UnrollState::WaitingForUnrollTimeoutOrSpend {
                unroll_coin: unroll_coin.clone(),
                state_number: *state_number,
            };
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
    pub fn is_failed(&self) -> bool {
        matches!(self.state, UnrollState::Failed)
    }
    pub fn is_completed(&self) -> bool {
        matches!(self.state, UnrollState::Completed)
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

    // --- Coin event handlers ---

    pub fn coin_spent(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        if matches!(self.state, UnrollState::Failed) {
            return Ok(vec![]);
        }
        let mut effects = Vec::new();

        match &self.state {
            UnrollState::WaitingForChannelSpend { channel_coin } if coin_id == channel_coin => {
                self.state = UnrollState::WaitingForChannelConditions {
                    channel_coin: channel_coin.clone(),
                };
                effects.push(Effect::DebugLog(format!(
                    "[unroll-watch:channel-coin-spent] {}",
                    format_coin(coin_id)
                )));
                effects.push(Effect::RequestPuzzleAndSolution(coin_id.clone()));
                return Ok(effects);
            }
            UnrollState::WaitingForUnrollSpend {
                unroll_coin,
                state_number,
                ..
            } if coin_id == unroll_coin => {
                self.state = UnrollState::WaitingForUnrollConditions {
                    unroll_coin: unroll_coin.clone(),
                    state_number: *state_number,
                };
                effects.push(Effect::DebugLog(format!(
                    "[unroll-watch:unroll-coin-spent] {}",
                    format_coin(coin_id)
                )));
                effects.push(Effect::RequestPuzzleAndSolution(coin_id.clone()));
                return Ok(effects);
            }
            UnrollState::WaitingForUnrollTimeoutOrSpend {
                unroll_coin,
                state_number,
            } if coin_id == unroll_coin => {
                self.state = UnrollState::WaitingForUnrollConditions {
                    unroll_coin: unroll_coin.clone(),
                    state_number: *state_number,
                };
                effects.push(Effect::DebugLog(format!(
                    "[unroll-watch:unroll-coin-spent] {}",
                    format_coin(coin_id)
                )));
                effects.push(Effect::RequestPuzzleAndSolution(coin_id.clone()));
                return Ok(effects);
            }
            _ => {}
        }

        effects.push(Effect::DebugLog(format!(
            "[unroll-watch:coin-spent] {}",
            format_coin(coin_id),
        )));
        Ok(effects)
    }

    pub fn coin_timeout_reached(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        if matches!(self.state, UnrollState::Failed) {
            return Ok(vec![]);
        }
        let mut effects = Vec::new();

        let unroll_timed_out = match &self.state {
            UnrollState::WaitingForUnrollTimeoutOrSpend {
                unroll_coin,
                state_number,
            } if coin_id == unroll_coin => Some(*state_number),
            UnrollState::WaitingForUnrollSpend {
                unroll_coin,
                state_number,
                ..
            } if coin_id == unroll_coin => Some(*state_number),
            _ => None,
        };

        if let Some(on_chain_state) = unroll_timed_out {
            effects.push(Effect::DebugLog(format!(
                "[unroll-timeout] state={on_chain_state}",
            )));
            match self.do_unroll_spend_to_games(env, coin_id, on_chain_state) {
                Ok(effect) => {
                    effects.extend(effect);
                }
                Err(e) => {
                    let reason = format!("timeout unroll failed for state {on_chain_state}: {e:?}");
                    effects.push(Effect::DebugLog(format!("[unroll-error] {reason}")));
                    effects.extend(self.base.emit_failure_cleanup());
                    effects.push(Effect::Notify(GameNotification::ChannelError { reason }));
                    self.state = UnrollState::Failed;
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
        if matches!(self.state, UnrollState::Failed) {
            return Ok((vec![], None));
        }
        let mut effects = Vec::new();

        match &self.state {
            UnrollState::WaitingForChannelConditions { channel_coin }
                if *coin_id == *channel_coin =>
            {
                match self.handle_channel_coin_spent(env, coin_id, puzzle_and_solution) {
                    Ok(effect) => effects.extend(effect),
                    Err(e) => {
                        let reason = format!("channel coin spent to non-unroll: {e:?}");
                        effects.push(Effect::DebugLog(format!("[channel-error] {reason}")));
                        effects.extend(self.base.emit_failure_cleanup());
                        effects.push(Effect::Notify(GameNotification::ChannelError { reason }));
                        self.state = UnrollState::Failed;
                    }
                }
                return Ok((effects, None));
            }
            UnrollState::WaitingForUnrollSpend {
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
                        effects.push(Effect::DebugLog(format!("[unroll-error] {reason}")));
                        effects.extend(self.base.emit_failure_cleanup());
                        effects.push(Effect::Notify(GameNotification::ChannelError { reason }));
                        self.state = UnrollState::Failed;
                    }
                }
                return Ok((effects, None));
            }
            UnrollState::WaitingForUnrollConditions {
                unroll_coin,
                state_number,
            } if *coin_id == *unroll_coin => {
                let sn = *state_number;
                match self.finish_on_chain_transition(env, coin_id, puzzle_and_solution, sn) {
                    Ok(transition_effects) => effects.extend(transition_effects),
                    Err(e) => {
                        let reason = format!("unroll coin spent with unexpected state: {e:?}");
                        effects.push(Effect::DebugLog(format!("[unroll-error] {reason}")));
                        effects.extend(self.base.emit_failure_cleanup());
                        effects.push(Effect::Notify(GameNotification::ChannelError { reason }));
                        self.state = UnrollState::Failed;
                    }
                }
                return Ok((effects, None));
            }
            _ => {}
        }

        Ok((effects, None))
    }

    // --- Internal methods ---

    fn do_unroll_spend_to_games(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        unroll_coin: &CoinString,
        on_chain_state: usize,
    ) -> Result<Option<Effect>, Error> {
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

        self.state = UnrollState::WaitingForUnrollSpend {
            unroll_coin: unroll_coin.clone(),
            state_number: on_chain_state,
            reward_coin: None,
        };

        Ok(Some(Effect::SpendTransaction(spend_bundle)))
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
                effects.push(Effect::Notify(GameNotification::GameProposalCancelled {
                    id,
                    reason: "channel went on-chain".to_string(),
                }));
            }
        }

        effects.push(Effect::Notify(GameNotification::ChannelCoinSpent {
            unroll_coin: unroll_coin.clone(),
        }));

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

        effects.push(Effect::DebugLog(format!(
            "[unroll-started] {} state={on_chain_state}",
            format_coin(unroll_coin),
        )));

        match outcome {
            UnrollOutcome::Preempted(bundle) => {
                effects.push(Effect::SpendTransaction(bundle));
                effects.push(Effect::DebugLog(format!(
                    "[unroll-preempt] state={on_chain_state}",
                )));
                self.state = UnrollState::WaitingForUnrollSpend {
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
                self.state = UnrollState::WaitingForUnrollTimeoutOrSpend {
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
                effects.push(Effect::DebugLog(format!("[unroll-error] {reason}",)));
                effects.extend(self.base.emit_failure_cleanup());
                effects.push(Effect::Notify(GameNotification::ChannelError { reason }));
                self.state = UnrollState::Failed;
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
            let reward_amount = conditions
                .iter()
                .find_map(|c| {
                    if let CoinCondition::CreateCoin(ph, amt) = c {
                        if *ph == reward_puzzle_hash {
                            return Some(amt.clone());
                        }
                    }
                    None
                })
                .unwrap_or_default();
            effects.push(Effect::Notify(GameNotification::UnrollCoinSpent {
                reward_coin: reward_coin.clone(),
                reward_amount: reward_amount.clone(),
            }));

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
                effects.push(Effect::Notify(GameNotification::StaleChannelUnroll {
                    our_reward: reward_amount,
                    reward_coin: reward_coin.clone(),
                }));
            }

            let game_map_inner = player_ch.set_state_for_coins(env, unroll_coin, &created_coins)?;

            let surviving_ids: HashSet<GameID> =
                game_map_inner.values().map(|def| def.game_id).collect();
            for missing_id in pre_game_ids.difference(&surviving_ids) {
                if in_flight_proposal_ids.contains(missing_id) {
                    effects.push(Effect::Notify(GameNotification::GameCancelled {
                        id: *missing_id,
                    }));
                } else {
                    let reason = if is_stale {
                        "live game absent from stale unroll"
                    } else {
                        "live game absent from unroll"
                    };
                    effects.push(Effect::Notify(GameNotification::GameError {
                        id: *missing_id,
                        reason: reason.to_string(),
                    }));
                }
            }

            let preempt_resolved = player_ch.drain_preempt_resolved_accept_timeouts(&surviving_ids);

            (game_map_inner, reward_coin, preempt_resolved)
        };

        for (game_id, our_share) in &preempt_resolved {
            effects.push(Effect::Notify(GameNotification::WeTimedOut {
                id: *game_id,
                our_reward: our_share.clone(),
                reward_coin: on_chain_reward_coin.clone(),
            }));
        }

        if game_map.is_empty() {
            self.state = UnrollState::Completed;
            let reward_amount = on_chain_reward_coin
                .as_ref()
                .and_then(|r| r.amount())
                .unwrap_or_default();
            effects.push(Effect::Notify(GameNotification::CleanShutdownComplete {
                reward_coin: on_chain_reward_coin,
                reward_amount,
            }));
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
                    zero_reward_games.push((coin.clone(), state.game_id));
                }
            }
            for (coin, game_id) in &zero_reward_games {
                game_map.remove(coin);
                effects.push(Effect::Notify(GameNotification::WeTimedOut {
                    id: *game_id,
                    our_reward: Amount::default(),
                    reward_coin: None,
                }));
            }
        }

        if game_map.is_empty() {
            self.state = UnrollState::Completed;
            let reward_amount = on_chain_reward_coin
                .as_ref()
                .and_then(|r| r.amount())
                .unwrap_or_default();
            effects.push(Effect::Notify(GameNotification::CleanShutdownComplete {
                reward_coin: on_chain_reward_coin,
                reward_amount,
            }));
            return Ok(effects);
        }

        for (coin, state) in game_map.iter() {
            effects.push(Effect::Notify(GameNotification::GameOnChain {
                id: state.game_id,
                coin: coin.clone(),
                amount: coin.amount().unwrap_or_default(),
                our_turn: state.our_turn,
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

                let saved_referee = cached_move.saved_post_move_referee.clone().ok_or_else(|| {
                    Error::StrErr("redo: no saved post-move referee".to_string())
                })?;
                let saved_ph = cached_move.saved_post_move_last_ph.clone().ok_or_else(|| {
                    Error::StrErr("redo: no saved post-move last_ph".to_string())
                })?;

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
        });
        effects.extend(on_chain.next_action(env)?);
        self.replacement = Some(Box::new(on_chain));
        self.state = UnrollState::Completed;

        Ok(effects)
    }
}

impl SpendWalletReceiver for UnrollWatchHandler {
    fn coin_created(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        UnrollWatchHandler::coin_created(self, env, coin_id)
    }
    fn coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        UnrollWatchHandler::coin_spent(self, env, coin_id)
    }
    fn coin_timeout_reached(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        UnrollWatchHandler::coin_timeout_reached(self, env, coin_id)
    }
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        UnrollWatchHandler::coin_puzzle_and_solution(self, env, coin_id, puzzle_and_solution)
    }
}

#[typetag::serde]
impl PeerHandler for UnrollWatchHandler {
    fn has_pending_incoming(&self) -> bool {
        UnrollWatchHandler::has_pending_incoming(self)
    }
    fn process_incoming_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        UnrollWatchHandler::process_incoming_message(self, env)
    }
    fn received_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        UnrollWatchHandler::received_message(self, env, msg)
    }
    fn coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        UnrollWatchHandler::coin_spent(self, env, coin_id)
    }
    fn coin_timeout_reached(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        UnrollWatchHandler::coin_timeout_reached(self, env, coin_id)
    }
    fn coin_created(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        UnrollWatchHandler::coin_created(self, env, coin_id)
    }
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        UnrollWatchHandler::coin_puzzle_and_solution(self, env, coin_id, puzzle_and_solution)
    }
    fn make_move(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        UnrollWatchHandler::make_move(self, env, id, readable, new_entropy)
    }
    fn accept_timeout(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        UnrollWatchHandler::accept_timeout(self, env, id)
    }
    fn cheat_game(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        mover_share: Amount,
        entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        UnrollWatchHandler::cheat_game(self, env, game_id, mover_share, entropy)
    }
    fn take_replacement(&mut self) -> Option<Box<dyn PeerHandler>> {
        UnrollWatchHandler::take_replacement(self).map(|oc| oc as Box<dyn PeerHandler>)
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
