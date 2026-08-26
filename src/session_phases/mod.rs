use std::borrow::Borrow;
use std::collections::{BTreeMap, VecDeque};

use std::rc::Rc;

use clvm_traits::ToClvm;
use serde::{Deserialize, Serialize};

use crate::channel_state::game;
use crate::channel_state::game_start_info::GameStartInfo;
use crate::channel_state::types::{
    ChannelCoinSpendInfo, ChannelEnv, ChannelPrivateKeys, ReadableMove, StateUpdateSignatures,
};
use crate::channel_state::ChannelState;
use crate::common::standard_coin::puzzle_for_synthetic_public_key;
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinSpend, CoinString, Error, GameID, GameType, Hash, IntoErr,
    Program, ProgramRef, PuzzleHash, Spend, SpendBundle, Timeout,
};
use crate::session_phases::effects::{
    format_coin, AcceptedGameMember, CancelReason, ChannelStatus, ChannelStatusSnapshot,
    CoinOfInterest, Effect, FailedGameAction, GameNotification, GameStatusKind,
    GameStatusOtherParams, LocalActionKind, SettlementOutcome, TimeoutClaimSemantic,
};
use crate::shutdown::get_conditions_with_channel_state;
use crate::utils::proper_list;

use crate::game_session::{phase_operation_error, PeerLifecyclePhase};
use crate::session_phases::types::{
    validate_new_move_action, BatchAction, FromLocalUI, GameAction, PeerMessage, PotatoState,
    WireGameSpec, WireProposalGroup,
};

use crate::session_phases::proposal::GameProposal;
#[cfg(test)]
use crate::session_phases::proposal::ProposalParameters;

pub mod effects;
pub mod game_collection;
pub mod handler_base;
pub mod handshake;
pub mod handshake_initiator;
pub mod handshake_receiver;
pub mod on_chain;
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

fn format_batch_action(action: &BatchAction) -> String {
    match action {
        BatchAction::ProposeGroup(group) => {
            format!(
                "ProposeGroup ids={:?} type={} timeout={}",
                group.members.iter().map(|m| m.game_id).collect::<Vec<_>>(),
                group.start.game_type,
                group.start.timeout,
            )
        }
        BatchAction::AcceptProposalGroup(id) => format!("AcceptProposalGroup id={id}"),
        BatchAction::CancelProposalGroup(id) => format!("CancelProposalGroup id={id}"),
        BatchAction::Move(id, details) => {
            format!(
                "Move id={id} mover_share={} max_move_size={} validation_info_hash={:?}",
                details.basic.mover_share,
                details.basic.max_move_size,
                details.validation_info_hash,
            )
        }
        BatchAction::AcceptSettlement(id, amount) => {
            format!("AcceptSettlement id={id} amt={amount}")
        }
    }
}

