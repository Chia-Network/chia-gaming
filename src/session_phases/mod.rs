use std::borrow::Borrow;
use std::collections::{BTreeMap, VecDeque};

use std::rc::Rc;

use clvm_traits::ToClvm;
use serde::{Deserialize, Serialize};

use crate::channel_state::game;
use crate::channel_state::game_start_info::GameStartInfo;
use crate::channel_state::types::{
    ChannelCoinSpendInfo, ChannelEnv, ChannelPrivateKeys, MoveResult, ReadableMove,
    StateUpdateSignatures,
};
use crate::channel_state::ChannelState;
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinString, Error, GameID, GameType, Hash, IntoErr, Program,
    ProgramRef, PuzzleHash, SpendBundle, Timeout,
};
use crate::session_phases::effects::{
    format_coin, AcceptedGameMember, CancelReason, ChannelStatus, ChannelStatusSnapshot,
    CoinOfInterest, Effect, FailedGameAction, GameNotification, GameStatusKind,
    GameStatusOtherParams, LocalActionKind, SettlementOutcome, TimeoutClaimSemantic,
};
use crate::shutdown::{complete_shutdown_spend, get_conditions_with_channel_state};

use crate::game_session::{phase_operation_error, PeerLifecyclePhase};
use crate::session_phases::types::{
    validate_new_move_action, BatchAction, FromLocalUI, GameAction, PeerMessage, PeerMove,
    PotatoState, WireProposalGroup,
};

use crate::session_phases::proposal::GameProposal;

pub mod effects;
pub mod game_collection;
pub mod handler_base;
pub mod handshake;
pub mod handshake_initiator;
pub mod handshake_receiver;
pub mod on_chain;
pub mod peer_wire;
pub mod proposal;
pub mod spend_channel_coin_phase;
pub mod types;
pub mod wallet_traits;

pub use game_collection::game_collection;
pub use wallet_traits::{ChannelFundingWallet, SpendWalletReceiver, WalletSpendInterface};

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
/// First peer creates the game by giving channel_state the game definitions.
/// second peer receives the game start from the first peer and stores it.
///
/// When the channel handler game start is reeived, we must receive a matching datum to
/// the one we receive in the channel handler game start.  If we receive that, we allow
/// the message through to the channel handler.
#[derive(Serialize, Deserialize)]
pub struct OffChainPhase {
    initiator: bool,
    have_potato: PotatoState,

    game_action_queue: VecDeque<GameAction>,
    /// Diagnostic context for an error while draining a local queued action.
    /// This is transient host state, not protocol or persisted game state.
    #[serde(skip, default)]
    last_failed_queued_action: Option<(GameID, FailedGameAction)>,

    channel_state: Option<ChannelState>,

    #[serde(skip, default)]
    game_types: BTreeMap<GameType, ProgramRef>,

    private_keys: ChannelPrivateKeys,

    my_contribution: Amount,

    their_contribution: Amount,

    reward_puzzle_hash: PuzzleHash,

    channel_timeout: Timeout,
    // Unroll timeout
    unroll_timeout: Timeout,

    incoming_messages: VecDeque<Rc<PeerMessage>>,

    peer_wants_potato: bool,

    last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,

    pending_clean_shutdown: Option<(CoinString, ProgramRef)>,

    last_height: u64,

    #[serde(skip)]
    channel_spend_next_phase:
        Option<Box<crate::session_phases::spend_channel_coin_phase::SpendChannelCoinPhase>>,
}

fn failed_game_action_context(action: &GameAction) -> Option<(GameID, FailedGameAction)> {
    match action {
        GameAction::Move(id, ..) => Some((*id, FailedGameAction::MakeMove)),
        GameAction::AcceptSettlement(id) => Some((*id, FailedGameAction::AcceptSettlement)),
        GameAction::Cheat(id, ..) => Some((*id, FailedGameAction::Cheat)),
        _ => None,
    }
}

struct DrainQueueFailure {
    queue_index: Option<usize>,
    action: Option<GameAction>,
    source: Error,
}

enum AcceptanceOutcome {
    Accepted(Vec<AcceptedGameMember>),
    Insufficient {
        local_id: GameID,
        origin_wire_id: GameID,
        our_balance_short: bool,
        their_balance_short: bool,
    },
}

fn format_batch_action(action: &BatchAction) -> String {
    match action {
        BatchAction::ProposeGroup(group) => {
            format!(
                "ProposeGroup wire_id={} type={} timeout={}",
                group.origin_wire_id, group.start.game_type, group.start.timeout,
            )
        }
        BatchAction::AcceptProposalGroup(id) => format!("AcceptProposalGroup id={id}"),
        BatchAction::CancelProposalGroup(id) => format!("CancelProposalGroup id={id}"),
        BatchAction::Move(id, details) => {
            format!("Move id={id} mover_share={}", details.mover_share)
        }
        BatchAction::AcceptSettlement(id, amount) => {
            format!("AcceptSettlement id={id} amt={amount}")
        }
    }
}

fn peer_move_from_result(move_result: MoveResult) -> Result<PeerMove, Error> {
    Ok(PeerMove {
        move_made: move_result.game_move.basic.move_made,
        mover_share: move_result.game_move.basic.mover_share,
    })
}

pub(crate) fn format_reward_coin(label: &str, ph: &PuzzleHash, amount: &Amount) -> Option<String> {
    if *amount == Amount::default() {
        return None;
    }
    Some(format!("{label} ph={ph} amt={amount}"))
}

