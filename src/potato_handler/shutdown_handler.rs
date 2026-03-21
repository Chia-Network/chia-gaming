use std::collections::VecDeque;

use clvmr::run_program;

use serde::{Deserialize, Serialize};

use crate::channel_handler::types::{ChannelCoinSpendInfo, ChannelHandlerEnv, ReadableMove};
use crate::channel_handler::ChannelHandler;
use crate::common::types::{
    chia_dialect, Amount, CoinCondition, CoinString, Error, GameID, Hash, IntoErr, Program,
    PuzzleHash, SpendBundle, Timeout,
};
use crate::peer_container::PeerHandler;
use crate::potato_handler::effects::{
    format_coin, ChannelState, ChannelStatusSnapshot, Effect, GameNotification, ResyncInfo,
};
use crate::potato_handler::handler_base::{build_channel_to_unroll_bundle, ChannelHandlerBase};
use crate::potato_handler::types::{GameAction, PotatoState, SpendWalletReceiver};
use crate::potato_handler::unroll_watch_handler::UnrollWatchHandler;

#[derive(Debug, Serialize, Deserialize)]
enum ShutdownState {
    WatchingChannelCoin,
    WaitingForConditions,
    Completed,
    Failed,
}

#[derive(Serialize, Deserialize)]
pub struct ShutdownHandler {
    state: ShutdownState,
    base: ChannelHandlerBase,

    channel_coin: CoinString,
    reward_coin: Option<CoinString>,

    advisory: Option<String>,

    #[serde(skip)]
    last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,

    #[serde(skip)]
    unroll_watch_replacement: Option<Box<UnrollWatchHandler>>,
}

impl std::fmt::Debug for ShutdownHandler {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "ShutdownHandler({:?})", self.state)
    }
}

impl ShutdownHandler {
    pub fn new(
        channel_handler: Option<ChannelHandler>,
        channel_coin: CoinString,
        reward_coin: Option<CoinString>,
        game_action_queue: VecDeque<GameAction>,
        have_potato: PotatoState,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
        last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,
    ) -> Self {
        ShutdownHandler {
            state: ShutdownState::WatchingChannelCoin,
            base: ChannelHandlerBase::new(
                channel_handler,
                game_action_queue,
                have_potato,
                channel_timeout,
                unroll_timeout,
            ),
            channel_coin,
            reward_coin,
            advisory: None,
            last_channel_coin_spend_info,
            unroll_watch_replacement: None,
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
        matches!(self.state, ShutdownState::Failed)
    }
    pub fn is_completed(&self) -> bool {
        matches!(self.state, ShutdownState::Completed)
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

    pub fn take_unroll_watch_replacement(&mut self) -> Option<Box<UnrollWatchHandler>> {
        self.unroll_watch_replacement.take()
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

    // --- Game actions (rejected during shutdown) ---

    pub fn make_move(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _id: &GameID,
        _readable: &ReadableMove,
        _new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr("game action during shutdown".to_string()))
    }

    pub fn accept_timeout(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr("game action during shutdown".to_string()))
    }

    pub fn cheat_game(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _game_id: &GameID,
        _mover_share: Amount,
        _entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr("game action during shutdown".to_string()))
    }

    // --- Coin event handlers ---

    pub fn coin_spent(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        if matches!(self.state, ShutdownState::Failed) {
            return Ok(vec![]);
        }
        if matches!(self.state, ShutdownState::WatchingChannelCoin) && *coin_id == self.channel_coin
        {
            self.state = ShutdownState::WaitingForConditions;
            return Ok(vec![
                Effect::DebugLog(format!(
                    "[shutdown:channel-coin-spent] {}",
                    format_coin(coin_id)
                )),
                Effect::RequestPuzzleAndSolution(coin_id.clone()),
            ]);
        }
        Ok(vec![Effect::DebugLog(format!(
            "[shutdown:coin-spent] {}",
            format_coin(coin_id),
        ))])
    }

