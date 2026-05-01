use std::borrow::Borrow;
use std::collections::{BTreeMap, VecDeque};

use std::rc::Rc;

use clvm_traits::ToClvm;

use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::channel_handler::game;
use crate::channel_handler::game_start_info::GameStartInfo;
use crate::channel_handler::types::{
    ChannelCoinSpendInfo, ChannelHandlerEnv, ChannelHandlerPrivateKeys, PotatoSignatures,
    ReadableMove,
};
use crate::channel_handler::ChannelHandler;
use crate::common::standard_coin::puzzle_for_synthetic_public_key;
use crate::common::types::{
    Aggsig, Amount, CoinCondition, CoinSpend, CoinString, Error, GameID, GameType, Hash, IntoErr,
    Program, ProgramRef, PuzzleHash, Spend, SpendBundle, Timeout,
};
use crate::potato_handler::effects::{
    format_coin, CancelReason, ChannelState, ChannelStatusSnapshot, Effect, GameNotification,
    GameStatusKind, GameStatusOtherParams, ResyncInfo,
};
use crate::shutdown::get_conditions_with_channel_handler;

use crate::peer_container::PeerHandler;
use crate::potato_handler::types::{
    BatchAction, FromLocalUI, GameAction, GameFactory, PeerMessage, PotatoState,
    SpendWalletReceiver, WireProposeGame,
};

use crate::potato_handler::start::GameStart;

pub mod effects;
pub mod handler_base;
pub mod handshake;
pub mod handshake_initiator;
pub mod handshake_receiver;
pub mod on_chain;
pub mod spend_channel_coin_handler;
pub mod start;
pub mod types;

pub type GameStartInfoPair = (Vec<Rc<GameStartInfo>>, Vec<Rc<GameStartInfo>>);

fn serialize_game_type_map<S: Serializer>(
    map: &BTreeMap<GameType, GameFactory>,
    s: S,
) -> Result<S::Ok, S::Error> {
    map.iter()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect::<Vec<(GameType, GameFactory)>>()
        .serialize(s)
}

fn deserialize_game_type_map<'de, D>(
    deserializer: D,
) -> Result<BTreeMap<GameType, GameFactory>, D::Error>
where
    D: Deserializer<'de>,
{
    let v = Vec::<(GameType, GameFactory)>::deserialize(deserializer)?;
    let b: BTreeMap<GameType, GameFactory> = v.iter().cloned().collect();
    Ok(b)
}

/// Handle potato in flight when I request potato:
///
/// Every time i send the potato, if i have stuff i want to do, then i also send
/// the request potato message directly after so I can be prompted to take another
/// thing off.
///
/// General workflow:
///
/// Whenever we receive the potato, check the work queues, notify channel handler,
/// then take the channel handler result with the potato and send it on.
///
/// If there is more work left, also send a receive potato message at that time.
///
/// Also do this when any queue becomes non-empty.
///
/// State machine surrounding game starts:
///
/// First peer receives game start from the ui
/// First peer tries to acquire the potato and when we have it, send a peer level start game
/// message.
/// First peer creates the game by giving channel_handler the game definitions.
/// second peer receives the game start from the first peer and stores it.
///
/// When the channel handler game start is reeived, we must receive a matching datum to
/// the one we receive in the channel handler game start.  If we receive that, we allow
/// the message through to the channel handler.
#[derive(Serialize, Deserialize)]
pub struct PotatoHandler {
    initiator: bool,
    have_potato: PotatoState,

    game_action_queue: VecDeque<GameAction>,

    channel_handler: Option<ChannelHandler>,

    #[serde(
        serialize_with = "serialize_game_type_map",
        deserialize_with = "deserialize_game_type_map"
    )]
    game_types: BTreeMap<GameType, GameFactory>,

    private_keys: ChannelHandlerPrivateKeys,

    my_contribution: Amount,

    their_contribution: Amount,

    reward_puzzle_hash: PuzzleHash,

    channel_timeout: Timeout,
    // Unroll timeout
    unroll_timeout: Timeout,

    incoming_messages: VecDeque<Rc<PeerMessage>>,

    peer_wants_potato: bool,

    last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,

    #[serde(skip)]
    channel_spend_replacement:
        Option<Box<crate::potato_handler::spend_channel_coin_handler::SpendChannelCoinHandler>>,
}

fn format_batch_action(action: &BatchAction) -> String {
    match action {
        BatchAction::ProposeGame(gsi) => {
            format!(
                "ProposeGame id={} idx={} type={} amt={} my={} timeout={}",
                gsi.game_id,
                gsi.start_index,
                hex::encode(&gsi.start.game_type.0),
                gsi.start.amount,
                gsi.start.my_contribution,
                gsi.start.timeout,
            )
        }
        BatchAction::AcceptProposal(id) => format!("AcceptProposal id={id}"),
        BatchAction::CancelProposal(id) => format!("CancelProposal id={id}"),
        BatchAction::Move(id, details) => {
            format!(
                "Move id={id} mover_share={} max_move_size={} validation_info_hash={:?}",
                details.basic.mover_share,
                details.basic.max_move_size,
                details.validation_info_hash,
            )
        }
        BatchAction::AcceptTimeout(id, amount) => {
            format!("AcceptTimeout id={id} amt={amount}")
        }
    }
}

pub(crate) fn format_reward_coin(label: &str, ph: &PuzzleHash, amount: &Amount) -> Option<String> {
    if *amount == Amount::default() {
        return None;
    }
    Some(format!("{label} ph={ph} amt={amount}"))
}

pub(crate) fn make_send_log(
    ch: &ChannelHandler,
    actions: &[BatchAction],
    clean_shutdown: bool,
) -> String {
    let mut parts = vec![format!("[send] state={}", ch.state_number())];
    for a in actions {
        parts.push(format!("  {}", format_batch_action(a)));
    }
    if clean_shutdown {
        parts.push("  clean_shutdown=true".to_string());
    }
    if let Some(s) = format_reward_coin(
        "my_reward",
        ch.my_reward_puzzle_hash(),
        &ch.my_out_of_game_balance(),
    ) {
        parts.push(format!("  {s}"));
    }
    if let Some(s) = format_reward_coin(
        "their_reward",
        ch.their_reward_puzzle_hash(),
        &ch.their_out_of_game_balance(),
    ) {
        parts.push(format!("  {s}"));
    }
    parts.join("\n")
}