pub(crate) fn make_send_log(
    ch: &ChannelState,
    actions: &[BatchAction],
    clean_shutdown: bool,
) -> String {
    let kind = if clean_shutdown {
        "send-clean-shutdown"
    } else {
        "send"
    };
    let mut parts = vec![format!("[{kind}] state={}", ch.state_number())];
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

impl OffChainPhase {
    fn ensure_game_types(&mut self, allocator: &mut AllocEncoder) {
        if self.game_types.is_empty() {
            self.game_types = crate::session_phases::game_collection::game_collection(allocator);
        }
    }

    fn execute_acceptance(
        &mut self,
        env: &mut ChannelEnv<'_>,
        local_id: GameID,
        local_is_proposer: bool,
        cache_for_redo: bool,
    ) -> Result<AcceptanceOutcome, Error> {
        let proposal = self
            .channel_state()?
            .find_proposal(&local_id)
            .cloned()
            .ok_or_else(|| Error::StrErr(format!("no proposal with id {local_id:?}")))?;
        if self.channel_state()?.is_our_proposal(&local_id) != local_is_proposer {
            return Err(Error::StrErr(
                "proposal accepter/origin mismatch".to_string(),
            ));
        }
        self.ensure_game_types(env.allocator);
        let factory = self
            .game_types
            .get(&proposal.game_type)
            .ok_or_else(|| Error::StrErr(format!("no such game {:?}", proposal.game_type)))?;
        let game_parameters = proposal.parameters.to_program(env.allocator)?;
        let game_parameters = game_parameters.to_clvm(env.allocator).into_gen()?;
        let (proposer_reserve, accepter_reserve) = if local_is_proposer {
            (
                self.channel_state()?.my_out_of_game_balance(),
                self.channel_state()?.their_out_of_game_balance(),
            )
        } else {
            (
                self.channel_state()?.their_out_of_game_balance(),
                self.channel_state()?.my_out_of_game_balance(),
            )
        };
        let arguments = (
            proposer_reserve.clone(),
            (
                accepter_reserve.clone(),
                (crate::common::types::Node(game_parameters), ()),
            ),
        )
            .to_clvm(env.allocator)
            .into_gen()?;
        let arguments = Program::from_nodeptr(env.allocator, arguments)?;
        match game::Game::run_factory(env.allocator, factory.clone().into(), &arguments)? {
            game::FactoryResult::InsufficientBalance {
                proposer_balance_short,
                accepter_balance_short,
            } => Ok(AcceptanceOutcome::Insufficient {
                local_id,
                origin_wire_id: proposal.id,
                our_balance_short: if local_is_proposer {
                    proposer_balance_short
                } else {
                    accepter_balance_short
                },
                their_balance_short: if local_is_proposer {
                    accepter_balance_short
                } else {
                    proposer_balance_short
                },
            }),
            game::FactoryResult::Success(games) => {
                let first_hash = games[0].initial_validation_program_hash().clone();
                if &first_hash != proposal.game_type.hash() {
                    return Err(Error::StrErr(format!(
                        "factory for {} returned first validator hash {}, expected {}",
                        proposal.game_type, first_hash, proposal.game_type
                    )));
                }
                let (proposer_required, accepter_required) =
                    games
                        .iter()
                        .try_fold((0u64, 0u64), |(proposer, accepter), game| {
                            Ok::<_, Error>((
                                proposer
                                    .checked_add(game.proposer_contribution.to_u64())
                                    .ok_or_else(|| {
                                        Error::StrErr(
                                            "factory proposer contributions overflow".into(),
                                        )
                                    })?,
                                accepter
                                    .checked_add(game.accepter_contribution.to_u64())
                                    .ok_or_else(|| {
                                        Error::StrErr(
                                            "factory accepter contributions overflow".into(),
                                        )
                                    })?,
                            ))
                        })?;
                let proposer_balance_short = proposer_required > proposer_reserve.to_u64();
                let accepter_balance_short = accepter_required > accepter_reserve.to_u64();
                if proposer_balance_short || accepter_balance_short {
                    return Ok(AcceptanceOutcome::Insufficient {
                        local_id,
                        origin_wire_id: proposal.id,
                        our_balance_short: if local_is_proposer {
                            proposer_balance_short
                        } else {
                            accepter_balance_short
                        },
                        their_balance_short: if local_is_proposer {
                            accepter_balance_short
                        } else {
                            proposer_balance_short
                        },
                    });
                }
                let ids = self.channel_state_mut()?.allocate_game_ids(games.len())?;
                let local_is_player_a = if local_is_proposer {
                    proposal.sender_is_player_a
                } else {
                    !proposal.sender_is_player_a
                };
                let starts: Vec<Rc<GameStartInfo>> = games
                    .iter()
                    .zip(&ids)
                    .map(|(factory_game, id)| {
                        Rc::new(factory_game.game_start(
                            id,
                            &proposal.timeout,
                            proposal.sender_is_player_a,
                            local_is_player_a,
                        ))
                    })
                    .collect();
                let members = starts
                    .iter()
                    .zip(&games)
                    .map(|(start, factory_game)| AcceptedGameMember {
                        id: start.game_id,
                        player_a_contribution: start.player_a_contribution.clone(),
                        player_b_contribution: start.player_b_contribution.clone(),
                        our_turn: start.is_my_turn(),
                        readable_parameters: factory_game.readable_parameters.clone(),
                    })
                    .collect();
                self.channel_state_mut()?.accept_proposal_games(
                    env,
                    &local_id,
                    &starts,
                    cache_for_redo,
                )?;
                Ok(AcceptanceOutcome::Accepted(members))
            }
        }
    }

    pub fn from_completed_handshake(
        initiator: bool,
        channel_state: ChannelState,
        game_types: BTreeMap<GameType, ProgramRef>,
        private_keys: ChannelPrivateKeys,
        my_contribution: Amount,
        their_contribution: Amount,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
        reward_puzzle_hash: PuzzleHash,
        incoming_messages: VecDeque<Rc<PeerMessage>>,
        last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,
        last_height: u64,
    ) -> OffChainPhase {
        let have_potato = if channel_state.have_potato() {
            PotatoState::Present
        } else {
            PotatoState::Absent
        };
        let game_types = if game_types.is_empty() {
            let mut allocator = AllocEncoder::new();
            crate::session_phases::game_collection::game_collection(&mut allocator)
        } else {
            game_types
        };
        OffChainPhase {
            initiator,
            have_potato,
            game_types,
            game_action_queue: VecDeque::default(),
            last_failed_queued_action: None,
            channel_state: Some(channel_state),
            private_keys,
            my_contribution,
            their_contribution,
            channel_timeout,
            unroll_timeout,
            reward_puzzle_hash,
            incoming_messages,
            peer_wants_potato: false,
            last_channel_coin_spend_info,
            pending_clean_shutdown: None,
            last_height,
            channel_spend_next_phase: None,
        }
    }

    pub fn take_channel_spend_next_phase(
        &mut self,
    ) -> Option<Box<crate::session_phases::spend_channel_coin_phase::SpendChannelCoinPhase>> {
        self.channel_spend_next_phase.take()
    }

    pub fn is_failed(&self) -> bool {
        false
    }

    pub(crate) fn cheat_game(
        &mut self,
        _env: &mut ChannelEnv<'_>,
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
        _env: &mut ChannelEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        let (_continued, effects) = self.do_game_action(GameAction::ForcedSelfAccept(*game_id))?;
        Ok(effects)
    }

    pub fn has_queued_message(&self) -> bool {
        !self.incoming_messages.is_empty()
    }

    pub fn push_action(&mut self, action: GameAction) {
        self.game_action_queue.push_back(action);
    }

    pub fn is_initiator(&self) -> bool {
        self.initiator
    }

    pub fn channel_state(&self) -> Result<&ChannelState, Error> {
        self.channel_state
            .as_ref()
            .ok_or_else(|| Error::StrErr("no channel handler".to_string()))
    }

    fn channel_state_mut(&mut self) -> Result<&mut ChannelState, Error> {
        self.channel_state
            .as_mut()
            .ok_or_else(|| Error::StrErr("no channel handler".to_string()))
    }

    pub fn handshake_finished(&self) -> bool {
        true
    }

    #[cfg(test)]
    pub fn corrupt_state_for_testing(&mut self, new_sn: usize) -> Result<(), Error> {
        let ch = self.channel_state_mut()?;
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
        env: &mut ChannelEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        self.last_failed_queued_action = None;
        if !self.has_potato() || self.game_action_queue.is_empty() {
            return Ok(vec![]);
        }
        match self.drain_queue_into_batch(env) {
            Ok((_sent, effects)) => Ok(effects),
            Err(failure) => {
                let DrainQueueFailure {
                    queue_index,
                    action,
                    source,
                } = *failure;
                self.last_failed_queued_action =
                    action.as_ref().and_then(failed_game_action_context);
                if let Some(failed_index) = queue_index {
                    if failed_index >= self.game_action_queue.len() {
                        return Err(Error::StrErr(
                            "failed queued action index exceeds restored local drain queue"
                                .to_string(),
                        ));
                    }
                    self.game_action_queue.remove(failed_index);
                }
                Err(source)
            }
        }
    }

    pub fn take_failed_queued_action(&mut self) -> Option<(GameID, FailedGameAction)> {
        self.last_failed_queued_action.take()
    }

    pub fn get_reward_puzzle_hash(&self, env: &mut ChannelEnv<'_>) -> Result<PuzzleHash, Error> {
        let player_ch = self.channel_state()?;
        player_ch.get_reward_puzzle_hash(env)
    }

    fn update_channel_coin_after_receive(
        &mut self,
        env: &mut ChannelEnv<'_>,
        spend: &ChannelCoinSpendInfo,
        send_back: bool,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        self.have_potato = PotatoState::Present;

        self.last_channel_coin_spend_info = Some(spend.clone());

        {
            let ch = self.channel_state_mut()?;
            for (id, amount, _game_finished) in ch.drain_cached_accept_settlements() {
                effects.push(Effect::Notify(GameNotification::game_settled(
                    id,
                    SettlementOutcome::AcceptSettlement,
                    amount,
                    None,
                )));
            }
        }

        if send_back
            && self.channel_state()?.get_their_current_share() == Amount::default()
            && !self.channel_state()?.has_active_games()
        {
            self.game_action_queue.push_back(GameAction::CleanShutdown);
        }

        let (sent, batch_effects) = loop {
            match self.drain_queue_into_batch(env) {
                Ok(result) => break result,
                Err(failure) => {
                    let DrainQueueFailure {
                        queue_index,
                        action: failed_action,
                        source,
                    } = *failure;
                    let Some((failed_index, failed_action)) =
                        queue_index.zip(failed_action.as_ref())
                    else {
                        return Err(source);
                    };
                    let Some((id, action)) = failed_game_action_context(failed_action) else {
                        return Err(source);
                    };
                    if failed_index >= self.game_action_queue.len() {
                        return Err(Error::StrErr(
                            "failed queued action index exceeds restored local drain queue"
                                .to_string(),
                        ));
                    }
                    self.game_action_queue.remove(failed_index);
                    effects.push(Effect::Notify(GameNotification::ActionFailed {
                        id: Some(id),
                        action: Some(action),
                        reason: format!("{source:?}"),
                    }));
                }
            }
        };
        effects.extend(batch_effects);
        if sent {
            return Ok(effects);
        }

        if self.peer_wants_potato {
            self.peer_wants_potato = false;
            let sigs = {
                let ch = self.channel_state_mut()?;
                ch.send_empty_potato(env)?
            };
            {
                let ch = self.channel_state()?;
                effects.push(Effect::Log(make_send_log(ch, &[], false)));
            }
            effects.push(Effect::PeerBatch {
                actions: vec![],
                signatures: sigs,
            });
            self.have_potato = PotatoState::Absent;
            return Ok(effects);
        }

        if send_back {
            let sigs = {
                let ch = self.channel_state_mut()?;
                ch.send_empty_potato(env)?
            };
            {
                let ch = self.channel_state()?;
                effects.push(Effect::Log(make_send_log(ch, &[], false)));
            }
            effects.push(Effect::PeerBatch {
                actions: vec![],
                signatures: sigs,
            });
            self.have_potato = PotatoState::Absent;
            return Ok(effects);
        }

        Ok(effects)
    }

    fn pass_on_channel_state_message(
        &mut self,
        env: &mut ChannelEnv<'_>,
        msg_envelope: Rc<PeerMessage>,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        let timeout = self.channel_timeout.clone();

        match msg_envelope.borrow() {
            PeerMessage::Batch {
                actions,
                signatures,
            } => {
                let ch_snapshot = self.channel_state.clone();
                let queue_snapshot = self.game_action_queue.clone();
                match self.process_received_batch(env, &timeout, actions, signatures) {
                    Ok(batch_effects) => {
                        effects.extend(batch_effects);
                    }
                    Err(e) => {
                        self.channel_state = ch_snapshot;
                        self.game_action_queue = queue_snapshot;
                        return Err(e);
                    }
                }
            }
            PeerMessage::CleanShutdown { channel_half_sig } => {
                let ch_snapshot = self.channel_state.clone();
                let queue_snapshot = self.game_action_queue.clone();
                match self.process_received_clean_shutdown(env, channel_half_sig) {
                    Ok(shutdown_effects) => effects.extend(shutdown_effects),
                    Err(error) => {
                        self.channel_state = ch_snapshot;
                        self.game_action_queue = queue_snapshot;
                        return Err(error);
                    }
                }
            }
            PeerMessage::Message(game_id, message) => {
                let decoded_message = {
                    let ch = self.channel_state_mut()?;
                    ch.received_message(env, game_id, message)?
                };
                let status = {
                    let ch = self.channel_state()?;
                    match ch.game_is_my_turn(game_id) {
                        Some(true) => GameStatusKind::MyTurn,
                        Some(false) => GameStatusKind::TheirTurn,
                        None => {
                            return Err(Error::StrErr(format!(
                                "received_message: no turn mapping for game {:?}",
                                game_id
                            )));
                        }
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
                        forfeited: None,
                        submitting_timeout_claim: None,
                    }),
                }));
            }
            PeerMessage::CleanShutdownComplete { channel_half_sig } => {
                let (expected_coin, expected_solution) = self
                    .pending_clean_shutdown
                    .as_ref()
                    .ok_or_else(|| {
                        Error::StrErr(
                            "received clean shutdown completion without a pending shutdown"
                                .to_string(),
                        )
                    })?
                    .clone();
                let coin_spend = {
                    let ch = self.channel_state()?;
                    complete_shutdown_spend(env, ch, channel_half_sig)?.0
                };
                if coin_spend.coin != expected_coin
                    || coin_spend.bundle.solution != expected_solution
                {
                    return Err(Error::StrErr(
                        "completed clean shutdown does not match pending canonical spend"
                            .to_string(),
                    ));
                }
                let bundle = SpendBundle {
                    name: Some("Clean shutdown".to_string()),
                    spends: vec![coin_spend],
                };
                bundle.validate_consensus(&env.agg_sig_me_additional_data, self.last_height)?;
                let zero_payout = self
                    .channel_state()
                    .is_ok_and(|channel| channel.has_zero_payout());
                if zero_payout {
                    effects.push(Effect::CompleteZeroPayoutShutdown);
                } else {
                    effects.push(Effect::SpendTransaction(bundle, None));
                }
                if let Some((coin, shutdown_solution)) = self.pending_clean_shutdown.take() {
                    let handler = crate::session_phases::spend_channel_coin_phase::SpendChannelCoinPhase::new_for_clean_shutdown(
                        self.channel_state.take(),
                        coin,
                        shutdown_solution,
                        std::mem::take(&mut self.game_action_queue),
                        self.have_potato.clone(),
                        self.channel_timeout.clone(),
                        self.unroll_timeout.clone(),
                        self.last_channel_coin_spend_info.take(),
                    );
                    self.channel_spend_next_phase = Some(Box::new(handler));
                }
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
        env: &mut ChannelEnv<'_>,
        _timeout: &Timeout,
        actions: &[BatchAction],
        signatures: &StateUpdateSignatures,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        let mut accepted_groups = Vec::new();

        for action in actions.iter() {
            match action {
                BatchAction::ProposeGroup(wire) => {
                    let cancelled: Vec<GameID> = self
                        .game_action_queue
                        .iter()
                        .filter_map(|a| match a {
                            GameAction::QueuedProposalGroup(local_id, _) => Some(*local_id),
                            _ => None,
                        })
                        .filter(|local_id| {
                            !self.game_action_queue.iter().any(|action| {
                                matches!(
                                    action,
                                    GameAction::QueuedCancelProposalGroupSilently(cancelled_id)
                                        if cancelled_id == local_id
                                )
                            })
                        })
                        .collect();
                    for id in cancelled {
                        self.game_action_queue
                            .push_back(GameAction::QueuedCancelProposalGroupSilently(id));
                        effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                            id,
                            group_ids: vec![id],
                            reason: CancelReason::SupersededByIncoming,
                        }));
                    }

                    let local_id = self
                        .channel_state_mut()?
                        .record_received_proposal(wire.origin_wire_id, &wire.start)?;
                    self.ensure_game_types(env.allocator);
                    if !self.game_types.contains_key(&wire.start.game_type) {
                        effects.push(Effect::Log(format!(
                            "declining proposal for unknown game type {:?}",
                            wire.start.game_type,
                        )));
                        self.game_action_queue
                            .push_back(GameAction::QueuedCancelProposalGroupSilently(local_id));
                    } else {
                        effects.push(Effect::Notify(GameNotification::ProposalMade {
                            id: local_id,
                            group_ids: vec![local_id],
                            sender_is_player_a: wire.start.sender_is_player_a,
                            timeout: wire.start.timeout.clone(),
                            game_type: wire.start.game_type.clone(),
                            parameters: wire.start.parameters.clone(),
                        }));
                    }
                }
                BatchAction::AcceptProposalGroup(origin_wire_id) => {
                    let local_id = *origin_wire_id;
                    match self.execute_acceptance(env, local_id, true, false)? {
                        AcceptanceOutcome::Accepted(members) => {
                            accepted_groups.push((local_id, members));
                        }
                        AcceptanceOutcome::Insufficient { .. } => {
                            return Err(Error::StrErr(format!(
                                "peer accepted proposal {origin_wire_id:?} that factory reports insufficient"
                            )));
                        }
                    }
                }
                BatchAction::CancelProposalGroup(origin_wire_id) => {
                    let proposal = self.channel_state_mut()?.remove_proposal(origin_wire_id)?;
                    let transient_proposal = effects.iter().position(|effect| {
                        matches!(
                            effect,
                            Effect::Notify(GameNotification::ProposalMade { id, .. })
                                if *id == proposal.id
                        )
                    });
                    if let Some(index) = transient_proposal {
                        effects.remove(index);
                    } else {
                        effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                            id: proposal.id,
                            group_ids: vec![proposal.id],
                            reason: CancelReason::CancelledByPeer,
                        }));
                    }
                }
                BatchAction::Move(game_id, game_move) => {
                    let move_result = {
                        let ch = self.channel_state_mut()?;
                        ch.apply_received_move(
                            env,
                            game_id,
                            &game_move.move_made,
                            game_move.mover_share.clone(),
                        )?
                    };
                    let finished = {
                        let ch = self.channel_state()?;
                        ch.is_game_finished(game_id)?
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
                            forfeited: None,
                            submitting_timeout_claim: None,
                        }),
                    }));
                    if !move_result.message.is_empty() {
                        effects.push(Effect::PeerGameMessage(*game_id, move_result.message));
                    }
                    if finished {
                        self.game_action_queue
                            .push_back(GameAction::AcceptSettlement(*game_id));
                    }
                }
                BatchAction::AcceptSettlement(game_id, _peer_amount) => {
                    let ch = self.channel_state_mut()?;
                    let (our_reward, _game_finished) =
                        ch.apply_received_accept_settlement(game_id)?;
                    effects.push(Effect::Notify(GameNotification::game_settled(
                        *game_id,
                        SettlementOutcome::AcceptSettlement,
                        our_reward,
                        None,
                    )));
                }
            }
        }

        let received_accept_settlement = actions
            .iter()
            .any(|a| matches!(a, BatchAction::AcceptSettlement(..)));

        let has_new_game = actions.iter().any(|a| {
            matches!(
                a,
                BatchAction::ProposeGroup(_) | BatchAction::AcceptProposalGroup(_)
            )
        });
        if has_new_game {
            self.game_action_queue
                .retain(|a| !matches!(a, GameAction::CleanShutdown));
        }

        let spend_info = {
            let ch = self.channel_state_mut()?;
            ch.verify_received_batch_signatures(env, signatures)?
        };

        {
            let ch = self.channel_state()?;
            let state_num = ch.state_number();
            let actions_str: Vec<String> = actions.iter().map(format_batch_action).collect();
            let mut parts = vec![format!("[recv] state={state_num}")];
            for a in &actions_str {
                parts.push(format!("  {a}"));
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
            received_accept_settlement,
        )?);
        effects.extend(accepted_groups.into_iter().map(|(id, members)| {
            Effect::Notify(GameNotification::ProposalAcceptedGroup { id, members })
        }));

        Ok(effects)
    }

    fn process_received_clean_shutdown(
        &mut self,
        env: &mut ChannelEnv<'_>,
        channel_half_sig: &Aggsig,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        if self.channel_state()?.has_active_games() {
            return Err(Error::StrErr(
                "opponent requested clean shutdown while games are active".to_string(),
            ));
        }

        {
            let ch = self.channel_state_mut()?;
            for group_ids in ch.cancel_all_proposals() {
                effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                    id: group_ids[0],
                    group_ids,
                    reason: CancelReason::CleanShutdown,
                }));
            }
        }

        let (coin_spend, local_half_sig, zero_payout) = {
            let ch = self.channel_state()?;
            let coin = ch.channel_coin().clone();
            let zero_payout = ch.has_zero_payout();
            let (coin_spend, local_half_sig) = complete_shutdown_spend(env, ch, channel_half_sig)?;
            debug_assert_eq!(coin_spend.coin, coin);
            (coin_spend, local_half_sig, zero_payout)
        };
        let bundle = SpendBundle {
            name: Some("Clean shutdown".to_string()),
            spends: vec![coin_spend.clone()],
        };
        bundle.validate_consensus(&env.agg_sig_me_additional_data, self.last_height)?;

        {
            let ch = self.channel_state_mut()?;
            for (id, amount, _game_finished) in ch.drain_cached_accept_settlements() {
                effects.push(Effect::Notify(GameNotification::game_settled(
                    id,
                    SettlementOutcome::AcceptSettlement,
                    amount,
                    None,
                )));
            }
        }

        if zero_payout {
            effects.push(Effect::QueueTerminalHandoff(local_half_sig));
        } else {
            effects.push(Effect::SpendTransaction(bundle, None));
            effects.push(Effect::PeerCleanShutdownComplete {
                channel_half_sig: local_half_sig,
            });
        }

        self.have_potato = PotatoState::Present;
        let handler = crate::session_phases::spend_channel_coin_phase::SpendChannelCoinPhase::new_for_clean_shutdown(
            self.channel_state.take(),
            coin_spend.coin,
            coin_spend.bundle.solution,
            std::mem::take(&mut self.game_action_queue),
            PotatoState::Present,
            self.channel_timeout.clone(),
            self.unroll_timeout.clone(),
            self.last_channel_coin_spend_info.take(),
        );
        self.channel_spend_next_phase = Some(Box::new(handler));
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
        env: &mut ChannelEnv<'_>,
    ) -> Result<(bool, Vec<Effect>), Box<DrainQueueFailure>> {
        let channel_snapshot = self.channel_state.clone();
        let queue_snapshot = self.game_action_queue.clone();
        let mut current_action = None;
        let result = self.drain_queue_into_batch_inner(env, &mut current_action);
        result.map_err(|source| {
            self.channel_state = channel_snapshot;
            self.game_action_queue = queue_snapshot;
            let (queue_index, action) = match current_action {
                Some((index, action)) => (Some(index), Some(action)),
                None => (None, None),
            };
            Box::new(DrainQueueFailure {
                queue_index,
                action,
                source,
            })
        })
    }

    fn drain_queue_into_batch_inner(
        &mut self,
        env: &mut ChannelEnv<'_>,
        current_action: &mut Option<(usize, GameAction)>,
    ) -> Result<(bool, Vec<Effect>), Error> {
        game_assert!(
            matches!(self.have_potato, PotatoState::Present),
            "drain_queue_into_batch: must have potato"
        );
        let mut effects = Vec::new();
        let mut batch_actions: Vec<BatchAction> = Vec::new();
        let mut deferred = VecDeque::new();
        let mut applied_actions = Vec::new();
        let mut request_potato_back = false;
        let mut queue_index = 0;

        while let Some(action) = self.game_action_queue.pop_front() {
            *current_action = Some((queue_index, action.clone()));
            queue_index += 1;
            match action {
                GameAction::Move(game_id, prepared) => {
                    let ch = self.channel_state_mut()?;
                    let game_is_my_turn = ch.game_is_my_turn(&game_id);
                    if let Some(true) = game_is_my_turn {
                        let move_result = ch.send_move_no_finalize(env, &game_id, prepared)?;
                        batch_actions.push(BatchAction::Move(
                            game_id,
                            peer_move_from_result(move_result)?,
                        ));
                        applied_actions.push((game_id, LocalActionKind::MakeMove));
                    } else {
                        game_assert!(
                            false,
                            "prepared move became stale before off-chain application"
                        );
                    }
                }
                GameAction::Cheat(game_id, mover_share, entropy) => {
                    let ch = self.channel_state_mut()?;
                    let game_is_my_turn = ch.game_is_my_turn(&game_id);
                    if let Some(true) = game_is_my_turn {
                        ch.enable_cheating_for_game(&game_id, &[0x80], mover_share)?;
                        let readable_move = ReadableMove::from_program(Rc::new(Program::nil()));
                        let prepared = ch.prepare_move(env, &game_id, &readable_move, entropy)?;
                        let move_result = ch.send_move_no_finalize(env, &game_id, prepared)?;
                        batch_actions.push(BatchAction::Move(
                            game_id,
                            peer_move_from_result(move_result)?,
                        ));
                        applied_actions.push((game_id, LocalActionKind::Cheat));
                    } else {
                        deferred.push_back(GameAction::Cheat(game_id, mover_share, entropy));
                    }
                }
                GameAction::AcceptSettlement(game_id) => {
                    let amount = {
                        let ch = self.channel_state_mut()?;
                        ch.send_accept_settlement_no_finalize(&game_id)?
                    };
                    batch_actions.push(BatchAction::AcceptSettlement(game_id, amount));
                    applied_actions.push((game_id, LocalActionKind::AcceptSettlement));
                }
                GameAction::QueuedProposalGroup(local_id, start) => {
                    let origin_wire_id = self
                        .channel_state_mut()?
                        .record_sent_proposal(local_id, &start)?;
                    batch_actions.push(BatchAction::ProposeGroup(WireProposalGroup {
                        origin_wire_id,
                        start,
                    }));
                }
                GameAction::QueuedAcceptProposalGroup(local_id) => {
                    let origin_wire_id = local_id;
                    match self.execute_acceptance(env, local_id, false, true)? {
                        AcceptanceOutcome::Accepted(members) => {
                            batch_actions.push(BatchAction::AcceptProposalGroup(origin_wire_id));
                            effects.push(Effect::Notify(GameNotification::ProposalAcceptedGroup {
                                id: local_id,
                                members,
                            }));
                        }
                        AcceptanceOutcome::Insufficient {
                            local_id,
                            origin_wire_id,
                            our_balance_short,
                            their_balance_short,
                        } => {
                            effects.push(Effect::Notify(GameNotification::InsufficientBalance {
                                id: local_id,
                                our_balance_short,
                                their_balance_short,
                            }));
                            self.channel_state_mut()?.remove_proposal(&local_id)?;
                            batch_actions.push(BatchAction::CancelProposalGroup(origin_wire_id));
                            *current_action = None;
                            continue;
                        }
                    }
                }
                GameAction::QueuedCancelProposalGroup(local_id) => {
                    let proposal = self.channel_state_mut()?.remove_proposal(&local_id)?;
                    effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                        id: local_id,
                        group_ids: vec![local_id],
                        reason: CancelReason::CancelledByUs,
                    }));
                    batch_actions.push(BatchAction::CancelProposalGroup(proposal.id));
                }
                GameAction::QueuedCancelProposalGroupSilently(local_id) => {
                    let proposal = self.channel_state_mut()?.remove_proposal(&local_id)?;
                    batch_actions.push(BatchAction::CancelProposalGroup(proposal.id));
                }
                GameAction::CleanShutdown => {
                    if !batch_actions.is_empty() {
                        deferred.push_back(GameAction::CleanShutdown);
                        deferred.append(&mut self.game_action_queue);
                        request_potato_back = true;
                        *current_action = None;
                        break;
                    }
                    {
                        let ch = self.channel_state()?;
                        if ch.has_active_games() {
                            return Err(Error::StrErr(
                                "cannot clean shutdown while games are active".to_string(),
                            ));
                        }
                    }
                    {
                        let ch = self.channel_state_mut()?;
                        let cancelled_groups = ch.cancel_all_proposals();
                        for group_ids in cancelled_groups {
                            effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                                id: group_ids[0],
                                group_ids,
                                reason: CancelReason::CleanShutdown,
                            }));
                        }
                    }

                    let real_conditions = {
                        let ch = self.channel_state_mut()?;
                        get_conditions_with_channel_state(env, ch)?
                    };
                    let (channel_coin, spend) = {
                        let ch = self.channel_state_mut()?;
                        let spend = ch.send_potato_clean_shutdown(env, real_conditions)?;
                        (ch.channel_coin().clone(), spend)
                    };

                    self.pending_clean_shutdown =
                        Some((channel_coin.clone(), spend.solution.clone()));
                    self.game_action_queue = deferred;
                    self.have_potato = PotatoState::Absent;
                    {
                        let ch = self.channel_state()?;
                        effects.push(Effect::Log(make_send_log(ch, &[], true)));
                    }
                    effects.push(Effect::PeerCleanShutdown {
                        channel_half_sig: spend.signature,
                    });
                    return Ok((true, effects));
                }
                #[cfg(test)]
                GameAction::ForcedSelfAccept(game_id) => {
                    batch_actions.push(BatchAction::AcceptProposalGroup(game_id));
                }
            }
            *current_action = None;
        }

        self.game_action_queue = deferred;

        if batch_actions.is_empty() {
            // No batch was packaged; deferred actions remain pending for a
            // future potato receipt, so this flush has no attributable failure.
            return Ok((false, effects));
        }

        let sigs = {
            let ch = self.channel_state_mut()?;
            ch.update_cached_unroll_state(env)?
        };

        effects.extend(applied_actions.into_iter().map(|(id, action)| {
            Effect::Notify(GameNotification::LocalActionApplied { id, action })
        }));

        {
            let ch = self.channel_state()?;
            effects.push(Effect::Log(make_send_log(ch, &batch_actions, false)));
        }

        self.have_potato = if request_potato_back {
            PotatoState::Requested
        } else {
            PotatoState::Absent
        };
        effects.push(Effect::PeerBatch {
            actions: batch_actions,
            signatures: sigs,
        });
        if request_potato_back {
            effects.push(Effect::PeerRequestPotato);
        }

        // Packaging and delivery intent succeeded. Later failures cannot be
        // attributed to a still-pending local action from this flush.
        Ok((true, effects))
    }

    const MAX_MESSAGE_SIZE: usize = handshake::MAX_PEER_MESSAGE_SIZE;

    pub fn received_message(
        &mut self,
        env: &mut ChannelEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        let incoming_result = if msg.len() > Self::MAX_MESSAGE_SIZE {
            Err(Error::StrErr(format!(
                "message too large: {} bytes (max {})",
                msg.len(),
                Self::MAX_MESSAGE_SIZE,
            )))
        } else {
            let msg_envelope = peer_wire::decode_peer_message(&msg)?;
            self.incoming_messages.push_back(Rc::new(msg_envelope));
            self.process_queued_message(env)
        };
        match incoming_result {
            Ok(effects) => Ok(effects),
            Err(error) => Ok(vec![
                Effect::Log(format!(
                    "[going-on-chain] error processing peer message: {error:?}"
                )),
                Effect::GoOnChainAfterPeerError,
            ]),
        }
    }

    pub fn process_queued_message(
        &mut self,
        env: &mut ChannelEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        let msg_envelope = if let Some(msg) = self.incoming_messages.pop_front() {
            msg
        } else {
            return Ok(effects);
        };

        if self.pending_clean_shutdown.is_some() {
            match msg_envelope.borrow() {
                PeerMessage::CleanShutdownComplete { .. } => {
                    effects.extend(self.pass_on_channel_state_message(env, msg_envelope)?);
                    return Ok(effects);
                }
                PeerMessage::RequestPotato(_) => {
                    return Ok(effects);
                }
                _ => {
                    return Err(Error::StrErr(format!(
                        "expected CleanShutdownComplete, got {msg_envelope:?}"
                    )));
                }
            }
        }

        match msg_envelope.borrow() {
            PeerMessage::HandshakeD(_) => {}

            PeerMessage::RequestPotato(_) => {
                self.peer_wants_potato = true;
                if matches!(self.have_potato, PotatoState::Present) {
                    let sigs = {
                        let ch = self.channel_state_mut()?;
                        ch.send_empty_potato(env)?
                    };
                    {
                        let ch = self.channel_state()?;
                        effects.push(Effect::Log(make_send_log(ch, &[], false)));
                    }
                    effects.push(Effect::PeerBatch {
                        actions: vec![],
                        signatures: sigs,
                    });
                    self.have_potato = PotatoState::Absent;
                    self.peer_wants_potato = false;
                }
            }
            PeerMessage::Batch { .. } | PeerMessage::CleanShutdown { .. } => {
                if matches!(self.have_potato, PotatoState::Present) {
                    return Err(Error::StrErr(
                        "received potato-bearing message while we hold the potato (double-potato)"
                            .to_string(),
                    ));
                }
                effects.extend(self.pass_on_channel_state_message(env, msg_envelope)?);
            }
            _ => {
                effects.extend(self.pass_on_channel_state_message(env, msg_envelope)?);
            }
        }

        Ok(effects)
    }

    fn check_channel_spent(&mut self, coin_id: &CoinString) -> Result<(bool, Vec<Effect>), Error> {
        let channel_coin = self
            .channel_state
            .as_ref()
            .map(|ch| ch.channel_coin().clone());

        if let Some(channel_coin) = channel_coin {
            if *coin_id == channel_coin {
                let log_effect =
                    Effect::Log(format!("[channel-coin-spent] {}", format_coin(coin_id)));
                let expected_clean_shutdown_solution = self
                    .pending_clean_shutdown
                    .take()
                    .map(|(_, solution)| solution);
                if self
                    .channel_state
                    .as_ref()
                    .is_some_and(|channel| channel.has_zero_payout())
                    && expected_clean_shutdown_solution.is_none()
                {
                    return Ok((true, vec![log_effect, Effect::CompleteZeroPayoutShutdown]));
                }
                let handler = crate::session_phases::spend_channel_coin_phase::SpendChannelCoinPhase::new_at_channel_conditions(
                    self.channel_state.take(),
                    channel_coin,
                    std::mem::take(&mut self.game_action_queue),
                    self.have_potato.clone(),
                    self.channel_timeout.clone(),
                    self.unroll_timeout.clone(),
                    expected_clean_shutdown_solution,
                );
                self.channel_spend_next_phase = Some(Box::new(handler));

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
        env: &mut ChannelEnv<'_>,
        got_error: bool,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();

        {
            let player_ch = self.channel_state_mut()?;
            let cancelled_groups = player_ch.cancel_all_proposals();
            for group_ids in cancelled_groups {
                effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                    id: group_ids[0],
                    group_ids,
                    reason: CancelReason::WentOnChain,
                }));
            }
        }

        {
            let saved = self.last_channel_coin_spend_info.as_ref().ok_or_else(|| {
                Error::StrErr("go_on_chain: no channel coin spend info cached".to_string())
            })?;
            let ch = self.channel_state()?;
            let coin = ch.channel_coin().clone();
            let bundle = crate::session_phases::handler_base::build_channel_to_unroll_bundle(
                env,
                ch,
                &coin,
                saved,
                "go on chain unroll",
            )?;
            effects.push(Effect::SpendTransaction(bundle, None));
        }

        let channel_coin = {
            let ch = self.channel_state()?;
            ch.channel_coin().clone()
        };

        let mut handler =
            crate::session_phases::spend_channel_coin_phase::SpendChannelCoinPhase::new(
                self.channel_state.take(),
                channel_coin,
                std::mem::take(&mut self.game_action_queue),
                self.have_potato.clone(),
                self.channel_timeout.clone(),
                self.unroll_timeout.clone(),
                self.last_channel_coin_spend_info.take(),
            );
        if got_error {
            handler.set_advisory(Some("error receiving peer message".to_string()));
        }
        self.channel_spend_next_phase = Some(Box::new(handler));

        Ok(effects)
    }

    /// Build a channel-coin-to-unroll spend bundle regardless of current
    /// handshake state.  Used by test infrastructure to simulate a malicious
    /// peer that submits an unroll after agreeing to clean shutdown.
    #[cfg(test)]
    pub fn force_unroll_spend(&self, env: &mut ChannelEnv<'_>) -> Result<SpendBundle, Error> {
        let saved = self.last_channel_coin_spend_info.as_ref().ok_or_else(|| {
            Error::StrErr("force_unroll_spend: no channel coin spend info cached".to_string())
        })?;
        let ch = self.channel_state()?;
        let coin = ch.channel_coin().clone();
        crate::session_phases::handler_base::build_channel_to_unroll_bundle(
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
        env: &mut ChannelEnv<'_>,
        saved: &ChannelCoinSpendInfo,
    ) -> Result<SpendBundle, Error> {
        let ch = self.channel_state()?;
        let coin = ch.channel_coin().clone();
        crate::session_phases::handler_base::build_channel_to_unroll_bundle(
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
}

impl FromLocalUI for OffChainPhase {
    fn propose_games(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        games: &[GameProposal],
    ) -> Result<(Vec<GameID>, Vec<Effect>), Error> {
        if games.len() != 1 {
            return Err(Error::StrErr(format!(
                "propose_games expects one atomic group request, got {}",
                games.len()
            )));
        }
        let start = &games[0];

        self.game_action_queue
            .retain(|a| !matches!(a, GameAction::CleanShutdown));

        let has_pending_peer = {
            let ch = self.channel_state()?;
            !ch.pending_peer_proposal_ids().is_empty()
        };
        if has_pending_peer {
            let cancelled_id = self.channel_state_mut()?.allocate_my_proposal_id();
            self.push_action(GameAction::QueuedProposalGroup(cancelled_id, start.clone()));
            self.push_action(GameAction::QueuedCancelProposalGroupSilently(cancelled_id));
            let (_has_potato, request_effect) = self.send_potato_request_if_needed()?;
            let mut effects: Vec<Effect> = request_effect.into_iter().collect();
            effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                id: cancelled_id,
                group_ids: vec![cancelled_id],
                reason: CancelReason::PeerProposalPending,
            }));
            return Ok((vec![cancelled_id], effects));
        }

        let local_id = self.channel_state_mut()?.allocate_my_proposal_id();
        self.push_action(GameAction::QueuedProposalGroup(local_id, start.clone()));

        let (_has_potato, effect) = self.send_potato_request_if_needed()?;
        let effects: Vec<Effect> = effect.into_iter().collect();
        Ok((vec![local_id], effects))
    }

    fn accept_proposal(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        let (_continued, effects) =
            self.do_game_action(GameAction::QueuedAcceptProposalGroup(*game_id))?;
        Ok(effects)
    }

    fn cancel_proposal(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        let group_ids = {
            let ch = self.channel_state()?;
            ch.group_member_ids(game_id)?
        };
        let group_id = *group_ids
            .first()
            .ok_or_else(|| Error::StrErr("proposal group cannot be empty".to_string()))?;
        let (_continued, effects) =
            self.do_game_action(GameAction::QueuedCancelProposalGroup(group_id))?;
        Ok(effects)
    }

    fn make_move(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        validate_new_move_action(
            id,
            self.channel_state()?.game_is_my_turn(id),
            &self.game_action_queue,
            false,
        )?;
        let prepared = self
            .channel_state()?
            .prepare_move(_env, id, readable, new_entropy)?;
        let (_continued, effects) = self.do_game_action(GameAction::Move(*id, prepared))?;

        Ok(effects)
    }

    fn accept_settlement(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        let (_continued, effects) = self.do_game_action(GameAction::AcceptSettlement(*id))?;

        Ok(effects)
    }

    fn shut_down(&mut self, _env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error> {
        let (_continued, effects) = self.do_game_action(GameAction::CleanShutdown)?;
        Ok(effects)
    }
}