fn validate_wire_group_structure(
    wire: &WireProposalGroup,
    expected_members: usize,
) -> Result<Vec<GameID>, Error> {
    if wire.members.len() != expected_members {
        return Err(Error::StrErr(format!(
            "proposal group has {} members but factory returned {expected_members}",
            wire.members.len()
        )));
    }
    if wire.members.is_empty() {
        return Err(Error::StrErr("proposal group is empty".to_string()));
    }
    let ids: Vec<GameID> = wire.members.iter().map(|member| member.game_id).collect();
    if ids
        .iter()
        .enumerate()
        .any(|(index, id)| ids[..index].contains(id))
    {
        return Err(Error::StrErr(
            "proposal group contains duplicate game ids".to_string(),
        ));
    }
    Ok(ids)
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

impl OffChainPhase {
    fn ensure_game_types(&mut self, allocator: &mut AllocEncoder) {
        if self.game_types.is_empty() {
            self.game_types = crate::session_phases::game_collection::game_collection(allocator);
        }
    }

    fn factory_games(
        &mut self,
        env: &mut ChannelEnv<'_>,
        start: &GameProposal,
    ) -> Result<Vec<game::FactoryGame>, Error> {
        self.ensure_game_types(env.allocator);
        let factory = self
            .game_types
            .get(&start.game_type)
            .ok_or_else(|| Error::StrErr(format!("no such game {:?}", start.game_type)))?;
        let game_parameters = start.parameters.to_program(env.allocator)?;
        let game_parameters = game_parameters.to_clvm(env.allocator).into_gen()?;
        let arguments = (
            start.player_a_contribution.clone(),
            (
                start.player_b_contribution.clone(),
                (crate::common::types::Node(game_parameters), ()),
            ),
        )
            .to_clvm(env.allocator)
            .into_gen()?;
        let arguments = Program::from_nodeptr(env.allocator, arguments)?;
        let games = game::Game::run_factory(env.allocator, factory.clone().into(), &arguments)?;
        let first_hash = games
            .first()
            .map(|g| g.initial_validation_program_hash.clone())
            .ok_or_else(|| Error::StrErr("proposal factory returned no games".to_string()))?;
        if &first_hash != start.game_type.hash() {
            return Err(Error::StrErr(format!(
                "factory for {} returned first validator hash {}, expected {}",
                start.game_type, first_hash, start.game_type
            )));
        }
        Ok(games)
    }

    fn hydrate_wire_proposal_group(
        &mut self,
        allocator: &mut AllocEncoder,
        wire: &WireProposalGroup,
        factory_games: Vec<game::FactoryGame>,
    ) -> Result<(Vec<Rc<GameStartInfo>>, GameType), Error> {
        let ids = validate_wire_group_structure(wire, factory_games.len())?;

        let mut receiver_starts = Vec::with_capacity(factory_games.len());
        for (index, ((factory_game, member), game_id)) in factory_games
            .iter()
            .zip(&wire.members)
            .zip(ids.iter())
            .enumerate()
        {
            let expected_share = Amount::new(factory_game.initial_mover_share);
            if member.player_a_contribution != factory_game.player_a_contribution
                || member.player_b_contribution != factory_game.player_b_contribution
                || member.player_a_goes_first != factory_game.player_a_goes_first
                || member.initial_validation_program_hash
                    != factory_game.initial_validation_program_hash
                || member.initial_validation_info_hash
                    != factory_game.initial_validation_info_hash(allocator)
                || member.initial_move != factory_game.initial_move
                || member.initial_max_move_size != factory_game.initial_max_move_size
                || member.initial_mover_share != expected_share
            {
                return Err(Error::StrErr(format!(
                    "proposal group member {index} does not match factory output"
                )));
            }
            receiver_starts.push(Rc::new(factory_game.game_start(
                game_id,
                &wire.start.timeout,
                !wire.start.sender_is_player_a,
            )));
        }

        Ok((receiver_starts, wire.start.game_type.clone()))
    }

    pub fn from_completed_handshake(
        initiator: bool,
        channel_state: ChannelState,
        have_potato: PotatoState,
        game_types: BTreeMap<GameType, ProgramRef>,
        private_keys: ChannelPrivateKeys,
        my_contribution: Amount,
        their_contribution: Amount,
        channel_timeout: Timeout,
        unroll_timeout: Timeout,
        reward_puzzle_hash: PuzzleHash,
        incoming_messages: VecDeque<Rc<PeerMessage>>,
        last_channel_coin_spend_info: Option<ChannelCoinSpendInfo>,
    ) -> OffChainPhase {
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

        let (sent, batch_effects) = match self.drain_queue_into_batch(env) {
            Ok(result) => result,
            Err(error) => {
                if let Some((id, action)) = self.take_failed_queued_action() {
                    effects.push(Effect::Notify(GameNotification::ActionFailed {
                        id: Some(id),
                        action: Some(action),
                        reason: format!("{error:?}"),
                    }));
                    return Ok(effects);
                }
                return Err(error);
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
                clean_shutdown: None,
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
                clean_shutdown: None,
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
                clean_shutdown,
            } => {
                let ch_snapshot = self.channel_state.clone();
                let queue_snapshot = self.game_action_queue.clone();
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
                        self.channel_state = ch_snapshot;
                        self.game_action_queue = queue_snapshot;
                        return Err(e);
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
            PeerMessage::CleanShutdownComplete(coin_spend) => {
                let zero_payout = self
                    .channel_state()
                    .is_ok_and(|channel| channel.has_zero_payout());
                if zero_payout {
                    effects.push(Effect::CompleteZeroPayoutShutdown);
                } else {
                    effects.push(Effect::SpendTransaction(
                        SpendBundle {
                            name: Some("Create unroll".to_string()),
                            spends: vec![coin_spend.clone()],
                        },
                        None,
                    ));
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
        clean_shutdown: &Option<Box<(Aggsig, ProgramRef)>>,
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
                            GameAction::QueuedProposalGroup(games, _) => {
                                games.first().map(|g| g.game_id)
                            }
                            _ => None,
                        })
                        .collect();
                    self.game_action_queue
                        .retain(|a| !matches!(a, GameAction::QueuedProposalGroup(..)));
                    for id in cancelled {
                        effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                            id,
                            reason: CancelReason::SupersededByIncoming,
                        }));
                    }

                    self.ensure_game_types(env.allocator);
                    if !self.game_types.contains_key(&wire.start.game_type) {
                        effects.push(Effect::Log(format!(
                            "declining proposal for unknown game type {:?}",
                            wire.start.game_type,
                        )));
                    } else {
                        let factory_games = match self.factory_games(env, &wire.start) {
                            Ok(games) => games,
                            Err(error) => {
                                effects.push(Effect::Log(format!(
                                    "declining proposal because local factory rejected it: {error:?}"
                                )));
                                continue;
                            }
                        };
                        let (games, resolved_game_type) =
                            self.hydrate_wire_proposal_group(env.allocator, wire, factory_games)?;
                        let group_id = games
                            .first()
                            .ok_or_else(|| {
                                Error::StrErr("factory returned empty proposal group".to_string())
                            })?
                            .game_id;
                        for gsi in &games {
                            let ch = self.channel_state_mut()?;
                            ch.apply_received_proposal(env, gsi, group_id)?;
                        }
                        let first = games.first().ok_or_else(|| {
                            Error::StrErr("factory returned empty proposal group".to_string())
                        })?;
                        let game_id = first.game_id;
                        let group_ids: Vec<GameID> = games.iter().map(|g| g.game_id).collect();
                        effects.push(Effect::Notify(GameNotification::ProposalMade {
                            id: game_id,
                            group_ids,
                            player_a_contribution: wire.start.player_a_contribution.clone(),
                            player_b_contribution: wire.start.player_b_contribution.clone(),
                            sender_is_player_a: wire.start.sender_is_player_a,
                            timeout: first.timeout.clone(),
                            game_type: resolved_game_type,
                            parameters: wire.start.parameters.clone(),
                        }));
                    }
                }
                BatchAction::AcceptProposalGroup(group_id) => {
                    let group_ids = self.channel_state()?.canonical_group_member_ids(group_id)?;
                    let members = {
                        let ch = self.channel_state()?;
                        group_ids
                            .iter()
                            .map(|id| {
                                let proposal = ch.find_proposal(id).ok_or_else(|| {
                                    Error::StrErr(format!("missing accepted proposal {id}"))
                                })?;
                                let our_turn = ch.game_is_my_turn(id).ok_or_else(|| {
                                    Error::StrErr(format!(
                                        "accepted game {id} has no turn authority"
                                    ))
                                })?;
                                Ok(AcceptedGameMember {
                                    id: *id,
                                    amount: proposal.my_contribution.clone()
                                        + proposal.their_contribution.clone(),
                                    our_turn,
                                })
                            })
                            .collect::<Result<Vec<_>, Error>>()?
                    };
                    for id in group_ids {
                        self.channel_state_mut()?
                            .apply_received_accept_proposal(&id)?;
                    }
                    accepted_groups.push(members);
                }
                BatchAction::CancelProposalGroup(group_id) => {
                    let group_ids = self.channel_state()?.canonical_group_member_ids(group_id)?;
                    for id in group_ids {
                        self.channel_state_mut()?.received_cancel_proposal(&id)?;
                        effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                            id,
                            reason: CancelReason::CancelledByPeer,
                        }));
                    }
                }
                BatchAction::Move(game_id, game_move) => {
                    let move_result = {
                        let ch = self.channel_state_mut()?;
                        ch.apply_received_move(env, game_id, game_move)?
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

        if let Some(shutdown) = clean_shutdown {
            let (sig, conditions) = shutdown.as_ref();
            let has_active = {
                let ch = self.channel_state_mut()?;
                ch.has_active_games()
            };
            if has_active {
                return Err(Error::StrErr(
                    "opponent requested clean shutdown while games are active".to_string(),
                ));
            }
            {
                let ch = self.channel_state_mut()?;
                let cancelled_ids = ch.cancel_all_proposals();
                for id in cancelled_ids {
                    effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                        id,
                        reason: CancelReason::CleanShutdown,
                    }));
                }
            }

            let (coin, full_spend, channel_puzzle_public_key, zero_payout) = {
                let ch = self.channel_state_mut()?;
                let coin = ch.channel_coin().clone();
                let clvm_conditions = conditions.to_nodeptr(env.allocator)?;
                let expected_conditions = get_conditions_with_channel_state(env, ch)?;

                let peer_conds = proper_list(env.allocator.allocator_ref(), clvm_conditions, true)
                    .ok_or_else(|| {
                        Error::StrErr(
                            "clean shutdown conditions: peer conditions are not a proper list"
                                .to_string(),
                        )
                    })?;
                let expected_conds =
                    proper_list(env.allocator.allocator_ref(), expected_conditions, true)
                        .ok_or_else(|| {
                            Error::StrErr(
                        "clean shutdown conditions: expected conditions are not a proper list"
                            .to_string(),
                    )
                        })?;
                if peer_conds.len() != expected_conds.len() {
                    return Err(Error::StrErr(
                        "clean shutdown conditions: wrong number of conditions".to_string(),
                    ));
                }

                let mut peer_serialized: Vec<Vec<u8>> = peer_conds
                    .iter()
                    .map(|n| Program::from_nodeptr(env.allocator, *n))
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .map(|p| p.bytes().to_vec())
                    .collect();
                let mut expected_serialized: Vec<Vec<u8>> = expected_conds
                    .iter()
                    .map(|n| Program::from_nodeptr(env.allocator, *n))
                    .collect::<Result<Vec<_>, _>>()?
                    .into_iter()
                    .map(|p| p.bytes().to_vec())
                    .collect();
                peer_serialized.sort();
                expected_serialized.sort();
                if peer_serialized != expected_serialized {
                    return Err(Error::StrErr(
                        "clean shutdown conditions don't match expected payout".to_string(),
                    ));
                }

                let zero_payout = ch.has_zero_payout();
                let full_spend = ch.received_potato_clean_shutdown(env, sig, clvm_conditions)?;
                let channel_puzzle_public_key = ch.get_aggregate_channel_public_key();
                (coin, full_spend, channel_puzzle_public_key, zero_payout)
            };

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
            if zero_payout {
                effects.push(Effect::QueueTerminalHandoff(coin_spend));
            } else {
                effects.push(Effect::SpendTransaction(
                    SpendBundle {
                        name: Some("Create unroll".to_string()),
                        spends: vec![coin_spend.clone()],
                    },
                    None,
                ));
                effects.push(Effect::PeerCleanShutdownComplete(coin_spend));
            }

            let handler = crate::session_phases::spend_channel_coin_phase::SpendChannelCoinPhase::new_for_clean_shutdown(
                self.channel_state.take(),
                coin.clone(),
                full_spend.solution.clone(),
                std::mem::take(&mut self.game_action_queue),
                PotatoState::Present,
                self.channel_timeout.clone(),
                self.unroll_timeout.clone(),
                self.last_channel_coin_spend_info.take(),
            );
            self.channel_spend_next_phase = Some(Box::new(handler));
            return Ok(effects);
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
            received_accept_settlement,
        )?);
        effects.extend(
            accepted_groups
                .into_iter()
                .map(|members| Effect::Notify(GameNotification::ProposalAcceptedGroup { members })),
        );

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
    ) -> Result<(bool, Vec<Effect>), Error> {
        game_assert!(
            matches!(self.have_potato, PotatoState::Present),
            "drain_queue_into_batch: must have potato"
        );
        let mut effects = Vec::new();
        let mut batch_actions: Vec<BatchAction> = Vec::new();
        let mut clean_shutdown_data: Option<Box<(Aggsig, ProgramRef)>> = None;
        let mut pending_shutdown: Option<(CoinString, ProgramRef)> = None;
        let mut deferred = VecDeque::new();
        let mut applied_actions = Vec::new();

        while let Some(action) = self.game_action_queue.pop_front() {
            self.last_failed_queued_action = failed_game_action_context(&action);
            match action {
                GameAction::Move(game_id, readable_move, new_entropy) => {
                    let ch = self.channel_state_mut()?;
                    let game_is_my_turn = ch.game_is_my_turn(&game_id);
                    if let Some(true) = game_is_my_turn {
                        match ch.send_move_no_finalize(env, &game_id, &readable_move, new_entropy) {
                            Ok(move_result) => {
                                batch_actions
                                    .push(BatchAction::Move(game_id, move_result.game_move));
                                applied_actions.push((game_id, LocalActionKind::MakeMove));
                            }
                            Err(Error::GameMoveRejected { tag, message }) => {
                                effects.push(Effect::Notify(GameNotification::MoveRejected {
                                    id: game_id,
                                    tag: String::from_utf8_lossy(&tag).into_owned(),
                                    message: String::from_utf8_lossy(&message).into_owned(),
                                }));
                            }
                            Err(error) => return Err(error),
                        }
                    } else {
                        deferred.push_back(GameAction::Move(game_id, readable_move, new_entropy));
                    }
                }
                GameAction::Cheat(game_id, mover_share, entropy) => {
                    let ch = self.channel_state_mut()?;
                    let game_is_my_turn = ch.game_is_my_turn(&game_id);
                    if let Some(true) = game_is_my_turn {
                        ch.enable_cheating_for_game(&game_id, &[0x80], mover_share)?;
                        let readable_move =
                            ReadableMove::from_program(Rc::new(Program::from_bytes(&[0x80])));
                        let move_result =
                            ch.send_move_no_finalize(env, &game_id, &readable_move, entropy)?;
                        batch_actions.push(BatchAction::Move(game_id, move_result.game_move));
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
                GameAction::QueuedProposalGroup(my_games, their_wire) => {
                    let saved_channel = self.channel_state.clone();
                    let result = (|| {
                        let group_id = their_wire
                            .members
                            .first()
                            .ok_or_else(|| {
                                Error::StrErr("queued proposal group is empty".to_string())
                            })?
                            .game_id;
                        for game in &my_games {
                            let ch = self.channel_state_mut()?;
                            ch.send_propose_game(env, game, group_id)?;
                        }
                        Ok::<(), Error>(())
                    })();
                    if let Err(error) = result {
                        self.channel_state = saved_channel;
                        return Err(error);
                    }
                    batch_actions.push(BatchAction::ProposeGroup(their_wire));
                }
                GameAction::QueuedAcceptProposalGroup(group_id) => {
                    let group_ids = self
                        .channel_state()?
                        .canonical_group_member_ids(&group_id)?;
                    let (our_short, their_short, members) = {
                        let ch = self.channel_state()?;
                        let mut our_required = Amount::default();
                        let mut their_required = Amount::default();
                        let mut members = Vec::with_capacity(group_ids.len());
                        for id in &group_ids {
                            let proposal = ch.find_proposal(id).ok_or_else(|| {
                                Error::StrErr(format!("queued accept for missing proposal {id:?}"))
                            })?;
                            if ch.is_our_nonce_parity(id) {
                                return Err(Error::StrErr(
                                    "cannot accept own proposal".to_string(),
                                ));
                            }
                            our_required += proposal.my_contribution.clone();
                            their_required += proposal.their_contribution.clone();
                            members.push(AcceptedGameMember {
                                id: *id,
                                amount: proposal.my_contribution.clone()
                                    + proposal.their_contribution.clone(),
                                our_turn: ch.game_is_my_turn(id).ok_or_else(|| {
                                    Error::StrErr(format!(
                                        "accepted game {id} has no turn authority"
                                    ))
                                })?,
                            });
                        }
                        (
                            our_required > ch.my_out_of_game_balance(),
                            their_required > ch.their_out_of_game_balance(),
                            members,
                        )
                    };
                    if our_short || their_short {
                        effects.push(Effect::Notify(GameNotification::InsufficientBalance {
                            id: group_id,
                            our_balance_short: our_short,
                            their_balance_short: their_short,
                        }));
                        for id in &group_ids {
                            self.channel_state_mut()?.send_cancel_proposal(id)?;
                        }
                        batch_actions.push(BatchAction::CancelProposalGroup(group_id));
                        continue;
                    }
                    let saved_channel = self.channel_state.clone();
                    let result = (|| {
                        for id in &group_ids {
                            self.channel_state_mut()?.send_accept_proposal(id)?;
                        }
                        Ok::<(), Error>(())
                    })();
                    if let Err(error) = result {
                        self.channel_state = saved_channel;
                        return Err(error);
                    }
                    batch_actions.push(BatchAction::AcceptProposalGroup(group_id));
                    effects.push(Effect::Notify(GameNotification::ProposalAcceptedGroup {
                        members,
                    }));
                }
                GameAction::QueuedCancelProposalGroup(group_id) => {
                    let group_ids = self
                        .channel_state()?
                        .canonical_group_member_ids(&group_id)?;
                    for id in group_ids {
                        self.channel_state_mut()?.send_cancel_proposal(&id)?;
                        effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                            id,
                            reason: CancelReason::CancelledByUs,
                        }));
                    }
                    batch_actions.push(BatchAction::CancelProposalGroup(group_id));
                }
                GameAction::QueuedCancelProposalGroupSilently(group_id) => {
                    let group_ids = self
                        .channel_state()?
                        .canonical_group_member_ids(&group_id)?;
                    for id in group_ids {
                        self.channel_state_mut()?.send_cancel_proposal(&id)?;
                    }
                    batch_actions.push(BatchAction::CancelProposalGroup(group_id));
                }
                GameAction::CleanShutdown => {
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
                        let cancelled_ids = ch.cancel_all_proposals();
                        for id in cancelled_ids {
                            effects.push(Effect::Notify(GameNotification::ProposalCancelled {
                                id,
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

                    let shutdown_condition_program =
                        Rc::new(Program::from_nodeptr(env.allocator, real_conditions)?);
                    clean_shutdown_data = Some(Box::new((
                        spend.signature.clone(),
                        shutdown_condition_program.into(),
                    )));

                    pending_shutdown = Some((channel_coin.clone(), spend.solution.clone()));
                }
                #[cfg(test)]
                GameAction::ForcedSelfAccept(game_id) => {
                    let ch = self.channel_state_mut()?;
                    ch.send_accept_proposal(&game_id)?;
                    batch_actions.push(BatchAction::AcceptProposalGroup(game_id));
                }
            }
        }

        self.game_action_queue = deferred;

        if batch_actions.is_empty() && clean_shutdown_data.is_none() {
            // No batch was packaged; deferred actions remain pending for a
            // future potato receipt, so this flush has no attributable failure.
            self.last_failed_queued_action = None;
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

        if let Some(shutdown_info) = pending_shutdown {
            self.pending_clean_shutdown = Some(shutdown_info);
        }

        // Packaging and delivery intent succeeded. Later failures cannot be
        // attributed to a still-pending local action from this flush.
        self.last_failed_queued_action = None;
        Ok((true, effects))
    }

    const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024; // 10 MiB

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
            let msg_envelope: PeerMessage = bencodex::from_slice(&msg).into_gen()?;
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
                PeerMessage::CleanShutdownComplete(_) => {
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
            PeerMessage::HandshakeF(_) => {}

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
        env: &mut ChannelEnv<'_>,
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
            let cancelled_id = {
                let ch = self.channel_state_mut()?;
                GameID(ch.allocate_my_nonce())
            };
            return Ok((
                vec![cancelled_id],
                vec![Effect::Notify(GameNotification::ProposalCancelled {
                    id: cancelled_id,
                    reason: CancelReason::PeerProposalPending,
                })],
            ));
        }

        let factory_games = self.factory_games(env, start)?;
        if factory_games.is_empty() {
            return Err(Error::StrErr(
                "propose_games: factory returned empty proposal group".to_string(),
            ));
        }

        let mut all_ids = Vec::with_capacity(factory_games.len());
        for _ in &factory_games {
            let game_id = {
                let ch = self.channel_state_mut()?;
                GameID(ch.allocate_my_nonce())
            };
            all_ids.push(game_id);
        }
        let my_games: Vec<Rc<GameStartInfo>> = factory_games
            .iter()
            .zip(&all_ids)
            .map(|(game, id)| {
                Rc::new(game.game_start(id, &start.timeout, start.sender_is_player_a))
            })
            .collect();
        let members = factory_games
            .iter()
            .zip(&all_ids)
            .map(|(game, id)| WireGameSpec {
                game_id: *id,
                player_a_contribution: game.player_a_contribution.clone(),
                player_b_contribution: game.player_b_contribution.clone(),
                player_a_goes_first: game.player_a_goes_first,
                initial_validation_program_hash: game.initial_validation_program_hash.clone(),
                initial_validation_info_hash: game.initial_validation_info_hash(env.allocator),
                initial_move: game.initial_move.clone(),
                initial_max_move_size: game.initial_max_move_size,
                initial_mover_share: Amount::new(game.initial_mover_share),
            })
            .collect();
        self.push_action(GameAction::QueuedProposalGroup(
            my_games,
            WireProposalGroup {
                start: start.clone(),
                members,
            },
        ));

        let (_has_potato, effect) = self.send_potato_request_if_needed()?;
        let effects: Vec<Effect> = effect.into_iter().collect();
        Ok((all_ids, effects))
    }

    fn accept_proposal(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        let group_ids = {
            let ch = self.channel_state()?;
            ch.group_member_ids(game_id)?
        };
        let (our_short, their_short) = {
            let ch = self.channel_state()?;
            let mut our_required = Amount::default();
            let mut their_required = Amount::default();
            for id in &group_ids {
                let proposal = ch
                    .find_proposal(id)
                    .ok_or_else(|| Error::StrErr(format!("missing proposal group member {id}")))?;
                our_required += proposal.my_contribution.clone();
                their_required += proposal.their_contribution.clone();
            }
            (
                our_required > ch.my_out_of_game_balance(),
                their_required > ch.their_out_of_game_balance(),
            )
        };
        let mut all_effects = Vec::new();
        if our_short || their_short {
            let group_id = *group_ids
                .first()
                .ok_or_else(|| Error::StrErr("proposal group cannot be empty".to_string()))?;
            all_effects.push(Effect::Notify(GameNotification::InsufficientBalance {
                id: group_id,
                our_balance_short: our_short,
                their_balance_short: their_short,
            }));
            let (_continued, effects) =
                self.do_game_action(GameAction::QueuedCancelProposalGroupSilently(group_id))?;
            all_effects.extend(effects);
            return Ok(all_effects);
        }
        let primary_id = *group_ids
            .first()
            .ok_or_else(|| Error::StrErr("proposal group cannot be empty".to_string()))?;
        let (_continued, effects) =
            self.do_game_action(GameAction::QueuedAcceptProposalGroup(primary_id))?;
        all_effects.extend(effects);
        Ok(all_effects)
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
        let (_continued, effects) =
            self.do_game_action(GameAction::Move(*id, readable.clone(), new_entropy))?;

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
    fn new_block(&mut self, _height: u64) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }
    fn handshake_finished(&self) -> bool {
        OffChainPhase::handshake_finished(self)
    }
    fn is_on_chain(&self) -> bool {
        false
    }
    fn start_handshake(&mut self, _env: &mut ChannelEnv<'_>) -> Result<Option<Effect>, Error> {
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
    fn provide_launcher_coin(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _launcher_coin: CoinString,
    ) -> Result<Vec<Effect>, Error> {
        Err(phase_operation_error(
            self.phase_name(),
            "provide_launcher_coin",
        ))
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

    fn member(id: u64) -> WireGameSpec {
        WireGameSpec {
            game_id: GameID(id),
            player_a_contribution: Amount::new(100),
            player_b_contribution: Amount::new(100),
            player_a_goes_first: true,
            initial_validation_program_hash: Hash::default(),
            initial_validation_info_hash: Hash::default(),
            initial_move: vec![],
            initial_max_move_size: 32,
            initial_mover_share: Amount::default(),
        }
    }

    fn group(members: Vec<WireGameSpec>) -> WireProposalGroup {
        WireProposalGroup {
            start: GameProposal {
                player_a_contribution: Amount::new(100),
                player_b_contribution: Amount::new(100),
                sender_is_player_a: true,
                game_type: GameType::from_hash(Hash::default()),
                timeout: Timeout::new(15),
                parameters: ProposalParameters::Null,
            },
            members,
        }
    }

    #[test]
    fn atomic_group_structure_rejects_malformed_membership() {
        assert!(validate_wire_group_structure(&group(vec![]), 1).is_err());
        assert!(validate_wire_group_structure(&group(vec![member(1), member(1)]), 2).is_err());
        assert!(validate_wire_group_structure(&group(vec![member(1), member(3)]), 1).is_err());
    }

    #[test]
    fn atomic_group_structure_accepts_canonical_single_and_multi_member_groups() {
        assert_eq!(
            validate_wire_group_structure(&group(vec![member(1)]), 1).unwrap(),
            vec![GameID(1)]
        );
        assert_eq!(
            validate_wire_group_structure(&group(vec![member(1), member(3)]), 2).unwrap(),
            vec![GameID(1), GameID(3)]
        );
    }
}