impl PotatoHandler {
    fn hydrate_wire_proposal(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        wire: &WireProposeGame,
    ) -> Result<Rc<GameStartInfo>, Error> {
        let (my_games, their_games) =
            self.get_games_by_start_type(env, true, &wire.game_id, &wire.start)?;
        let (_mine, theirs) = if wire.start.my_turn {
            (my_games, their_games)
        } else {
            (their_games, my_games)
        };
        theirs.get(wire.start_index).cloned().ok_or_else(|| {
            Error::StrErr(format!(
                "wire proposal start_index {} out of range for game {}",
                wire.start_index, wire.game_id
            ))
        })
    }

    pub fn from_completed_handshake(
        initiator: bool,
        channel_handler: ChannelHandler,
        have_potato: PotatoState,
        game_types: BTreeMap<GameType, GameFactory>,
        private_keys: ChannelHandlerPrivateKeys,
        my_contribution: Amount,
        their_contribution: Amount,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
        reward_puzzle_hash: PuzzleHash,
        incoming_messages: VecDeque<Rc<PeerMessage>>,
        last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,
    ) -> PotatoHandler {
        PotatoHandler {
            initiator,
            have_potato,
            game_types,
            game_action_queue: VecDeque::default(),
            channel_handler: Some(channel_handler),
            private_keys,
            my_contribution,
            their_contribution,
            channel_timeout,
            unroll_timeout,
            reward_puzzle_hash,
            incoming_messages,
            peer_wants_potato: false,
            last_channel_coin_spend_info,
            channel_spend_replacement: None,
        }
    }

    pub fn take_channel_spend_replacement(
        &mut self,
    ) -> Option<Box<crate::potato_handler::spend_channel_coin_handler::SpendChannelCoinHandler>>
    {
        self.channel_spend_replacement.take()
    }

    pub fn amount(&self) -> Amount {
        self.my_contribution.clone() + self.their_contribution.clone()
    }

    pub fn get_our_current_share(&self) -> Option<Amount> {
        self.channel_handler
            .as_ref()
            .map(|ch| ch.get_our_current_share())
    }

    pub fn get_their_current_share(&self) -> Option<Amount> {
        self.channel_handler
            .as_ref()
            .map(|ch| ch.get_their_current_share())
    }

    pub fn is_failed(&self) -> bool {
        false
    }

    pub(crate) fn cheat_game(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        mover_share: Amount,
        entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        let (_continued, effects) =
            self.do_game_action(GameAction::Cheat(*game_id, mover_share, entropy))?;

        Ok(effects)
    }

    #[cfg(test)]
    pub(crate) fn self_accept_proposal(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        let (_continued, effects) =
            self.do_game_action(GameAction::ForcedSelfAccept(*game_id))?;
        Ok(effects)
    }

    pub fn has_pending_incoming(&self) -> bool {
        !self.incoming_messages.is_empty()
    }

    pub fn push_action(&mut self, action: GameAction) {
        self.game_action_queue.push_back(action);
    }

    pub fn is_initiator(&self) -> bool {
        self.initiator
    }

    pub fn channel_handler(&self) -> Result<&ChannelHandler, Error> {
        self.channel_handler
            .as_ref()
            .ok_or_else(|| Error::StrErr("no channel handler".to_string()))
    }

    fn channel_handler_mut(&mut self) -> Result<&mut ChannelHandler, Error> {
        self.channel_handler
            .as_mut()
            .ok_or_else(|| Error::StrErr("no channel handler".to_string()))
    }

    pub fn handshake_finished(&self) -> bool {
        true
    }

    #[cfg(test)]
    pub fn corrupt_state_for_testing(&mut self, new_sn: usize) -> Result<(), Error> {
        let ch = self.channel_handler_mut()?;
        ch.corrupt_state_for_testing(new_sn);
        Ok(())
    }

    #[cfg(test)]
    pub fn get_last_channel_coin_spend_info(&self) -> Option<&ChannelCoinSpendInfo> {
        self.last_channel_coin_spend_info.as_ref()
    }

    /// Tell whether this peer has the potato.  If it has been sent but not received yet
    /// then both will say false
    pub fn has_potato(&self) -> bool {
        matches!(self.have_potato, PotatoState::Present)
    }

    pub fn flush_pending_actions(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        if !self.has_potato() || self.game_action_queue.is_empty() {
            return Ok(vec![]);
        }
        let (_sent, effects) = self.drain_queue_into_batch(env)?;
        Ok(effects)
    }