impl SpendWalletReceiver for OffChainPhase {
    fn coin_created(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _coin: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        Ok(None)
    }

    fn coin_spent(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        let (_matched_ch, effects) = self.check_channel_spent(coin_id)?;
        Ok(effects)
    }

    fn coin_puzzle_and_solution(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _coin_id: &CoinString,
        _puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }
}

#[typetag::serde]
impl PeerLifecyclePhase for OffChainPhase {
    fn phase_name(&self) -> &'static str {
        "off-chain phase"
    }
    fn has_queued_message(&self) -> bool {
        OffChainPhase::has_queued_message(self)
    }
    fn process_queued_message(&mut self, env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error> {
        OffChainPhase::process_queued_message(self, env)
    }
    fn has_queued_action(&self) -> bool {
        false
    }
    fn process_queued_action(&mut self, _env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }
    fn received_message(
        &mut self,
        env: &mut ChannelEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        OffChainPhase::received_message(self, env, msg)
    }
    fn coin_spent(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        <Self as SpendWalletReceiver>::coin_spent(self, env, coin_id)
    }
    fn coin_created(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        <Self as SpendWalletReceiver>::coin_created(self, env, coin_id)
    }
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<Vec<Effect>, Error> {
        <Self as SpendWalletReceiver>::coin_puzzle_and_solution(
            self,
            env,
            coin_id,
            puzzle_and_solution,
        )
    }
    fn make_move(
        &mut self,
        env: &mut ChannelEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        <Self as FromLocalUI>::make_move(self, env, id, readable, new_entropy)
    }
    fn accept_settlement(
        &mut self,
        env: &mut ChannelEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        <Self as FromLocalUI>::accept_settlement(self, env, id)
    }
    fn cheat_game(
        &mut self,
        env: &mut ChannelEnv<'_>,
        game_id: &GameID,
        mover_share: Amount,
        entropy: Hash,
    ) -> Result<Vec<Effect>, Error> {
        OffChainPhase::cheat_game(self, env, game_id, mover_share, entropy)
    }
    #[cfg(test)]
    fn self_accept_proposal(
        &mut self,
        env: &mut ChannelEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        OffChainPhase::self_accept_proposal(self, env, game_id)
    }
    fn flush_pending_actions(&mut self, env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error> {
        OffChainPhase::flush_pending_actions(self, env)
    }
    fn take_failed_queued_action(&mut self) -> Option<(GameID, FailedGameAction)> {
        OffChainPhase::take_failed_queued_action(self)
    }
    fn take_next_phase(&mut self) -> Option<Box<dyn PeerLifecyclePhase>> {
        self.take_channel_spend_next_phase()
            .map(|h| h as Box<dyn PeerLifecyclePhase>)
    }
    fn new_block(&mut self, _env: &mut ChannelEnv<'_>, height: u64) -> Result<Vec<Effect>, Error> {
        self.last_height = height;
        Ok(vec![])
    }
    fn handshake_finished(&self) -> bool {
        OffChainPhase::handshake_finished(self)
    }
    fn is_on_chain(&self) -> bool {
        false
    }
    fn start_handshake(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _opening_fee: Amount,
    ) -> Result<Option<Effect>, Error> {
        Err(phase_operation_error(self.phase_name(), "start_handshake"))
    }
    fn channel_offer(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _bundle: SpendBundle,
    ) -> Result<Option<Effect>, Error> {
        Ok(None)
    }
    fn channel_transaction_completion(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _bundle: &SpendBundle,
    ) -> Result<Option<Effect>, Error> {
        Ok(None)
    }
    fn provide_coin_spend_bundle(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _bundle: SpendBundle,
    ) -> Result<Vec<Effect>, Error> {
        Err(phase_operation_error(
            self.phase_name(),
            "provide_coin_spend_bundle",
        ))
    }
    fn propose_games(
        &mut self,
        env: &mut ChannelEnv<'_>,
        games: &[GameProposal],
    ) -> Result<(Vec<GameID>, Vec<Effect>), Error> {
        <Self as FromLocalUI>::propose_games(self, env, games)
    }
    fn accept_proposal(
        &mut self,
        env: &mut ChannelEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        <Self as FromLocalUI>::accept_proposal(self, env, game_id)
    }
    fn cancel_proposal(
        &mut self,
        env: &mut ChannelEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        <Self as FromLocalUI>::cancel_proposal(self, env, game_id)
    }
    fn shut_down(&mut self, env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error> {
        <Self as FromLocalUI>::shut_down(self, env)
    }
    fn go_on_chain(
        &mut self,
        env: &mut ChannelEnv<'_>,
        got_error: bool,
    ) -> Result<Vec<Effect>, Error> {
        OffChainPhase::go_on_chain(self, env, got_error)
    }
    fn channel_status_snapshot(&self) -> Option<ChannelStatusSnapshot> {
        let ch = self.channel_state.as_ref()?;
        let shutting_down = self.pending_clean_shutdown.is_some()
            || self
                .game_action_queue
                .iter()
                .any(|a| matches!(a, GameAction::CleanShutdown));
        Some(ChannelStatusSnapshot {
            coin: Some(ch.channel_coin().clone()),
            our_balance: Some(ch.my_out_of_game_balance()),
            their_balance: Some(ch.their_out_of_game_balance()),
            game_allocated: Some(ch.total_game_allocated()),
            have_potato: Some(matches!(self.have_potato, PotatoState::Present)),
            zero_payout: shutting_down.then(|| ch.has_zero_payout()),
            state_number: Some(ch.state_number()),
            ..ChannelStatusSnapshot::new(if shutting_down {
                ChannelStatus::ShuttingDown
            } else {
                ChannelStatus::Active
            })
        })
    }
    fn coins_of_interest(&self) -> Vec<(CoinOfInterest, CoinString)> {
        match self.channel_state.as_ref() {
            Some(ch) => vec![(CoinOfInterest::Channel, ch.channel_coin().clone())],
            None => vec![],
        }
    }
    fn channel_state(&self) -> Result<&ChannelState, Error> {
        OffChainPhase::channel_state(self)
    }
    fn wallet_callback_failed(&mut self, _reason: String) {}
    fn has_active_on_chain_games(&self) -> bool {
        false
    }
    fn timeout_claim_submitted(
        &mut self,
        _semantic: TimeoutClaimSemantic,
    ) -> Result<Option<GameNotification>, Error> {
        Ok(None)
    }
    fn timeout_claim_rearmed(
        &mut self,
        _semantic: TimeoutClaimSemantic,
    ) -> Result<Option<GameNotification>, Error> {
        Ok(None)
    }
    #[cfg(test)]
    fn corrupt_state_for_testing(&mut self, new_sn: usize) -> Result<(), Error> {
        OffChainPhase::corrupt_state_for_testing(self, new_sn)
    }
    #[cfg(test)]
    fn force_unroll_spend_for_testing(
        &self,
        env: &mut ChannelEnv<'_>,
    ) -> Result<SpendBundle, Error> {
        OffChainPhase::force_unroll_spend(self, env)
    }
    #[cfg(test)]
    fn last_channel_coin_spend_info_for_testing(&self) -> Option<ChannelCoinSpendInfo> {
        self.get_last_channel_coin_spend_info().cloned()
    }
    #[cfg(test)]
    fn force_stale_unroll_spend_for_testing(
        &self,
        env: &mut ChannelEnv<'_>,
        saved: &ChannelCoinSpendInfo,
    ) -> Result<SpendBundle, Error> {
        OffChainPhase::force_stale_unroll_spend(self, env, saved)
    }
    #[cfg(test)]
    fn take_off_chain_phase_for_testing(&mut self) -> Option<OffChainPhase> {
        None
    }
    fn get_game_coin(&self, _game_id: &GameID) -> Option<CoinString> {
        None
    }
}

#[cfg(test)]
mod atomic_group_tests {
    use super::*;

    #[test]
    fn queued_cheat_failure_keeps_game_action_context() {
        assert_eq!(
            failed_game_action_context(&GameAction::Cheat(
                GameID(7),
                Amount::default(),
                Hash::default(),
            )),
            Some((GameID(7), FailedGameAction::Cheat)),
        );
    }
}
