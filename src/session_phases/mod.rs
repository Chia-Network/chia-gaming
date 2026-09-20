use std::borrow::Borrow;
use std::collections::{BTreeMap, VecDeque};

use std::rc::Rc;

use clvm_traits::ToClvm;
use serde::{Deserialize, Serialize};

use crate::channel_state::game;
use crate::channel_state::game_start_info::GameStartInfo;
use crate::channel_state::types::{
    ChannelCoinSpendInfo, ChannelEnv, ChannelPrivateKeys, MoveResult, ProposalLifecycle,
    ReadableMove, StateUpdateSignatures,
};
use crate::channel_state::{ChannelState, ProposalAcceptanceStatus};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinString, Error, GameID, GameType, Hash, IntoErr,
    LocalProposalId, Program, ProgramRef, PuzzleHash, Spend, SpendBundle, Timeout, WireProposalId,
};
use crate::session_phases::effects::{
    format_coin, snapshot_state_number, AcceptedGameMember, CancelReason, ChannelStatus,
    ChannelStatusSnapshot, CoinOfInterest, Effect, FailedGameAction, GameNotification,
    GameStatusKind, GameStatusOtherParams, LocalActionKind, SettlementOutcome,
    TimeoutClaimSemantic,
};
use crate::shutdown::{complete_shutdown_spend, get_conditions_with_channel_state};