    pub fn get_reward_puzzle_hash(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<PuzzleHash, Error> {
        let player_ch = self.channel_handler()?;
        player_ch.get_reward_puzzle_hash(env)
    }

    fn update_channel_coin_after_receive(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        spend: &ChannelCoinSpendInfo,
        send_back: bool,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        self.have_potato = PotatoState::Present;

        self.last_channel_coin_spend_info = Some(spend.clone());

        {
            let ch = self.channel_handler_mut()?;
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

        let (sent, batch_effects) = self.drain_queue_into_batch(env)?;
        effects.extend(batch_effects);
        if sent {
            return Ok(effects);
        }

        if self.peer_wants_potato {
            self.peer_wants_potato = false;
            let sigs = {
                let ch = self.channel_handler_mut()?;
                ch.send_empty_potato(env)?
            };
            {
                let ch = self.channel_handler()?;
                effects.push(Effect::Log(make_send_log(ch, &[], false)));
            }
            effects.push(Effect::PeerBatch {
                actions: vec![],
                signatures: sigs,
                clean_shutdown: None,
            });
            self.have_potato = PotatoState::Absent;
            return Ok(effects);
        }

        if send_back {
            let sigs = {
                let ch = self.channel_handler_mut()?;
                ch.send_empty_potato(env)?
            };
            {
                let ch = self.channel_handler()?;
                effects.push(Effect::Log(make_send_log(ch, &[], false)));
            }
            effects.push(Effect::PeerBatch {
                actions: vec![],
                signatures: sigs,
                clean_shutdown: None,
            });
            self.have_potato = PotatoState::Absent;
            return Ok(effects);
        }

        Ok(effects)
    }

    fn pass_on_channel_handler_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        msg_envelope: Rc<PeerMessage>,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        let timeout = self.channel_timeout.clone();

        match msg_envelope.borrow() {
            PeerMessage::Batch {
                actions,
                signatures,
                clean_shutdown,
            } => {
                let ch_snapshot = self.channel_handler.clone();
                match self.process_received_batch(
                    env,
                    &timeout,
                    actions,
                    signatures,
                    clean_shutdown,
                ) {
                    Ok(batch_effects) => {
                        effects.extend(batch_effects);
                    }
                    Err(e) => {
                        self.channel_handler = ch_snapshot;
                        return Err(e);
                    }
                }
            }
            PeerMessage::Message(game_id, message) => {
                let decoded_message = {
                    let ch = self.channel_handler_mut()?;
                    ch.received_message(env, game_id, message)?
                };
                let status = {
                    let ch = self.channel_handler()?;
                    if ch.game_is_my_turn(game_id).unwrap_or(false) {
                        GameStatusKind::MyTurn
                    } else {
                        GameStatusKind::TheirTurn
                    }
                };
                effects.push(Effect::Notify(GameNotification::GameStatus {
                    id: *game_id,
                    status,
                    my_reward: None,
                    coin_id: None,
                    reason: None,
                    other_params: Some(GameStatusOtherParams {
                        readable: Some(decoded_message),
                        mover_share: None,
                        illegal_move_detected: None,
                        moved_by_us: None,
                        game_finished: None,
                    }),
                }));
            }
            PeerMessage::CleanShutdownComplete(coin_spend) => {
                effects.push(Effect::SpendTransaction(SpendBundle {
                    name: Some("Create unroll".to_string()),
                    spends: vec![coin_spend.clone()],
                }));
            }
            _ => {
                return Err(Error::StrErr(format!(
                    "unhandled passthrough message {msg_envelope:?}"
                )));
            }
        }

        Ok(effects)
    }

    fn process_received_batch(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        _timeout: &Timeout,
        actions: &[BatchAction],
        signatures: &PotatoSignatures,
        clean_shutdown: &Option<Box<(Aggsig, ProgramRef)>>,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();

        for action in actions.iter() {
            match action {
                BatchAction::ProposeGame(wire) => {
                    let cancelled: Vec<GameID> = self
                        .game_action_queue
                        .iter()
                        .filter_map(|a| match a {
                            GameAction::QueuedProposal(gsi, _) => Some(gsi.game_id),
                            _ => None,
                        })
                        .collect();
                    self.game_action_queue
                        .retain(|a| !matches!(a, GameAction::QueuedProposal(..)));
                    for id in cancelled {
                        effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                            id,
                            reason: CancelReason::SupersededByIncoming,
                        }));
                    }

                    let gsi = self.hydrate_wire_proposal(env, wire)?;
                    let ch = self.channel_handler_mut()?;
                    ch.apply_received_proposal(env, &gsi)?;
                    let game_id = gsi.game_id;
                    let my_contribution = gsi.my_contribution_this_game.clone();
                    let their_contribution = gsi.their_contribution_this_game.clone();
                    effects.push(Effect::Log(format!(
                        "DBG_ISSUE: recv ProposeGame id={} {}",
                        game_id,
                        ch.dbg_proposed_games_summary(),
                    )));
                    effects.push(Effect::Notify(GameNotification::ProposalMade {
                        id: game_id,
                        my_contribution,
                        their_contribution,
                    }));
                }
                BatchAction::AcceptProposal(game_id) => {
                    let ch = self.channel_handler_mut()?;
                    let before = ch.dbg_proposed_games_summary();
                    ch.apply_received_accept_proposal(game_id)?;
                    effects.push(Effect::Log(format!(
                        "DBG_ISSUE: recv AcceptProposal id={} before={} after={}",
                        game_id,
                        before,
                        ch.dbg_proposed_games_summary(),
                    )));
                    effects.push(Effect::Notify(GameNotification::ProposalAccepted {
                        id: *game_id,
                    }));
                }
                BatchAction::CancelProposal(game_id) => {
                    let ch = self.channel_handler_mut()?;
                    ch.received_cancel_proposal(game_id)?;
                    effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                        id: *game_id,
                        reason: CancelReason::CancelledByPeer,
                    }));
                }
                BatchAction::Move(game_id, game_move) => {
                    let move_result = {
                        let ch = self.channel_handler_mut()?;
                        ch.apply_received_move(env, game_id, game_move)?
                    };
                    let finished = {
                        let ch = self.channel_handler()?;
                        ch.is_game_finished(game_id)
                    };
                    let opponent_readable =
                        ReadableMove::from_program(move_result.readable_their_move);
                    effects.push(Effect::Notify(GameNotification::GameStatus {
                        id: *game_id,
                        status: GameStatusKind::MyTurn,
                        my_reward: None,
                        coin_id: None,
                        reason: None,
                        other_params: Some(GameStatusOtherParams {
                            readable: Some(opponent_readable),
                            mover_share: Some(move_result.mover_share),
                            illegal_move_detected: None,
                            moved_by_us: None,
                            game_finished: if finished { Some(true) } else { None },
                        }),
                    }));
                    if !move_result.message.is_empty() {
                        effects.push(Effect::PeerGameMessage(*game_id, move_result.message));
                    }
                    if finished {
                        self.game_action_queue
                            .push_back(GameAction::AcceptTimeout(*game_id));
                    }
                }
                BatchAction::AcceptTimeout(game_id, _peer_amount) => {
                    let ch = self.channel_handler_mut()?;
                    let (our_reward, game_finished) = ch.apply_received_accept_timeout(game_id)?;
                    let finished_params = if game_finished {
                        Some(GameStatusOtherParams {
                            game_finished: Some(true),
                            ..Default::default()
                        })
                    } else {
                        None
                    };
                    effects.push(Effect::Notify(GameNotification::GameStatus {
                        id: *game_id,
                        status: GameStatusKind::EndedOpponentTimedOut,
                        my_reward: Some(our_reward),
                        coin_id: None,
                        reason: None,
                        other_params: finished_params,
                    }));
                }
            }
        }

        let received_accept_timeout = actions
            .iter()
            .any(|a| matches!(a, BatchAction::AcceptTimeout(..)));

        let has_new_game = actions.iter().any(|a| {
            matches!(
                a,
                BatchAction::ProposeGame(_) | BatchAction::AcceptProposal(_)
            )
        });
        if has_new_game {
            self.game_action_queue
                .retain(|a| !matches!(a, GameAction::CleanShutdown));
        }

        if let Some(shutdown) = clean_shutdown {
            let (sig, conditions) = shutdown.as_ref();
            let has_active = {
                let ch = self.channel_handler_mut()?;
                ch.has_active_games()
            };
            if has_active {
                return Err(Error::StrErr(
                    "opponent requested clean shutdown while games are active".to_string(),
                ));
            }
            {
                let ch = self.channel_handler_mut()?;
                let cancelled_ids = ch.cancel_all_proposals();
                for id in cancelled_ids {
                    effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                        id,
                        reason: CancelReason::CleanShutdown,
                    }));
                }
            }

            let (coin, want_puzzle_hash, want_amount, full_spend, channel_puzzle_public_key) = {
                let ch = self.channel_handler_mut()?;
                let coin = ch.state_channel_coin().clone();
                let clvm_conditions = conditions.to_nodeptr(env.allocator)?;
                let want_puzzle_hash = ch.get_reward_puzzle_hash(env)?;
                let want_amount = ch.my_out_of_game_balance();
                if want_amount != Amount::default() {
                    let condition_list =
                        CoinCondition::from_nodeptr(env.allocator, clvm_conditions);
                    let found_conditions = condition_list.iter().any(|cond| {
                        if let CoinCondition::CreateCoin(ph, amt) = cond {
                            *ph == want_puzzle_hash && *amt >= want_amount
                        } else {
                            false
                        }
                    });

                    if !found_conditions {
                        return Err(Error::StrErr(
                            "given conditions don't pay our referee puzzle hash what's expected"
                                .to_string(),
                        ));
                    }
                }

                let full_spend = ch.received_potato_clean_shutdown(env, sig, clvm_conditions)?;
                let channel_puzzle_public_key = ch.get_aggregate_channel_public_key();
                (
                    coin,
                    want_puzzle_hash,
                    want_amount,
                    full_spend,
                    channel_puzzle_public_key,
                )
            };

            {
                let ch = self.channel_handler_mut()?;
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

            let puzzle = puzzle_for_synthetic_public_key(
                env.allocator,
                &env.standard_puzzle,
                &channel_puzzle_public_key,
            )?;
            let spend = Spend {
                solution: full_spend.solution.clone(),
                puzzle,
                signature: full_spend.signature.clone(),
            };
            let coin_spend = CoinSpend {
                coin: coin.clone(),
                bundle: spend,
            };
            effects.push(Effect::SpendTransaction(SpendBundle {
                name: Some("Create unroll".to_string()),
                spends: vec![coin_spend.clone()],
            }));

            effects.push(Effect::PeerCleanShutdownComplete(coin_spend));

            let handler = crate::potato_handler::spend_channel_coin_handler::SpendChannelCoinHandler::new_for_clean_shutdown(
                self.channel_handler.take(),
                coin.clone(),
                want_puzzle_hash,
                want_amount,
                std::mem::take(&mut self.game_action_queue),
                PotatoState::Present,
                self.channel_timeout.clone(),
                self.unroll_timeout.clone(),
                self.last_channel_coin_spend_info.take(),
            );
            self.channel_spend_replacement = Some(Box::new(handler));
            return Ok(effects);
        }

        let spend_info = {
            let ch = self.channel_handler_mut()?;
            ch.verify_received_batch_signatures(env, signatures)?
        };

        {
            let ch = self.channel_handler()?;
            let state_num = ch.state_number();
            let actions_str: Vec<String> = actions.iter().map(format_batch_action).collect();
            let mut parts = vec![format!("[recv] state={state_num}")];
            for a in &actions_str {
                parts.push(format!("  {a}"));
            }
            if clean_shutdown.is_some() {
                parts.push("  clean_shutdown=true".to_string());
            }
            if let Some(s) = format_reward_coin(
                "my_reward",
                ch.my_reward_puzzle_hash(),
                &ch.my_out_of_game_balance(),
            ) {
                parts.push(format!("  {s}"));
            }
            if let Some(s) = format_reward_coin(
                "their_reward",
                ch.their_reward_puzzle_hash(),
                &ch.their_out_of_game_balance(),
            ) {
                parts.push(format!("  {s}"));
            }
            effects.push(Effect::Log(parts.join("\n")));
        }

        effects.extend(self.update_channel_coin_after_receive(
            env,
            &spend_info,
            received_accept_timeout,
        )?);

        Ok(effects)
    }

    // We have the potato so we can send a message that starts a game if there are games
    // to start.
    //
    // This returns bool so that it can be put into the receive potato pipeline so we
    // can automatically send new game starts on the next potato receive.

    fn send_potato_request_if_needed(&mut self) -> Result<(bool, Option<Effect>), Error> {
        if matches!(self.have_potato, PotatoState::Present) {
            return Ok((true, None));
        }

        if matches!(self.have_potato, PotatoState::Absent) {
            self.have_potato = PotatoState::Requested;
            return Ok((false, Some(Effect::PeerRequestPotato)));
        }

        Ok((false, None))
    }

    fn drain_queue_into_batch(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<(bool, Vec<Effect>), Error> {
        game_assert!(
            matches!(self.have_potato, PotatoState::Present),
            "drain_queue_into_batch: must have potato"
        );
        let mut effects = Vec::new();
        let mut batch_actions: Vec<BatchAction> = Vec::new();
        let mut clean_shutdown_data: Option<Box<(Aggsig, ProgramRef)>> = None;
        let mut pending_shutdown: Option<(CoinString, PuzzleHash, Amount)> = None;
        let mut deferred = VecDeque::new();

        while let Some(action) = self.game_action_queue.pop_front() {
            match action {
                GameAction::Move(game_id, readable_move, new_entropy) => {
                    let ch = self.channel_handler_mut()?;
                    let game_is_my_turn = ch.game_is_my_turn(&game_id);
                    if let Some(true) = game_is_my_turn {
                        let move_result =
                            ch.send_move_no_finalize(env, &game_id, &readable_move, new_entropy)?;
                        batch_actions.push(BatchAction::Move(game_id, move_result.game_move));
                    } else {
                        deferred.push_back(GameAction::Move(game_id, readable_move, new_entropy));
                    }
                }
                GameAction::Cheat(game_id, mover_share, entropy) => {
                    let ch = self.channel_handler_mut()?;
                    let game_is_my_turn = ch.game_is_my_turn(&game_id);
                    if let Some(true) = game_is_my_turn {
                        ch.enable_cheating_for_game(&game_id, &[0x80], mover_share)?;
                        let readable_move =
                            ReadableMove::from_program(Rc::new(Program::from_bytes(&[0x80])));
                        let move_result =
                            ch.send_move_no_finalize(env, &game_id, &readable_move, entropy)?;
                        batch_actions.push(BatchAction::Move(game_id, move_result.game_move));
                    } else {
                        deferred.push_back(GameAction::Cheat(game_id, mover_share, entropy));
                    }
                }
                GameAction::AcceptTimeout(game_id) => {
                    let amount = {
                        let ch = self.channel_handler_mut()?;
                        ch.send_accept_timeout_no_finalize(&game_id)?
                    };
                    batch_actions.push(BatchAction::AcceptTimeout(game_id, amount));
                }
                GameAction::QueuedProposal(my_gsi, their_wire) => {
                    {
                        let ch = self.channel_handler_mut()?;
                        ch.send_propose_game(env, &my_gsi)?;
                        effects.push(Effect::Log(format!(
                            "DBG_ISSUE: send ProposeGame id={} {}",
                            my_gsi.game_id,
                            ch.dbg_proposed_games_summary(),
                        )));
                    }
                    batch_actions.push(BatchAction::ProposeGame(their_wire));
                }
                GameAction::QueuedAcceptProposal(game_id) => {
                    {
                        let ch = self.channel_handler_mut()?;
                        let Some(proposal) = ch.find_proposal(&game_id) else {
                            continue;
                        };
                        if ch.is_our_nonce_parity(&game_id) {
                            return Err(Error::StrErr("cannot accept own proposal".to_string()));
                        }
                        let our_short = proposal.my_contribution > ch.my_out_of_game_balance();
                        let their_short =
                            proposal.their_contribution > ch.their_out_of_game_balance();
                        if our_short || their_short {
                            effects.push(Effect::Notify(GameNotification::ProposalAccepted {
                                id: game_id,
                            }));
                            effects.push(Effect::Notify(GameNotification::InsufficientBalance {
                                id: game_id,
                                our_balance_short: our_short,
                                their_balance_short: their_short,
                            }));
                            ch.send_cancel_proposal(&game_id)?;
                            batch_actions.push(BatchAction::CancelProposal(game_id));
                            continue;
                        }
                        let before = ch.dbg_proposed_games_summary();
                        ch.send_accept_proposal(&game_id)?;
                        effects.push(Effect::Log(format!(
                            "DBG_ISSUE: send AcceptProposal id={} before={} after={}",
                            game_id,
                            before,
                            ch.dbg_proposed_games_summary(),
                        )));
                    }
                    effects.push(Effect::Notify(GameNotification::ProposalAccepted {
                        id: game_id,
                    }));
                    batch_actions.push(BatchAction::AcceptProposal(game_id));
                }
                GameAction::QueuedCancelProposal(game_id) => {
                    {
                        let ch = self.channel_handler_mut()?;
                        if !ch.is_game_proposed(&game_id) {
                            continue;
                        }
                        ch.send_cancel_proposal(&game_id)?;
                    }
                    effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                        id: game_id,
                        reason: CancelReason::CancelledByUs,
                    }));
                    batch_actions.push(BatchAction::CancelProposal(game_id));
                }
                GameAction::CleanShutdown => {
                    {
                        let ch = self.channel_handler()?;
                        if ch.has_active_games() {
                            return Err(Error::StrErr(
                                "cannot clean shutdown while games are active".to_string(),
                            ));
                        }
                    }
                    {
                        let ch = self.channel_handler_mut()?;
                        let cancelled_ids = ch.cancel_all_proposals();
                        for id in cancelled_ids {
                            effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                                id,
                                reason: CancelReason::CleanShutdown,
                            }));
                        }
                    }

                    let real_conditions = {
                        let ch = self.channel_handler_mut()?;
                        get_conditions_with_channel_handler(env, ch)?
                    };
                    let (state_channel_coin, spend, want_puzzle_hash, want_amount) = {
                        let ch = self.channel_handler_mut()?;
                        let spend = ch.send_potato_clean_shutdown(env, real_conditions)?;
                        let want_puzzle_hash = ch.get_reward_puzzle_hash(env)?;
                        let want_amount = ch.my_out_of_game_balance();
                        (
                            ch.state_channel_coin().clone(),
                            spend,
                            want_puzzle_hash,
                            want_amount,
                        )
                    };

                    let shutdown_condition_program =
                        Rc::new(Program::from_nodeptr(env.allocator, real_conditions)?);
                    clean_shutdown_data = Some(Box::new((
                        spend.signature.clone(),
                        shutdown_condition_program.into(),
                    )));

                    pending_shutdown =
                        Some((state_channel_coin.clone(), want_puzzle_hash, want_amount));
                }
                GameAction::SendPotato => {
                    unreachable!("SendPotato should not be queued");
                }
                #[cfg(test)]
                GameAction::ForcedSelfAccept(game_id) => {
                    let ch = self.channel_handler_mut()?;
                    ch.send_accept_proposal(&game_id)?;
                    batch_actions.push(BatchAction::AcceptProposal(game_id));
                }
            }
        }

        self.game_action_queue = deferred;

        if batch_actions.is_empty() && clean_shutdown_data.is_none() {
            return Ok((false, effects));
        }

        let sigs = {
            let ch = self.channel_handler_mut()?;
            ch.update_cached_unroll_state(env)?
        };

        {
            let ch = self.channel_handler()?;
            effects.push(Effect::Log(make_send_log(
                ch,
                &batch_actions,
                clean_shutdown_data.is_some(),
            )));
        }

        self.have_potato = PotatoState::Absent;
        effects.push(Effect::PeerBatch {
            actions: batch_actions,
            signatures: sigs,
            clean_shutdown: clean_shutdown_data,
        });

        if let Some((coin, puzzle_hash, amount)) = pending_shutdown {
            let handler = crate::potato_handler::spend_channel_coin_handler::SpendChannelCoinHandler::new_for_clean_shutdown(
                self.channel_handler.take(),
                coin,
                puzzle_hash,
                amount,
                std::mem::take(&mut self.game_action_queue),
                self.have_potato.clone(),
                self.channel_timeout.clone(),
                self.unroll_timeout.clone(),
                self.last_channel_coin_spend_info.take(),
            );
            self.channel_spend_replacement = Some(Box::new(handler));
        }

        Ok((true, effects))
    }

    fn get_games_by_start_type(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        i_initiated: bool,
        game_id: &GameID,
        game_start: &GameStart,
    ) -> Result<GameStartInfoPair, Error> {
        let starter = if let Some(starter) = self.game_types.get(&game_start.game_type) {
            starter
        } else {
            return Err(Error::StrErr(format!(
                "no such game {:?}",
                game_start.game_type
            )));
        };

        let their_contribution = game_start.amount.checked_sub(&game_start.my_contribution)?;

        if let Some(parser_prog) = &starter.parser_program {
            let alice_game = game::Game::new_from_proposal(
                env.allocator,
                i_initiated,
                game_id,
                starter.program.clone().into(),
                Some(parser_prog.clone().into()),
                &game_start.my_contribution,
            )?;
            let alice_result: Vec<Rc<GameStartInfo>> = alice_game
                .starts
                .iter()
                .map(|g| {
                    Rc::new(g.game_start(
                        game_id,
                        &game_start.amount,
                        &game_start.timeout,
                        &game_start.my_contribution,
                        &their_contribution,
                    ))
                })
                .collect();
            let bob_game = game::Game::new_from_proposal(
                env.allocator,
                !i_initiated,
                game_id,
                starter.program.clone().into(),
                Some(parser_prog.clone().into()),
                &game_start.my_contribution,
            )?;
            let bob_result: Vec<Rc<GameStartInfo>> = bob_game
                .starts
                .iter()
                .map(|g| {
                    Rc::new(g.game_start(
                        game_id,
                        &game_start.amount,
                        &game_start.timeout,
                        &their_contribution,
                        &game_start.my_contribution,
                    ))
                })
                .collect();
            Ok((alice_result, bob_result))
        } else {
            let program_run_args = (
                game_start.my_contribution.clone(),
                (
                    their_contribution.clone(),
                    (Rc::new(game_start.parameters.clone()), ()),
                ),
            )
                .to_clvm(env.allocator)
                .into_gen()?;
            let params_prog = Rc::new(Program::from_nodeptr(env.allocator, program_run_args)?);
            let alice_game = game::Game::new_program(
                env.allocator,
                i_initiated,
                game_id,
                starter.program.clone().into(),
                params_prog.clone(),
            )?;
            let alice_result: Vec<Rc<GameStartInfo>> = alice_game
                .starts
                .iter()
                .map(|g| {
                    Rc::new(g.game_start(
                        game_id,
                        &game_start.amount,
                        &game_start.timeout,
                        &game_start.my_contribution,
                        &their_contribution,
                    ))
                })
                .collect();
            let bob_game = game::Game::new_program(
                env.allocator,
                !i_initiated,
                game_id,
                starter.program.clone().into(),
                params_prog,
            )?;
            let bob_result: Vec<Rc<GameStartInfo>> = bob_game
                .starts
                .iter()
                .map(|g| {
                    Rc::new(g.game_start(
                        game_id,
                        &game_start.amount,
                        &game_start.timeout,
                        &their_contribution,
                        &game_start.my_contribution,
                    ))
                })
                .collect();
            Ok((alice_result, bob_result))
        }
    }

    const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024; // 10 MiB

    pub fn received_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        let incoming_result = if msg.len() > Self::MAX_MESSAGE_SIZE {
            Err(Error::StrErr(format!(
                "message too large: {} bytes (max {})",
                msg.len(),
                Self::MAX_MESSAGE_SIZE,
            )))
        } else {
            let msg_envelope: PeerMessage = bencodex::from_slice(&msg).into_gen()?;
            self.incoming_messages.push_back(Rc::new(msg_envelope));
            self.process_incoming_message(env)
        };
        let mut effects = Vec::new();
        match incoming_result {
            Ok(incoming_effects) => {
                effects.extend(incoming_effects);
            }
            Err(e) => {
                effects.push(Effect::Log(format!(
                    "[going-on-chain] error processing peer message: {e:?}"
                )));
                effects.extend(self.go_on_chain(env, true)?);
                return Ok(effects);
            }
        }
        Ok(effects)
    }

    pub fn process_incoming_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        let msg_envelope = if let Some(msg) = self.incoming_messages.pop_front() {
            msg
        } else {
            return Ok(effects);
        };

        match msg_envelope.borrow() {
            PeerMessage::HandshakeF { .. } => {}

            PeerMessage::RequestPotato(_) => {
                self.peer_wants_potato = true;
                if matches!(self.have_potato, PotatoState::Present) {
                    let sigs = {
                        let ch = self.channel_handler_mut()?;
                        ch.send_empty_potato(env)?
                    };
                    {
                        let ch = self.channel_handler()?;
                        effects.push(Effect::Log(make_send_log(ch, &[], false)));
                    }
                    effects.push(Effect::PeerBatch {
                        actions: vec![],
                        signatures: sigs,
                        clean_shutdown: None,
                    });
                    self.have_potato = PotatoState::Absent;
                    self.peer_wants_potato = false;
                }
            }
            PeerMessage::Batch { .. } => {
                if matches!(self.have_potato, PotatoState::Present) {
                    return Err(Error::StrErr(
                        "received batch while we hold the potato (double-potato)".to_string(),
                    ));
                }
                effects.extend(self.pass_on_channel_handler_message(env, msg_envelope)?);
            }
            _ => {
                effects.extend(self.pass_on_channel_handler_message(env, msg_envelope)?);
            }
        }

        Ok(effects)
    }

    fn check_channel_spent(&mut self, coin_id: &CoinString) -> Result<(bool, Vec<Effect>), Error> {
        let channel_coin = self
            .channel_handler
            .as_ref()
            .map(|ch| ch.state_channel_coin().clone());

        if let Some(channel_coin) = channel_coin {
            if *coin_id == channel_coin {
                let log_effect =
                    Effect::Log(format!("[channel-coin-spent] {}", format_coin(coin_id)));
                let handler = crate::potato_handler::spend_channel_coin_handler::SpendChannelCoinHandler::new_at_channel_conditions(
                    self.channel_handler.take(),
                    channel_coin,
                    std::mem::take(&mut self.game_action_queue),
                    self.have_potato.clone(),
                    self.channel_timeout.clone(),
                    self.unroll_timeout.clone(),
                );
                self.channel_spend_replacement = Some(Box::new(handler));

                return Ok((
                    true,
                    vec![
                        log_effect,
                        Effect::RequestPuzzleAndSolution(coin_id.clone()),
                    ],
                ));
            }
        }
        Ok((false, vec![]))
    }

    /// Submit transactions to move the channel on-chain.  Normal blockchain
    /// monitoring will detect the channel coin spend and route through
    /// `handle_channel_coin_spent`, the same path used when the opponent
    /// initiates the unroll.
    pub fn go_on_chain(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        got_error: bool,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();

        {
            let player_ch = self.channel_handler_mut()?;
            let cancelled_ids = player_ch.cancel_all_proposals();
            for id in cancelled_ids {
                effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                    id,
                    reason: CancelReason::WentOnChain,
                }));
            }
        }

        {
            let saved = self.last_channel_coin_spend_info.as_ref().ok_or_else(|| {
                Error::StrErr("go_on_chain: no channel coin spend info cached".to_string())
            })?;
            let ch = self.channel_handler()?;
            let coin = ch.state_channel_coin().clone();
            let bundle = crate::potato_handler::handler_base::build_channel_to_unroll_bundle(
                env,
                ch,
                &coin,
                saved,
                "go on chain unroll",
            )?;
            effects.push(Effect::SpendTransaction(bundle));
        }

        let channel_coin = {
            let ch = self.channel_handler()?;
            ch.state_channel_coin().clone()
        };

        let mut handler =
            crate::potato_handler::spend_channel_coin_handler::SpendChannelCoinHandler::new(
                self.channel_handler.take(),
                channel_coin,
                std::mem::take(&mut self.game_action_queue),
                self.have_potato.clone(),
                self.channel_timeout.clone(),
                self.unroll_timeout.clone(),
            );
        if got_error {
            handler.set_advisory(Some("error receiving peer message".to_string()));
        }
        self.channel_spend_replacement = Some(Box::new(handler));

        Ok(effects)
    }

    /// Build a channel-coin-to-unroll spend bundle regardless of current
    /// handshake state.  Used by test infrastructure to simulate a malicious
    /// peer that submits an unroll after agreeing to clean shutdown.
    pub fn force_unroll_spend(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<SpendBundle, Error> {
        let saved = self.last_channel_coin_spend_info.as_ref().ok_or_else(|| {
            Error::StrErr("force_unroll_spend: no channel coin spend info cached".to_string())
        })?;
        let ch = self.channel_handler()?;
        let coin = ch.state_channel_coin().clone();
        crate::potato_handler::handler_base::build_channel_to_unroll_bundle(
            env,
            ch,
            &coin,
            saved,
            "force unroll",
        )
    }

    #[cfg(test)]
    pub fn force_stale_unroll_spend(
        &self,
        env: &mut ChannelHandlerEnv<'_>,
        saved: &ChannelCoinSpendInfo,
    ) -> Result<SpendBundle, Error> {
        let ch = self.channel_handler()?;
        let coin = ch.state_channel_coin().clone();
        crate::potato_handler::handler_base::build_channel_to_unroll_bundle(
            env,
            ch,
            &coin,
            saved,
            "force stale unroll",
        )
    }

    fn do_game_action(&mut self, action: GameAction) -> Result<(bool, Vec<Effect>), Error> {
        self.push_action(action);
        let (_has_potato, effect) = self.send_potato_request_if_needed()?;
        Ok((false, effect.into_iter().collect()))
    }

    pub fn get_game_state_id(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Option<Hash>, Error> {
        let player_ch = self.channel_handler().ok();
        if let Some(player_ch) = player_ch {
            return player_ch.get_game_state_id(env).map(Some);
        }
        Ok(None)
    }
}

impl FromLocalUI for PotatoHandler {
    fn propose_game(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game: &GameStart,
    ) -> Result<(Vec<GameID>, Vec<Effect>), Error> {
        self.game_action_queue
            .retain(|a| !matches!(a, GameAction::CleanShutdown));

        // If a peer proposal is already pending, reject our local attempt
        // immediately. We should not cancel peer proposals as a side effect
        // of trying to propose while one is already pending.
        let has_pending_peer = {
            let ch = self.channel_handler()?;
            !ch.pending_peer_proposal_ids().is_empty()
        };
        if has_pending_peer {
            let (dbg_summary, cancelled_id) = {
                let ch = self.channel_handler_mut()?;
                let summary = ch.dbg_proposed_games_summary();
                let id = GameID(ch.allocate_my_nonce() as u64);
                (summary, id)
            };
            return Ok((
                vec![cancelled_id],
                vec![
                    Effect::Log(format!(
                        "DBG_ISSUE: propose_game BLOCKED cancelled_id={} {}",
                        cancelled_id, dbg_summary,
                    )),
                    Effect::Notify(GameNotification::ProposalCancelled {
                        id: cancelled_id,
                        reason: CancelReason::PeerProposalPending,
                    }),
                ],
            ));
        }

        let game_id = {
            let ch = self.channel_handler_mut()?;
            GameID(ch.allocate_my_nonce() as u64)
        };

        let (my_games, their_games) = self.get_games_by_start_type(env, true, &game_id, game)?;

        let (my_games, their_games) = if game.my_turn {
            (my_games, their_games)
        } else {
            (their_games, my_games)
        };

        let game_id_list: Vec<GameID> = my_games.iter().map(|g| g.game_id).collect();

        for (index, (mine, _theirs)) in my_games.into_iter().zip(their_games).enumerate() {
            let wire = WireProposeGame {
                start: game.clone(),
                game_id,
                start_index: index,
            };
            self.push_action(GameAction::QueuedProposal(mine, wire));
        }

        let (_has_potato, effect) = self.send_potato_request_if_needed()?;
        Ok((game_id_list, effect.into_iter().collect()))
    }

    fn accept_proposal(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        let (_continued, effects) =
            self.do_game_action(GameAction::QueuedAcceptProposal(*game_id))?;
        Ok(effects)
    }

    fn cancel_proposal(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        let (_continued, effects) =
            self.do_game_action(GameAction::QueuedCancelProposal(*game_id))?;
        Ok(effects)
    }

    fn make_move(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        let (_continued, effects) =
            self.do_game_action(GameAction::Move(*id, readable.clone(), new_entropy))?;

        Ok(effects)
    }

    fn accept_timeout(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        let (_continued, effects) = self.do_game_action(GameAction::AcceptTimeout(*id))?;

        Ok(effects)
    }

    fn shut_down(&mut self, _env: &mut ChannelHandlerEnv<'_>) -> Result<Vec<Effect>, Error> {
        let (_continued, effects) = self.do_game_action(GameAction::CleanShutdown)?;
        Ok(effects)
    }
}

impl SpendWalletReceiver for PotatoHandler {
    fn coin_created(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _coin: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        Ok(None)
    }

    fn coin_spent(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        let (_matched_ch, effects) = self.check_channel_spent(coin_id)?;
        Ok(effects)
    }

    fn coin_timeout_reached(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }

    fn coin_puzzle_and_solution(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _coin_id: &CoinString,
        _puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        Ok((vec![], None))
    }
}

#[typetag::serde]
impl PeerHandler for PotatoHandler {
    fn has_pending_incoming(&self) -> bool {
        PotatoHandler::has_pending_incoming(self)
    }
    fn process_incoming_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        PotatoHandler::process_incoming_message(self, env)
    }
    fn received_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        PotatoHandler::received_message(self, env, msg)
    }
    fn coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        <Self as SpendWalletReceiver>::coin_spent(self, env, coin_id)
    }
    fn coin_timeout_reached(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        <Self as SpendWalletReceiver>::coin_timeout_reached(self, env, coin_id)
    }
    fn coin_created(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        <Self as SpendWalletReceiver>::coin_created(self, env, coin_id)
    }
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
        <Self as SpendWalletReceiver>::coin_puzzle_and_solution(
            self,
            env,
            coin_id,
            puzzle_and_solution,
        )
    }
    fn make_move(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        <Self as FromLocalUI>::make_move(self, env, id, readable, new_entropy)
    }
    fn accept_timeout(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        <Self as FromLocalUI>::accept_timeout(self, env, id)
    }
    fn cheat_game(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        mover_share: Amount,
        entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        PotatoHandler::cheat_game(self, env, game_id, mover_share, entropy)
    }
    #[cfg(test)]
    fn self_accept_proposal(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        PotatoHandler::self_accept_proposal(self, env, game_id)
    }
    fn flush_pending_actions(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        PotatoHandler::flush_pending_actions(self, env)
    }
    fn take_replacement(&mut self) -> Option<Box<dyn PeerHandler>> {
        self.take_channel_spend_replacement()
            .map(|h| h as Box<dyn PeerHandler>)
    }
    fn handshake_finished(&self) -> bool {
        PotatoHandler::handshake_finished(self)
    }
    fn propose_game(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game: &GameStart,
    ) -> Result<(Vec<GameID>, Vec<Effect>), Error> {
        <Self as FromLocalUI>::propose_game(self, env, game)
    }
    fn accept_proposal(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        <Self as FromLocalUI>::accept_proposal(self, env, game_id)
    }
    fn cancel_proposal(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        <Self as FromLocalUI>::cancel_proposal(self, env, game_id)
    }
    fn shut_down(&mut self, env: &mut ChannelHandlerEnv<'_>) -> Result<Vec<Effect>, Error> {
        <Self as FromLocalUI>::shut_down(self, env)
    }
    fn go_on_chain(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        got_error: bool,
    ) -> Result<Vec<Effect>, Error> {
        PotatoHandler::go_on_chain(self, env, got_error)
    }
    fn channel_status_snapshot(&self) -> Option<ChannelStatusSnapshot> {
        let ch = self.channel_handler.as_ref()?;
        let shutting_down = self
            .game_action_queue
            .iter()
            .any(|a| matches!(a, GameAction::CleanShutdown));
        Some(ChannelStatusSnapshot {
            state: if shutting_down {
                ChannelState::ShuttingDown
            } else {
                ChannelState::Active
            },
            advisory: None,
            coin: Some(ch.state_channel_coin().clone()),
            our_balance: Some(ch.my_out_of_game_balance()),
            their_balance: Some(ch.their_out_of_game_balance()),
            game_allocated: Some(ch.total_game_allocated()),
            have_potato: Some(matches!(self.have_potato, PotatoState::Present)),
        })
    }
    fn channel_handler(&self) -> Result<&ChannelHandler, Error> {
        PotatoHandler::channel_handler(self)
    }
    fn as_any(&self) -> &dyn std::any::Any {
        self
    }
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any {
        self
    }
}