    pub fn coin_timeout_reached(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![Effect::DebugLog(format!(
            "[shutdown:coin-timeout] {}",
            format_coin(coin_id),
        ))])
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
        if matches!(self.state, ShutdownState::Failed) {
            return Ok((vec![], None));
        }
        if matches!(self.state, ShutdownState::WaitingForConditions)
            && *coin_id == self.channel_coin
        {
            match self.handle_clean_shutdown_conditions(env, coin_id, puzzle_and_solution) {
                Ok(effects) => return Ok((effects, None)),
                Err(e) => {
                    let reason = format!("clean shutdown condition check failed: {e:?}");
                    let mut effects = vec![Effect::DebugLog(format!("[channel-error] {reason}"))];
                    effects.extend(self.base.emit_failure_cleanup());
                    self.advisory = Some(reason);
                    self.state = ShutdownState::Failed;
                    return Ok((effects, None));
                }
            }
        }
        Ok((vec![], None))
    }

    fn build_unroll_bundle(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
        name: &str,
    ) -> Result<SpendBundle, Error> {
        let saved = self
            .last_channel_coin_spend_info
            .as_ref()
            .ok_or_else(|| Error::StrErr(format!("{name}: no channel coin spend info cached")))?;
        let ch = self.base.channel_handler()?;
        build_channel_to_unroll_bundle(env, ch, &self.channel_coin, saved, name)
    }

    /// Impatience signal: broadcast our latest unroll tx while still in
    /// shutdown-watching state.
    pub fn go_on_chain(&mut self, env: &mut ChannelHandlerEnv<'_>) -> Result<Vec<Effect>, Error> {
        let bundle = self.build_unroll_bundle(env, "impatience unroll")?;
        Ok(vec![Effect::SpendTransaction(bundle)])
    }

    #[cfg(test)]
    pub fn force_unroll_spend(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<SpendBundle, Error> {
        self.build_unroll_bundle(env, "force unroll")
    }

    // --- Internal methods ---

    fn handle_clean_shutdown_conditions(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<Vec<Effect>, Error> {
        let (puzzle, solution) = puzzle_and_solution.ok_or_else(|| {
            Error::StrErr("Retrieve of puzzle and solution failed for channel coin".to_string())
        })?;

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

        let is_clean_shutdown = if let Some(expected) = &self.reward_coin {
            if let Some((_, expected_ph, expected_amt)) = expected.to_parts() {
                channel_conditions.iter().any(|c| {
                    matches!(c, CoinCondition::CreateCoin(ph, amt) if *ph == expected_ph && *amt == expected_amt)
                })
            } else {
                false
            }
        } else {
            !channel_conditions
                .iter()
                .any(|c| matches!(c, CoinCondition::Rem(_)))
        };

        if is_clean_shutdown {
            self.state = ShutdownState::Completed;
            let mut effects = Vec::new();
            if let Some(ref rc) = self.reward_coin {
                effects.push(Effect::DebugLog(format!(
                    "[clean-end] reward {}",
                    format_coin(rc),
                )));
            } else {
                effects.push(Effect::DebugLog("[clean-end] no reward".to_string()));
            }
            {
                let ch = self.base.channel_handler_mut()?;
                for (id, amount) in ch.drain_cached_accept_timeouts() {
                    effects.push(Effect::Notify(GameNotification::WeTimedOut {
                        id,
                        our_reward: amount,
                        reward_coin: None,
                    }));
                }
            }
            return Ok(effects);
        }

        // An unroll landed instead of the clean shutdown transaction.
        let mut effects = Vec::new();

        let unroll_coin = channel_conditions
            .iter()
            .find_map(|c| {
                if let CoinCondition::CreateCoin(ph, amt) = c {
                    Some(CoinString::from_parts(&coin_id.to_coin_id(), ph, amt))
                } else {
                    None
                }
            })
            .ok_or_else(|| {
                Error::StrErr("channel conditions didn't include a coin creation".to_string())
            })?;

        use crate::potato_handler::handler_base::{classify_unroll, UnrollOutcome};

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
                &unroll_coin,
                on_chain_state,
            )?
        };

        effects.push(Effect::DebugLog(format!(
            "[unroll-started] {} state={on_chain_state}",
            format_coin(&unroll_coin),
        )));

        match outcome {
            UnrollOutcome::Preempted(bundle) => {
                effects.push(Effect::SpendTransaction(bundle));
                effects.push(Effect::DebugLog(format!(
                    "[unroll-preempt] state={on_chain_state}"
                )));
                let uw = UnrollWatchHandler::new_at_unroll(
                    self.base.channel_handler.take(),
                    unroll_coin.clone(),
                    on_chain_state,
                    None,
                    std::mem::take(&mut self.base.game_action_queue),
                    self.base.have_potato.clone(),
                    self.base.channel_timeout.clone(),
                    self.base.unroll_timeout.clone(),
                );
                self.unroll_watch_replacement = Some(Box::new(uw));
                effects.push(Effect::RegisterCoin {
                    coin: unroll_coin,
                    timeout: self.base.unroll_timeout.clone(),
                    name: Some("unroll"),
                });
            }
            UnrollOutcome::WaitForTimeout => {
                let mut uw = UnrollWatchHandler::new_at_unroll(
                    self.base.channel_handler.take(),
                    unroll_coin.clone(),
                    on_chain_state,
                    None,
                    std::mem::take(&mut self.base.game_action_queue),
                    self.base.have_potato.clone(),
                    self.base.channel_timeout.clone(),
                    self.base.unroll_timeout.clone(),
                );
                uw.set_waiting_for_timeout();
                self.unroll_watch_replacement = Some(Box::new(uw));
                effects.push(Effect::RegisterCoin {
                    coin: unroll_coin,
                    timeout: self.base.unroll_timeout.clone(),
                    name: Some("unroll"),
                });
            }
            UnrollOutcome::Unrecoverable(reason) => {
                effects.push(Effect::DebugLog(format!("[unroll-error] {reason}")));
                effects.extend(self.base.emit_failure_cleanup());
                self.advisory = Some(reason);
                self.state = ShutdownState::Failed;
            }
        }

        Ok(effects)
    }
}