use crate::game_session::{phase_operation_error, PeerLifecyclePhase};
use crate::session_phases::types::{
    validate_new_move_action, BatchAction, FromLocalUI, GameAction, PeerMessage, PeerMove,
    PotatoState, WireProposal,
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
#[derive(Clone, Serialize, Deserialize)]
struct OffChainWorkingState {
    have_potato: PotatoState,
    game_action_queue: VecDeque<GameAction>,
    channel_state: Option<ChannelState>,
    incoming_messages: VecDeque<Rc<PeerMessage>>,
    peer_wants_potato: bool,
    last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,
    pending_clean_shutdown: Option<(CoinString, ProgramRef)>,
    last_height: u64,
}

#[derive(Serialize, Deserialize)]
pub struct OffChainPhase {
    initiator: bool,
    state: OffChainWorkingState,

    /// Diagnostic context for an error while draining a local queued action.
    /// This is transient host state, not protocol or persisted game state.
    #[serde(skip, default)]
    last_failed_queued_action: Option<(GameID, FailedGameAction)>,

    #[cfg(test)]
    #[serde(skip, default)]
    fail_next_cached_unroll_update: bool,

    #[serde(skip, default)]
    game_types: BTreeMap<GameType, ProgramRef>,

    private_keys: ChannelPrivateKeys,

    my_contribution: Amount,

    their_contribution: Amount,

    reward_puzzle_hash: PuzzleHash,

    channel_timeout: Timeout,
    // Unroll timeout
    unroll_timeout: Timeout,

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

enum AcceptanceOutcome {
    Accepted(Vec<AcceptedGameMember>),
    Insufficient {
        local_id: LocalProposalId,
        origin_wire_id: WireProposalId,
        our_balance_short: bool,
        their_balance_short: bool,
    },
}

type AppliedPeerBatch = (
    Vec<Effect>,
    ChannelCoinSpendInfo,
    bool,
    Vec<(LocalProposalId, Vec<AcceptedGameMember>)>,
);

struct PlannedCleanShutdown {
    channel_coin: CoinString,
    spend: Spend,
}

struct BatchPlan {
    channel_state: ChannelState,
    remaining_queue: VecDeque<GameAction>,
    batch_actions: Vec<BatchAction>,
    effects: Vec<Effect>,
    applied_actions: Vec<(GameID, LocalActionKind)>,
    request_potato_back: bool,
    clean_shutdown: Option<PlannedCleanShutdown>,
}

enum PlanQueuedAction {
    Continue,
    Stop,
}

fn format_batch_action(action: &BatchAction) -> String {
    match action {
        BatchAction::Propose(proposal) => {
            format!(
                "Propose wire_id={} type={} timeout={}",
                proposal.origin_wire_id, proposal.start.game_type, proposal.start.timeout,
            )
        }
        BatchAction::AcceptProposal(id) => format!("AcceptProposal id={id}"),
        BatchAction::CancelProposal(id) => format!("CancelProposal id={id}"),
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
        game_types: &BTreeMap<GameType, ProgramRef>,
        env: &mut ChannelEnv<'_>,
        channel: &mut ChannelState,
        local_id: LocalProposalId,
        local_is_proposer: bool,
        cache_for_redo: bool,
    ) -> Result<AcceptanceOutcome, Error> {
        let proposal = channel.find_proposal(local_id)?.clone();
        if proposal.lifecycle.originated_locally() != local_is_proposer {
            return Err(Error::StrErr(
                "proposal accepter/origin mismatch".to_string(),
            ));
        }
        let factory = game_types
            .get(&proposal.game_type)
            .ok_or_else(|| Error::StrErr(format!("no such game {:?}", proposal.game_type)))?;
        let game_parameters = proposal.parameters.to_program(env.allocator)?;
        let game_parameters = game_parameters.to_clvm(env.allocator).into_gen()?;
        let our_reserve = channel.my_out_of_game_balance();
        let their_reserve = channel.their_out_of_game_balance();
        let (proposer_reserve, accepter_reserve) = if local_is_proposer {
            (our_reserve, their_reserve)
        } else {
            (their_reserve, our_reserve)
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
                origin_wire_id: proposal
                    .lifecycle
                    .wire_id()
                    .ok_or_else(|| Error::StrErr(format!("proposal {local_id} has no wire id")))?,
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
                let ids = channel.game_ids_for_acceptance(games.len())?;
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
                match channel.stage_proposal_acceptance(env, local_id, &starts, cache_for_redo)? {
                    ProposalAcceptanceStatus::Accepted => Ok(AcceptanceOutcome::Accepted(members)),
                    ProposalAcceptanceStatus::Insufficient {
                        our_balance_short,
                        their_balance_short,
                    } => Ok(AcceptanceOutcome::Insufficient {
                        local_id,
                        origin_wire_id: proposal.lifecycle.wire_id().ok_or_else(|| {
                            Error::StrErr(format!("proposal {local_id} has no wire id"))
                        })?,
                        our_balance_short,
                        their_balance_short,
                    }),
                }
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
            state: OffChainWorkingState {
                have_potato,
                game_action_queue: VecDeque::default(),
                channel_state: Some(channel_state),
                incoming_messages,
                peer_wants_potato: false,
                last_channel_coin_spend_info,
                pending_clean_shutdown: None,
                last_height,
            },
            game_types,
            last_failed_queued_action: None,
            #[cfg(test)]
            fail_next_cached_unroll_update: false,
            private_keys,
            my_contribution,
            their_contribution,
            channel_timeout,
            unroll_timeout,
            reward_puzzle_hash,
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
        proposal_id: &LocalProposalId,
    ) -> Result<Vec<Effect>, Error> {
        let (_continued, effects) =
            self.do_game_action(GameAction::ForcedSelfAccept(*proposal_id))?;
        Ok(effects)
    }

    pub fn has_queued_message(&self) -> bool {
        !self.state.incoming_messages.is_empty()
    }

    fn push_action(&mut self, action: GameAction) {
        self.state.game_action_queue.push_back(action);
    }

    #[cfg(test)]
    pub(crate) fn queue_game_action_for_testing(&mut self, action: GameAction) {
        self.push_action(action);
    }

    #[cfg(test)]
    pub(crate) fn fail_next_cached_unroll_update_for_testing(&mut self) {
        self.fail_next_cached_unroll_update = true;
    }

    #[cfg(test)]
    pub(crate) fn queued_game_action_count_for_testing(&self) -> usize {
        self.state.game_action_queue.len()
    }

    pub fn is_initiator(&self) -> bool {
        self.initiator
    }

    pub fn channel_state(&self) -> Result<&ChannelState, Error> {
        self.state
            .channel_state
            .as_ref()
            .ok_or_else(|| Error::StrErr("no channel handler".to_string()))
    }

    fn channel_state_mut(&mut self) -> Result<&mut ChannelState, Error> {
        self.state
            .channel_state
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
        self.state.last_channel_coin_spend_info.as_ref()
    }

    #[cfg(test)]
    pub fn queue_stale_game_action_for_testing(&mut self, game_id: GameID) {
        self.state.game_action_queue.push_back(GameAction::Cheat(
            game_id,
            Amount::default(),
            Hash::default(),
        ));
    }

    #[cfg(test)]
    pub fn assert_invalid_clean_shutdown_rollback_for_testing(
        &mut self,
        env: &mut ChannelEnv<'_>,
        proposal: &GameProposal,
    ) {
        let base_state = self.state.clone();
        self.channel_state_mut()
            .expect("channel state")
            .create_outgoing_proposal(proposal)
            .expect("create rollback probe proposal");
        let before = bencodex::to_vec(&self.state).expect("serialize working state with proposal");

        let result = self.pass_on_channel_state_message(
            env,
            Rc::new(PeerMessage::CleanShutdown {
                channel_half_sig: Aggsig::default(),
            }),
        );
        assert!(result.is_err(), "invalid clean shutdown must fail");
        assert_eq!(
            bencodex::to_vec(&self.state).expect("serialize restored working state"),
            before,
            "invalid clean shutdown must restore proposal cancellation and complete working state"
        );
        assert!(
            self.channel_spend_next_phase.is_none(),
            "invalid clean shutdown must not publish a phase transition"
        );
        self.state = base_state;
    }

    /// Tell whether this peer has the potato.  If it has been sent but not received yet
    /// then both will say false
    pub fn has_potato(&self) -> bool {
        matches!(self.state.have_potato, PotatoState::Present)
    }

    pub fn flush_pending_actions(
        &mut self,
        env: &mut ChannelEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        self.last_failed_queued_action = None;
        if !self.has_potato() || self.state.game_action_queue.is_empty() {
            return Ok(vec![]);
        }
        let (_sent, effects) = self.drain_queue_into_batch(env)?;
        Ok(effects)
    }

    pub fn take_failed_queued_action(&mut self) -> Option<(GameID, FailedGameAction)> {
        self.last_failed_queued_action.take()
    }

    pub fn get_reward_puzzle_hash(&self, env: &mut ChannelEnv<'_>) -> Result<PuzzleHash, Error> {
        let player_ch = self.channel_state()?;
        player_ch.get_reward_puzzle_hash(env)
    }

    fn commit_received_batch_state(
        &mut self,
        spend: &ChannelCoinSpendInfo,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        self.state.have_potato = PotatoState::Present;
        self.state.last_channel_coin_spend_info = Some(spend.clone());
        for (id, amount, _game_finished) in
            self.channel_state_mut()?.drain_cached_accept_settlements()
        {
            effects.push(Effect::Notify(GameNotification::game_settled(
                id,
                SettlementOutcome::AcceptSettlement,
                amount,
                None,
            )));
        }
        Ok(effects)
    }

    fn drain_local_actions_after_receive(
        &mut self,
        env: &mut ChannelEnv<'_>,
        send_back: bool,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        if send_back
            && self.channel_state()?.get_their_current_share() == Amount::default()
            && !self.channel_state()?.has_active_games()
        {
            self.state
                .game_action_queue
                .push_back(GameAction::CleanShutdown);
        }

        let (sent, batch_effects) = match self.drain_queue_into_batch(env) {
            Ok(result) => result,
            Err(error) => {
                game_assert!(
                    false,
                    "unexpected local action failure after valid peer batch: {error:?}"
                );
                unreachable!("game_assert returns on failure");
            }
        };
        effects.extend(batch_effects);
        if sent {
            return Ok(effects);
        }

        if self.state.peer_wants_potato {
            self.state.peer_wants_potato = false;
            let sigs = {
                let ch = self.channel_state_mut()?;
                ch.send_empty_potato(env)?
            };
            {
                let ch = self.channel_state()?;
                effects.push(Effect::Log(make_send_log(ch, &[], false)));
            }
            effects.push(Effect::SendPeer(PeerMessage::Batch {
                actions: vec![],
                signatures: sigs,
            }));
            self.state.have_potato = PotatoState::Absent;
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
            effects.push(Effect::SendPeer(PeerMessage::Batch {
                actions: vec![],
                signatures: sigs,
            }));
            self.state.have_potato = PotatoState::Absent;
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
                effects.extend(self.process_received_batch(env, &timeout, actions, signatures)?);
            }
            PeerMessage::CleanShutdown { channel_half_sig } => {
                game_assert!(
                    self.channel_spend_next_phase.is_none(),
                    "clean shutdown received with an unpublished next phase"
                );
                let state_snapshot = self.state.clone();
                match self.process_received_clean_shutdown(env, channel_half_sig) {
                    Ok(shutdown_effects) => {
                        effects.extend(shutdown_effects);
                    }
                    Err(error) => {
                        self.state = state_snapshot;
                        self.channel_spend_next_phase = None;
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
                    .state
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
                bundle
                    .validate_consensus(&env.agg_sig_me_additional_data, self.state.last_height)?;
                let zero_payout = self
                    .channel_state()
                    .is_ok_and(|channel| channel.has_zero_payout());
                if zero_payout {
                    effects.push(Effect::CompleteZeroPayoutShutdown);
                } else {
                    effects.push(Effect::SpendTransaction(
                        crate::session_phases::effects::TransactionSubmission::attach_to(
                            bundle,
                            None,
                            &expected_coin,
                        ),
                    ));
                }
                if let Some((coin, shutdown_solution)) = self.state.pending_clean_shutdown.take() {
                    let handler = crate::session_phases::spend_channel_coin_phase::SpendChannelCoinPhase::new_for_clean_shutdown(
                        self.state.channel_state.take(),
                        coin,
                        shutdown_solution,
                        std::mem::take(&mut self.state.game_action_queue),
                        self.state.have_potato.clone(),
                        self.channel_timeout.clone(),
                        self.unroll_timeout.clone(),
                        self.state.last_channel_coin_spend_info.take(),
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
        let state_snapshot = self.state.clone();
        let peer_result = self
            .apply_received_batch(env, actions, signatures)
            .and_then(
                |(mut effects, spend_info, received_accept_settlement, accepted_groups)| {
                    effects.extend(self.commit_received_batch_state(&spend_info)?);
                    Ok((effects, received_accept_settlement, accepted_groups))
                },
            );
        let (mut effects, received_accept_settlement, accepted_groups) = match peer_result {
            Ok(result) => result,
            Err(error) => {
                self.state = state_snapshot;
                return Err(error);
            }
        };

        effects.extend(self.reconcile_stale_game_actions()?);
        effects.extend(self.drain_local_actions_after_receive(env, received_accept_settlement)?);
        effects.extend(accepted_groups.into_iter().map(|(id, members)| {
            Effect::Notify(GameNotification::ProposalAcceptedGroup { id, members })
        }));

        Ok(effects)
    }

    fn apply_received_batch(
        &mut self,
        env: &mut ChannelEnv<'_>,
        actions: &[BatchAction],
        signatures: &StateUpdateSignatures,
    ) -> Result<AppliedPeerBatch, Error> {
        let mut effects = Vec::new();
        let mut accepted_groups = Vec::new();

        for action in actions.iter() {
            match action {
                BatchAction::Propose(wire) => {
                    let cancelled: Vec<LocalProposalId> = self
                        .state
                        .game_action_queue
                        .iter()
                        .filter_map(|a| match a {
                            GameAction::QueuedProposal(local_id) => Some(*local_id),
                            _ => None,
                        })
                        .collect();
                    for id in cancelled {
                        self.state.game_action_queue.retain(|action| {
                            !matches!(action, GameAction::QueuedProposal(queued) if *queued == id)
                        });
                        self.channel_state_mut()?.remove_proposal(id)?;
                        effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                            id,
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
                        self.state
                            .game_action_queue
                            .push_back(GameAction::QueuedCancelProposalSilently(local_id));
                    } else {
                        effects.push(Effect::Notify(GameNotification::ProposalMade {
                            id: local_id,
                            sender_is_player_a: wire.start.sender_is_player_a,
                            timeout: wire.start.timeout.clone(),
                            game_type: wire.start.game_type.clone(),
                            parameters: wire.start.parameters.clone(),
                        }));
                    }
                }
                BatchAction::AcceptProposal(origin_wire_id) => {
                    let local_id = self.channel_state()?.local_proposal_id(*origin_wire_id)?;
                    self.ensure_game_types(env.allocator);
                    let game_types = &self.game_types;
                    let channel = self
                        .state
                        .channel_state
                        .as_mut()
                        .ok_or_else(|| Error::StrErr("no channel handler".to_string()))?;
                    match Self::execute_acceptance(game_types, env, channel, local_id, true, false)?
                    {
                        AcceptanceOutcome::Accepted(members) => {
                            self.state.game_action_queue.retain(|action| {
                                !matches!(
                                    action,
                                    GameAction::QueuedCancelProposal(id)
                                        | GameAction::QueuedCancelProposalSilently(id)
                                        if *id == local_id
                                )
                            });
                            accepted_groups.push((local_id, members));
                        }
                        AcceptanceOutcome::Insufficient { .. } => {
                            return Err(Error::StrErr(format!(
                                "peer accepted proposal {origin_wire_id:?} that factory reports insufficient"
                            )));
                        }
                    }
                }
                BatchAction::CancelProposal(origin_wire_id) => {
                    let local_id = self.channel_state()?.local_proposal_id(*origin_wire_id)?;
                    let suppress_notification = self.state.game_action_queue.iter().any(|action| {
                        matches!(
                            action,
                            GameAction::QueuedCancelProposalSilently(id) if *id == local_id
                        )
                    });
                    self.state.game_action_queue.retain(|action| {
                        !matches!(
                            action,
                            GameAction::QueuedAcceptProposal(id)
                                | GameAction::QueuedCancelProposal(id)
                                | GameAction::QueuedCancelProposalSilently(id)
                                if *id == local_id
                        )
                    });
                    let proposal = self
                        .channel_state_mut()?
                        .remove_wire_proposal(*origin_wire_id)?;
                    let transient_proposal = effects.iter().position(|effect| {
                        matches!(
                            effect,
                            Effect::Notify(GameNotification::ProposalMade { id, .. })
                                if *id == proposal.local_id
                        )
                    });
                    if let Some(index) = transient_proposal {
                        effects.remove(index);
                    } else if !suppress_notification {
                        effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                            id: proposal.local_id,
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
                        effects.push(Effect::SendPeer(PeerMessage::Message(
                            *game_id,
                            move_result.message,
                        )));
                    }
                    if finished {
                        self.state
                            .game_action_queue
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

        let has_new_game = actions
            .iter()
            .any(|a| matches!(a, BatchAction::Propose(_) | BatchAction::AcceptProposal(_)));
        if has_new_game {
            self.state
                .game_action_queue
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

        Ok((
            effects,
            spend_info,
            received_accept_settlement,
            accepted_groups,
        ))
    }

    fn reconcile_stale_game_actions(&mut self) -> Result<Vec<Effect>, Error> {
        let queued = std::mem::take(&mut self.state.game_action_queue);
        let mut effects = Vec::new();

        for action in queued {
            let stale = match &action {
                GameAction::Move(id, _) | GameAction::AcceptSettlement(id) => {
                    self.channel_state()?.game_is_my_turn(id) != Some(true)
                }
                GameAction::Cheat(id, ..) => self.channel_state()?.game_is_my_turn(id).is_none(),
                _ => false,
            };
            if stale {
                let (id, action_kind) = failed_game_action_context(&action)
                    .expect("stale game action must have failure context");
                effects.push(Effect::Notify(GameNotification::ActionFailed {
                    id: Some(id),
                    action: Some(action_kind),
                    reason: "local action became stale after applying peer batch".to_string(),
                }));
            } else {
                self.state.game_action_queue.push_back(action);
            }
        }

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
            for id in ch.cancel_all_proposals() {
                effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                    id,
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
        bundle.validate_consensus(&env.agg_sig_me_additional_data, self.state.last_height)?;

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
            effects.push(Effect::SpendTransaction(
                crate::session_phases::effects::TransactionSubmission::attach_to(
                    bundle,
                    None,
                    &coin_spend.coin,
                ),
            ));
            effects.push(Effect::SendPeer(PeerMessage::CleanShutdownComplete {
                channel_half_sig: local_half_sig,
            }));
        }

        self.state.have_potato = PotatoState::Present;
        let handler = crate::session_phases::spend_channel_coin_phase::SpendChannelCoinPhase::new_for_clean_shutdown(
            self.state.channel_state.take(),
            coin_spend.coin,
            coin_spend.bundle.solution,
            std::mem::take(&mut self.state.game_action_queue),
            PotatoState::Present,
            self.channel_timeout.clone(),
            self.unroll_timeout.clone(),
            self.state.last_channel_coin_spend_info.take(),
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
        if matches!(self.state.have_potato, PotatoState::Present) {
            return Ok((true, None));
        }

        if matches!(self.state.have_potato, PotatoState::Absent) {
            self.state.have_potato = PotatoState::Requested;
            return Ok((
                false,
                Some(Effect::SendPeer(PeerMessage::RequestPotato(()))),
            ));
        }

        Ok((false, None))
    }

    fn plan_queued_action(
        &mut self,
        env: &mut ChannelEnv<'_>,
        plan: &mut BatchPlan,
        original_queue: &VecDeque<GameAction>,
        index: usize,
        action: GameAction,
    ) -> Result<PlanQueuedAction, Error> {
        match action {
            GameAction::Move(game_id, prepared) => {
                game_assert!(
                    plan.channel_state.game_is_my_turn(&game_id) == Some(true),
                    "prepared move became stale before off-chain application"
                );
                let move_result = plan
                    .channel_state
                    .send_move_no_finalize(env, &game_id, prepared)?;
                plan.batch_actions.push(BatchAction::Move(
                    game_id,
                    peer_move_from_result(move_result)?,
                ));
                plan.applied_actions
                    .push((game_id, LocalActionKind::MakeMove));
            }
            GameAction::Cheat(game_id, mover_share, entropy) => {
                if plan.channel_state.game_is_my_turn(&game_id) == Some(true) {
                    let readable_move = ReadableMove::from_program(Rc::new(Program::nil()));
                    plan.channel_state
                        .enable_cheating_for_game(&game_id, &[0x80], mover_share)?;
                    let prepared =
                        plan.channel_state
                            .prepare_move(env, &game_id, &readable_move, entropy)?;
                    let move_result = plan
                        .channel_state
                        .send_move_no_finalize(env, &game_id, prepared)?;
                    plan.batch_actions.push(BatchAction::Move(
                        game_id,
                        peer_move_from_result(move_result)?,
                    ));
                    plan.applied_actions.push((game_id, LocalActionKind::Cheat));
                } else {
                    plan.remaining_queue.push_back(GameAction::Cheat(
                        game_id,
                        mover_share,
                        entropy,
                    ));
                }
            }
            GameAction::AcceptSettlement(game_id) => {
                let amount = plan
                    .channel_state
                    .send_accept_settlement_no_finalize(&game_id)?;
                plan.batch_actions
                    .push(BatchAction::AcceptSettlement(game_id, amount));
                plan.applied_actions
                    .push((game_id, LocalActionKind::AcceptSettlement));
            }
            GameAction::QueuedProposal(local_id) => {
                let start = {
                    let proposal = plan.channel_state.find_proposal(local_id)?;
                    GameProposal {
                        sender_is_player_a: proposal.sender_is_player_a,
                        game_type: proposal.game_type.clone(),
                        timeout: proposal.timeout.clone(),
                        parameters: proposal.parameters.clone(),
                    }
                };
                let origin_wire_id = plan.channel_state.emit_outgoing_proposal(local_id)?;
                plan.batch_actions.push(BatchAction::Propose(WireProposal {
                    origin_wire_id,
                    start,
                }));
            }
            GameAction::QueuedAcceptProposal(local_id) => {
                let origin_wire_id = plan.channel_state.proposal_wire_id(local_id)?;
                self.ensure_game_types(env.allocator);
                match Self::execute_acceptance(
                    &self.game_types,
                    env,
                    &mut plan.channel_state,
                    local_id,
                    false,
                    true,
                )? {
                    AcceptanceOutcome::Accepted(members) => {
                        plan.batch_actions
                            .push(BatchAction::AcceptProposal(origin_wire_id));
                        plan.effects.push(Effect::Notify(
                            GameNotification::ProposalAcceptedGroup {
                                id: local_id,
                                members,
                            },
                        ));
                    }
                    AcceptanceOutcome::Insufficient {
                        local_id,
                        origin_wire_id,
                        our_balance_short,
                        their_balance_short,
                    } => {
                        plan.effects
                            .push(Effect::Notify(GameNotification::InsufficientBalance {
                                id: local_id,
                                our_balance_short,
                                their_balance_short,
                            }));
                        plan.channel_state.remove_proposal(local_id)?;
                        plan.batch_actions
                            .push(BatchAction::CancelProposal(origin_wire_id));
                    }
                }
            }
            GameAction::QueuedCancelProposal(local_id) => {
                let proposal = plan.channel_state.remove_proposal(local_id)?;
                plan.effects
                    .push(Effect::Notify(GameNotification::ProposalCancelled {
                        id: local_id,
                        reason: CancelReason::CancelledByUs,
                    }));
                plan.batch_actions.push(BatchAction::CancelProposal(
                    proposal.lifecycle.wire_id().ok_or_else(|| {
                        Error::StrErr(format!("proposal {local_id} has no wire id"))
                    })?,
                ));
            }
            GameAction::QueuedCancelProposalSilently(local_id) => {
                let proposal = plan.channel_state.remove_proposal(local_id)?;
                plan.batch_actions.push(BatchAction::CancelProposal(
                    proposal.lifecycle.wire_id().ok_or_else(|| {
                        Error::StrErr(format!("proposal {local_id} has no wire id"))
                    })?,
                ));
            }
            GameAction::CleanShutdown => {
                if !plan.batch_actions.is_empty() {
                    plan.remaining_queue
                        .extend(original_queue.iter().skip(index).cloned());
                    plan.request_potato_back = true;
                    return Ok(PlanQueuedAction::Stop);
                }
                if plan.channel_state.has_active_games() {
                    return Err(Error::StrErr(
                        "cannot clean shutdown while games are active".to_string(),
                    ));
                }
                for id in plan.channel_state.cancel_all_proposals() {
                    plan.effects
                        .push(Effect::Notify(GameNotification::ProposalCancelled {
                            id,
                            reason: CancelReason::CleanShutdown,
                        }));
                }
                let real_conditions = get_conditions_with_channel_state(env, &plan.channel_state)?;
                let channel_coin = plan.channel_state.channel_coin().clone();
                let spend = plan
                    .channel_state
                    .send_potato_clean_shutdown(env, real_conditions)?;
                plan.clean_shutdown = Some(PlannedCleanShutdown {
                    channel_coin,
                    spend,
                });
                plan.remaining_queue
                    .extend(original_queue.iter().skip(index + 1).cloned());
                return Ok(PlanQueuedAction::Stop);
            }
            #[cfg(test)]
            GameAction::ForcedSelfAccept(local_id) => {
                let wire_id = plan.channel_state.proposal_wire_id(local_id)?;
                plan.batch_actions
                    .push(BatchAction::AcceptProposal(wire_id));
            }
        }

        Ok(PlanQueuedAction::Continue)
    }

    fn commit_clean_shutdown(
        &mut self,
        mut plan: BatchPlan,
        shutdown: PlannedCleanShutdown,
    ) -> Result<(bool, Vec<Effect>), Error> {
        *self.channel_state_mut()? = plan.channel_state;
        self.state.pending_clean_shutdown = Some((
            shutdown.channel_coin.clone(),
            shutdown.spend.solution.clone(),
        ));
        self.state.game_action_queue = plan.remaining_queue;
        self.state.have_potato = PotatoState::Absent;
        {
            let ch = self.channel_state()?;
            plan.effects.push(Effect::Log(make_send_log(ch, &[], true)));
        }
        plan.effects
            .push(Effect::SendPeer(PeerMessage::CleanShutdown {
                channel_half_sig: shutdown.spend.signature,
            }));
        self.last_failed_queued_action = None;
        Ok((true, plan.effects))
    }

    fn commit_finalized_normal_batch(
        &mut self,
        mut plan: BatchPlan,
        signatures: StateUpdateSignatures,
    ) -> Result<(bool, Vec<Effect>), Error> {
        *self.channel_state_mut()? = plan.channel_state;
        self.state.game_action_queue = plan.remaining_queue;

        plan.effects
            .extend(plan.applied_actions.into_iter().map(|(id, action)| {
                Effect::Notify(GameNotification::LocalActionApplied { id, action })
            }));
        {
            let ch = self.channel_state()?;
            plan.effects
                .push(Effect::Log(make_send_log(ch, &plan.batch_actions, false)));
        }

        self.state.have_potato = if plan.request_potato_back {
            PotatoState::Requested
        } else {
            PotatoState::Absent
        };
        plan.effects.push(Effect::SendPeer(PeerMessage::Batch {
            actions: plan.batch_actions,
            signatures,
        }));
        if plan.request_potato_back {
            plan.effects
                .push(Effect::SendPeer(PeerMessage::RequestPotato(())));
        }

        self.last_failed_queued_action = None;
        Ok((true, plan.effects))
    }

    fn drain_queue_into_batch(
        &mut self,
        env: &mut ChannelEnv<'_>,
    ) -> Result<(bool, Vec<Effect>), Error> {
        game_assert!(
            matches!(self.state.have_potato, PotatoState::Present),
            "drain_queue_into_batch: must have potato"
        );
        let original_queue = self.state.game_action_queue.clone();
        let planned_channel_state = self.channel_state()?.clone();
        let mut plan = BatchPlan {
            channel_state: planned_channel_state,
            remaining_queue: VecDeque::new(),
            batch_actions: Vec::new(),
            effects: Vec::new(),
            applied_actions: Vec::new(),
            request_potato_back: false,
            clean_shutdown: None,
        };

        for (index, action) in original_queue.iter().cloned().enumerate() {
            match self.plan_queued_action(env, &mut plan, &original_queue, index, action) {
                Ok(PlanQueuedAction::Stop) => break,
                Ok(PlanQueuedAction::Continue) => {}
                Err(error) => {
                    self.state.game_action_queue = original_queue
                        .iter()
                        .enumerate()
                        .filter(|(queued_index, _)| *queued_index != index)
                        .map(|(_, queued)| queued.clone())
                        .collect();
                    self.last_failed_queued_action = failed_game_action_context(
                        original_queue
                            .get(index)
                            .expect("planned action index comes from original queue"),
                    );
                    return Err(error);
                }
            }
        }

        if let Some(shutdown) = plan.clean_shutdown.take() {
            return self.commit_clean_shutdown(plan, shutdown);
        }

        if plan.batch_actions.is_empty() {
            self.state.game_action_queue = plan.remaining_queue;
            self.last_failed_queued_action = None;
            return Ok((false, plan.effects));
        }

        #[cfg(test)]
        if std::mem::take(&mut self.fail_next_cached_unroll_update) {
            self.last_failed_queued_action = None;
            return Err(Error::StrErr(
                "injected cached-unroll finalization failure".to_string(),
            ));
        }

        let sigs = match plan.channel_state.update_cached_unroll_state(env) {
            Ok(sigs) => sigs,
            Err(error) => {
                self.last_failed_queued_action = None;
                return Err(error);
            }
        };
        self.commit_finalized_normal_batch(plan, sigs)
    }

    const MAX_MESSAGE_SIZE: usize = handshake::MAX_PEER_MESSAGE_SIZE;

    pub fn received_message(
        &mut self,
        env: &mut ChannelEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error> {
        let decoded = if msg.len() > Self::MAX_MESSAGE_SIZE {
            Err(Error::StrErr(format!(
                "message too large: {} bytes (max {})",
                msg.len(),
                Self::MAX_MESSAGE_SIZE,
            )))
        } else {
            peer_wire::decode_peer_message(&msg)
        };
        let incoming_result = decoded.and_then(|msg_envelope| {
            self.state
                .incoming_messages
                .push_back(Rc::new(msg_envelope));
            self.process_queued_message_raw(env)
        });
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
        self.process_queued_message_raw(env)
    }

    fn process_queued_message_raw(
        &mut self,
        env: &mut ChannelEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();
        let msg_envelope = if let Some(msg) = self.state.incoming_messages.pop_front() {
            msg
        } else {
            return Ok(effects);
        };

        if self.state.pending_clean_shutdown.is_some() {
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
                self.state.peer_wants_potato = true;
                if matches!(self.state.have_potato, PotatoState::Present) {
                    let sigs = {
                        let ch = self.channel_state_mut()?;
                        ch.send_empty_potato(env)?
                    };
                    {
                        let ch = self.channel_state()?;
                        effects.push(Effect::Log(make_send_log(ch, &[], false)));
                    }
                    effects.push(Effect::SendPeer(PeerMessage::Batch {
                        actions: vec![],
                        signatures: sigs,
                    }));
                    self.state.have_potato = PotatoState::Absent;
                    self.state.peer_wants_potato = false;
                }
            }
            PeerMessage::Batch { .. } | PeerMessage::CleanShutdown { .. } => {
                if matches!(self.state.have_potato, PotatoState::Present) {
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
            .state
            .channel_state
            .as_ref()
            .map(|ch| ch.channel_coin().clone());

        if let Some(channel_coin) = channel_coin {
            if *coin_id == channel_coin {
                let log_effect =
                    Effect::Log(format!("[channel-coin-spent] {}", format_coin(coin_id)));
                let expected_clean_shutdown_solution = self
                    .state
                    .pending_clean_shutdown
                    .take()
                    .map(|(_, solution)| solution);
                if self
                    .state
                    .channel_state
                    .as_ref()
                    .is_some_and(|channel| channel.has_zero_payout())
                    && expected_clean_shutdown_solution.is_none()
                {
                    return Ok((true, vec![log_effect, Effect::CompleteZeroPayoutShutdown]));
                }
                let handler = crate::session_phases::spend_channel_coin_phase::SpendChannelCoinPhase::new_at_channel_conditions(
                    self.state.channel_state.take(),
                    channel_coin,
                    std::mem::take(&mut self.state.game_action_queue),
                    self.state.have_potato.clone(),
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
        self.go_on_chain_raw(env, got_error)
    }

    fn go_on_chain_raw(
        &mut self,
        env: &mut ChannelEnv<'_>,
        got_error: bool,
    ) -> Result<Vec<Effect>, Error> {
        let mut effects = Vec::new();

        {
            let player_ch = self.channel_state_mut()?;
            let cancelled = player_ch.cancel_all_proposals();
            for id in cancelled {
                effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                    id,
                    reason: CancelReason::WentOnChain,
                }));
            }
        }

        {
            let saved = self
                .state
                .last_channel_coin_spend_info
                .as_ref()
                .ok_or_else(|| {
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
            effects.push(Effect::SpendTransaction(
                crate::session_phases::effects::TransactionSubmission::attach_to(
                    bundle, None, &coin,
                ),
            ));
        }

        let channel_coin = {
            let ch = self.channel_state()?;
            ch.channel_coin().clone()
        };

        let mut handler =
            crate::session_phases::spend_channel_coin_phase::SpendChannelCoinPhase::new(
                self.state.channel_state.take(),
                channel_coin,
                std::mem::take(&mut self.state.game_action_queue),
                self.state.have_potato.clone(),
                self.channel_timeout.clone(),
                self.unroll_timeout.clone(),
                self.state.last_channel_coin_spend_info.take(),
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
        let saved = self
            .state
            .last_channel_coin_spend_info
            .as_ref()
            .ok_or_else(|| {
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
    fn propose(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        proposal: &GameProposal,
    ) -> Result<(LocalProposalId, Vec<Effect>), Error> {
        self.state
            .game_action_queue
            .retain(|a| !matches!(a, GameAction::CleanShutdown));

        let local_id = self
            .channel_state_mut()?
            .create_outgoing_proposal(proposal)?;
        let has_pending_peer = {
            let ch = self.channel_state()?;
            !ch.pending_peer_proposal_ids().is_empty()
        };
        if has_pending_peer {
            self.channel_state_mut()?.remove_proposal(local_id)?;
            let effects = vec![Effect::Notify(GameNotification::ProposalCancelled {
                id: local_id,
                reason: CancelReason::PeerProposalPending,
            })];
            return Ok((local_id, effects));
        }

        self.push_action(GameAction::QueuedProposal(local_id));
        let (_has_potato, effect) = self.send_potato_request_if_needed()?;
        Ok((local_id, effect.into_iter().collect()))
    }

    fn accept_proposal(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        proposal_id: &LocalProposalId,
    ) -> Result<Vec<Effect>, Error> {
        let (_continued, effects) =
            self.do_game_action(GameAction::QueuedAcceptProposal(*proposal_id))?;
        Ok(effects)
    }

    fn cancel_proposal(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        proposal_id: &LocalProposalId,
    ) -> Result<Vec<Effect>, Error> {
        let proposal = { self.channel_state()?.find_proposal(*proposal_id)?.clone() };
        if matches!(proposal.lifecycle, ProposalLifecycle::LocalDraft) {
            self.state.game_action_queue.retain(
                |action| !matches!(action, GameAction::QueuedProposal(id) if id == proposal_id),
            );
            self.channel_state_mut()?.remove_proposal(*proposal_id)?;
            return Ok(vec![Effect::Notify(GameNotification::ProposalCancelled {
                id: *proposal_id,
                reason: CancelReason::CancelledByUs,
            })]);
        }
        let action = if proposal.lifecycle.originated_locally() {
            GameAction::QueuedCancelProposal(*proposal_id)
        } else {
            GameAction::QueuedCancelProposalSilently(*proposal_id)
        };
        let (_continued, effects) = self.do_game_action(action)?;
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
            &self.state.game_action_queue,
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
    fn coin_puzzle_and_solution_in_place(
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
        self.state.last_height = height;
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
    fn propose(
        &mut self,
        env: &mut ChannelEnv<'_>,
        proposal: &GameProposal,
    ) -> Result<(LocalProposalId, Vec<Effect>), Error> {
        <Self as FromLocalUI>::propose(self, env, proposal)
    }
    fn accept_proposal(
        &mut self,
        env: &mut ChannelEnv<'_>,
        proposal_id: &LocalProposalId,
    ) -> Result<Vec<Effect>, Error> {
        <Self as FromLocalUI>::accept_proposal(self, env, proposal_id)
    }
    fn cancel_proposal(
        &mut self,
        env: &mut ChannelEnv<'_>,
        proposal_id: &LocalProposalId,
    ) -> Result<Vec<Effect>, Error> {
        <Self as FromLocalUI>::cancel_proposal(self, env, proposal_id)
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
        let ch = self.state.channel_state.as_ref()?;
        let shutting_down = self.state.pending_clean_shutdown.is_some()
            || self
                .state
                .game_action_queue
                .iter()
                .any(|a| matches!(a, GameAction::CleanShutdown));
        Some(ChannelStatusSnapshot {
            coin: Some(ch.channel_coin().clone()),
            our_balance: Some(ch.my_out_of_game_balance()),
            their_balance: Some(ch.their_out_of_game_balance()),
            game_allocated: Some(ch.total_game_allocated()),
            have_potato: Some(matches!(self.state.have_potato, PotatoState::Present)),
            zero_payout: shutting_down.then(|| ch.has_zero_payout()),
            state_number: Some(snapshot_state_number(ch.state_number())),
            ..ChannelStatusSnapshot::new(if shutting_down {
                ChannelStatus::ShuttingDown
            } else {
                ChannelStatus::Active
            })
        })
    }
    fn coins_of_interest(&self) -> Vec<(CoinOfInterest, CoinString)> {
        match self.state.channel_state.as_ref() {
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
    fn off_chain_phase_for_testing(&mut self) -> Option<&mut OffChainPhase> {
        Some(self)
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