impl SpendWalletReceiver for ShutdownHandler {
    fn coin_created(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        ShutdownHandler::coin_created(self, env, coin_id)
    }
    fn coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        ShutdownHandler::coin_spent(self, env, coin_id)
    }
    fn coin_timeout_reached(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        ShutdownHandler::coin_timeout_reached(self, env, coin_id)
    }
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        ShutdownHandler::coin_puzzle_and_solution(self, env, coin_id, puzzle_and_solution)
    }
}

#[typetag::serde]
impl PeerHandler for ShutdownHandler {
    fn has_pending_incoming(&self) -> bool {
        ShutdownHandler::has_pending_incoming(self)
    }
    fn process_incoming_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        ShutdownHandler::process_incoming_message(self, env)
    }
    fn received_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        ShutdownHandler::received_message(self, env, msg)
    }
    fn coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        ShutdownHandler::coin_spent(self, env, coin_id)
    }
    fn coin_timeout_reached(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        ShutdownHandler::coin_timeout_reached(self, env, coin_id)
    }
    fn coin_created(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        ShutdownHandler::coin_created(self, env, coin_id)
    }
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        ShutdownHandler::coin_puzzle_and_solution(self, env, coin_id, puzzle_and_solution)
    }
    fn make_move(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        ShutdownHandler::make_move(self, env, id, readable, new_entropy)
    }
    fn accept_timeout(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        ShutdownHandler::accept_timeout(self, env, id)
    }
    fn cheat_game(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        mover_share: Amount,
        entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        ShutdownHandler::cheat_game(self, env, game_id, mover_share, entropy)
    }
    fn take_replacement(&mut self) -> Option<Box<dyn PeerHandler>> {
        ShutdownHandler::take_unroll_watch_replacement(self).map(|uw| uw as Box<dyn PeerHandler>)
    }
    fn go_on_chain(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        _got_error: bool,
    ) -> Result<Vec<Effect>, Error> {
        ShutdownHandler::go_on_chain(self, env)
    }
    fn channel_status_snapshot(&self) -> Option<ChannelStatusSnapshot> {
        let state = match self.state {
            ShutdownState::WatchingChannelCoin | ShutdownState::WaitingForConditions => {
                ChannelState::ShuttingDown
            }
            ShutdownState::Completed => ChannelState::ResolvedClean,
            ShutdownState::Failed => ChannelState::Failed,
        };
        let coin = Some(self.channel_coin.clone());
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
