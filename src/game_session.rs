use std::collections::{BTreeMap, VecDeque};

use clvm_traits::ToClvm;

use rand::Rng;

use serde::{Deserialize, Serialize};

#[cfg(test)]
use crate::channel_state::types::ChannelCoinSpendInfo;
use crate::channel_state::types::{ChannelEnv, ChannelPrivateKeys, ReadableMove};
use crate::channel_state::ChannelState;
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    sign_agg_sig_me, solution_for_conditions, standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinCondition, CoinSpend, CoinString, Error, GameID, GameType,
    Hash, IntoErr, Program, ProgramRef, Puzzle, PuzzleHash, Sha256tree, Spend, SpendBundle,
    Timeout, ToQuotedProgram,
};
use crate::session_phases::effects::{
    apply_effects, ChannelStatus, ChannelStatusSnapshot, CoinOfInterest, Effect, FailedGameAction,
    GameNotification, GameSessionEvent, GameSessionEventQueue, SessionDisposition,
    TimeoutClaimSemantic,
};
use crate::session_phases::handshake_initiator::HandshakeInitiatorPhase;
use crate::session_phases::handshake_receiver::HandshakeReceiverPhase;
use crate::session_phases::proposal::GameProposal;
use crate::session_phases::types::{
    ChannelFundingWallet, OffChainPhaseInit, PacketSender, PeerMessage, SpendWalletReceiver,
    ToLocalUI, WalletSpendInterface,
};

#[cfg(test)]
use crate::session_phases::OffChainPhase;

pub(crate) fn phase_operation_error(phase: &str, operation: &str) -> Error {
    Error::StrErr(format!("{operation} is not available in {phase}"))
}

/// Complete protocol surface implemented explicitly by every lifecycle phase.
///
/// Methods intentionally have no behavioral defaults: a phase must state
/// whether each operation is active, invalid, or a deliberate no-op.
#[typetag::serde]
pub trait PeerLifecyclePhase {
    fn phase_name(&self) -> &'static str;
    fn has_queued_message(&self) -> bool;
    fn process_queued_message(&mut self, env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error>;
    fn has_queued_action(&self) -> bool;
    fn process_queued_action(&mut self, env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error>;
    fn received_message(
        &mut self,
        env: &mut ChannelEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error>;
    fn coin_spent(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error>;
    fn coin_created(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error>;
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<Vec<Effect>, Error>;
    fn make_move(
        &mut self,
        env: &mut ChannelEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error>;
    fn accept_settlement(
        &mut self,
        env: &mut ChannelEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error>;
    fn cheat_game(
        &mut self,
        env: &mut ChannelEnv<'_>,
        game_id: &GameID,
        mover_share: Amount,
        entropy: Hash,
    ) -> Result<Vec<Effect>, Error>;
    #[cfg(test)]
    fn self_accept_proposal(
        &mut self,
        env: &mut ChannelEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error>;
    fn take_next_phase(&mut self) -> Option<Box<dyn PeerLifecyclePhase>>;
    fn new_block(&mut self, height: u64) -> Result<Vec<Effect>, Error>;
    fn handshake_finished(&self) -> bool;
    fn is_on_chain(&self) -> bool;
    fn start_handshake(&mut self, env: &mut ChannelEnv<'_>) -> Result<Option<Effect>, Error>;
    fn channel_offer(
        &mut self,
        env: &mut ChannelEnv<'_>,
        bundle: SpendBundle,
    ) -> Result<Option<Effect>, Error>;
    fn channel_transaction_completion(
        &mut self,
        env: &mut ChannelEnv<'_>,
        bundle: &SpendBundle,
    ) -> Result<Option<Effect>, Error>;
    fn provide_launcher_coin(
        &mut self,
        env: &mut ChannelEnv<'_>,
        launcher_coin: CoinString,
    ) -> Result<Vec<Effect>, Error>;
    fn provide_coin_spend_bundle(
        &mut self,
        env: &mut ChannelEnv<'_>,
        bundle: SpendBundle,
    ) -> Result<Vec<Effect>, Error>;
    fn propose_games(
        &mut self,
        env: &mut ChannelEnv<'_>,
        games: &[GameProposal],
    ) -> Result<(Vec<GameID>, Vec<Effect>), Error>;
    fn accept_proposal(
        &mut self,
        env: &mut ChannelEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error>;
    fn cancel_proposal(
        &mut self,
        env: &mut ChannelEnv<'_>,
        game_id: &GameID,
    ) -> Result<Vec<Effect>, Error>;
    fn shut_down(&mut self, env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error>;
    fn go_on_chain(
        &mut self,
        env: &mut ChannelEnv<'_>,
        got_error: bool,
    ) -> Result<Vec<Effect>, Error>;
    fn flush_pending_actions(&mut self, env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error>;
    fn take_failed_queued_action(&mut self) -> Option<(GameID, FailedGameAction)>;
    fn channel_state(&self) -> Result<&ChannelState, Error>;
    fn channel_status_snapshot(&self) -> Option<ChannelStatusSnapshot>;
    fn wallet_callback_failed(&mut self, reason: String);
    fn has_active_on_chain_games(&self) -> bool;
    fn timeout_claim_submitted(
        &mut self,
        semantic: TimeoutClaimSemantic,
    ) -> Result<Option<GameNotification>, Error>;
    fn timeout_claim_rearmed(
        &mut self,
        semantic: TimeoutClaimSemantic,
    ) -> Result<Option<GameNotification>, Error>;

    /// Coin ids worth surfacing in the dashboard (channel/unroll/change/game/
    /// game-change), each tagged with its kind.
    fn coins_of_interest(&self) -> Vec<(CoinOfInterest, CoinString)>;

    #[cfg(test)]
    fn corrupt_state_for_testing(&mut self, new_sn: usize) -> Result<(), Error>;
    #[cfg(test)]
    fn force_unroll_spend_for_testing(
        &self,
        env: &mut ChannelEnv<'_>,
    ) -> Result<SpendBundle, Error>;
    #[cfg(test)]
    fn last_channel_coin_spend_info_for_testing(&self) -> Option<ChannelCoinSpendInfo>;
    #[cfg(test)]
    fn force_stale_unroll_spend_for_testing(
        &self,
        env: &mut ChannelEnv<'_>,
        saved: &ChannelCoinSpendInfo,
    ) -> Result<SpendBundle, Error>;
    #[cfg(test)]
    fn take_off_chain_phase_for_testing(&mut self) -> Option<OffChainPhase>;
    fn get_game_coin(&self, game_id: &GameID) -> Option<CoinString>;
}

impl SpendWalletReceiver for Box<dyn PeerLifecyclePhase> {
    fn coin_created(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        (**self).coin_created(env, coin_id)
    }
    fn coin_spent(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        (**self).coin_spent(env, coin_id)
    }
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<Vec<Effect>, Error> {
        (**self).coin_puzzle_and_solution(env, coin_id, puzzle_and_solution)
    }
}

#[derive(Default)]
pub struct MessagePipe {
    pub my_id: usize,

    // PacketSender
    pub queue: VecDeque<Vec<u8>>,
}

pub trait MessagePeerQueue {
    fn message_pipe(&mut self) -> &mut MessagePipe;
    fn get_channel_puzzle_hash(&self) -> Option<PuzzleHash>;
    fn set_channel_puzzle_hash(&mut self, ph: Option<PuzzleHash>);
    fn get_unfunded_offer(&self) -> Option<SpendBundle>;
}

/// A watched coin lifecycle fact, in the order it must reach the active phase.
///
/// A coin first discovered already spent is represented as `Created` followed by
/// `Spent`, allowing creation to transition the phase before its spend arrives.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CoinObservation {
    Created(CoinString),
    Spent(CoinString),
}

pub enum WalletBootstrapState {
    PartlySigned(Spend),
    FullySigned(Spend),
}

// potato handler tests with simulator.
#[derive(Default)]
#[cfg(test)]
pub struct SimulatedWalletSpend {}

#[derive(Default)]
pub struct SimulatedPeer<CoinTracker> {
    pub message_pipe: MessagePipe,

    // Bootstrap info
    pub channel_puzzle_hash: Option<PuzzleHash>,

    pub unfunded_offer: Option<SpendBundle>,

    pub simulated_wallet_spend: CoinTracker,
}

#[cfg(test)]
impl MessagePeerQueue for SimulatedPeer<SimulatedWalletSpend> {
    fn message_pipe(&mut self) -> &mut MessagePipe {
        &mut self.message_pipe
    }
    fn get_channel_puzzle_hash(&self) -> Option<PuzzleHash> {
        self.channel_puzzle_hash.clone()
    }
    fn set_channel_puzzle_hash(&mut self, ph: Option<PuzzleHash>) {
        self.channel_puzzle_hash = ph;
    }
    fn get_unfunded_offer(&self) -> Option<SpendBundle> {
        self.unfunded_offer.clone()
    }
}

#[derive(Default)]
pub struct DrainResult {
    pub events: GameSessionEventQueue,
}

/// A signed clean-shutdown message that must be durably handed to the peer
/// before this local session can be abandoned.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalHandoffCommand {
    pub id: u64,
    pub message: Vec<u8>,
}

#[derive(Serialize, Deserialize)]
struct GameSessionState {
    current_height: u64,

    is_initiator: bool,
    channel_puzzle_hash: Option<PuzzleHash>,
    funding_coin: Option<CoinString>,
    unfunded_offer: Option<SpendBundle>,
    inbound_messages: VecDeque<Vec<u8>>,
    clean_shutdown_received: bool,
    clean_shutdown: Option<CoinString>,
    identity: ChiaIdentity,
    peer_disconnected: bool,

    pub is_failed: bool,
    pub is_on_chain: bool,
    #[serde(default)]
    session_disposition: Option<SessionDisposition>,
    #[serde(default)]
    pending_outbound_terminal: Option<TerminalHandoffCommand>,
    #[serde(default)]
    next_terminal_handoff_id: u64,
    #[serde(default)]
    channel_creation_expiry: Option<u64>,
    #[serde(default)]
    channel_established: bool,
    #[serde(default)]
    channel_expired: bool,

    /// Genesis challenge (AGG_SIG_ME additional data) for the network this
    /// session is bound to. Threaded in at creation so all on-chain signing
    /// (channel funding, unroll, clean-shutdown payout) matches the connected
    /// network. Persisted so restored sessions keep signing correctly.
    agg_sig_me_additional_data: Hash,

    #[serde(skip)]
    events: GameSessionEventQueue,
}

impl PacketSender for GameSessionState {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error> {
        if self.peer_disconnected {
            return Ok(());
        }
        let msg_data = bencodex::to_vec(&msg).map_err(|e| Error::StrErr(format!("{e:?}")))?;
        self.events
            .push_back(GameSessionEvent::OutboundMessage(msg_data));
        Ok(())
    }
}

impl WalletSpendInterface for GameSessionState {
    fn spend_transaction_and_add_fee(
        &mut self,
        bundle: &SpendBundle,
        expiry: Option<u64>,
    ) -> Result<(), Error> {
        if expiry.is_some() {
            self.channel_creation_expiry = expiry;
        }
        self.events.push_back(GameSessionEvent::OutboundTransaction(
            bundle.clone(),
            expiry,
        ));
        Ok(())
    }
    fn register_coin(
        &mut self,
        coin_id: &CoinString,
        timeout: &Timeout,
        _name: Option<&'static str>,
        spend: Option<SpendBundle>,
        semantic: Option<TimeoutClaimSemantic>,
    ) -> Result<(), Error> {
        self.events.push_back(GameSessionEvent::WatchCoin {
            coin_name: coin_id.to_coin_id(),
            coin_string: coin_id.clone(),
            timeout: timeout.clone(),
            spend,
            semantic,
        });

        Ok(())
    }
    fn request_puzzle_and_solution(&mut self, coin_id: &CoinString) -> Result<(), Error> {
        self.events
            .push_back(GameSessionEvent::CoinSolutionRequest(coin_id.clone()));
        Ok(())
    }
}

/// Production game-session host: owns the current [`PeerLifecyclePhase`], inbound
/// queues, and outbound [`GameSessionEvent`]s.
#[derive(Serialize, Deserialize)]
pub struct GameSession {
    state: GameSessionState,
    peer: Box<dyn PeerLifecyclePhase>,
    last_channel_status: Option<ChannelStatusSnapshot>,
    #[cfg(test)]
    #[serde(skip)]
    saved_unroll_snapshot: Option<ChannelCoinSpendInfo>,
}

#[derive(Debug, Clone)]
pub struct GameSessionConfig {
    pub game_types: BTreeMap<GameType, ProgramRef>,
    pub have_potato: bool,
    pub identity: ChiaIdentity,
    pub my_contribution: Amount,
    pub their_contribution: Amount,
    pub channel_timeout: Timeout,
    pub unroll_timeout: Timeout,
    pub reward_puzzle_hash: PuzzleHash,
    /// Genesis challenge (AGG_SIG_ME additional data) for the target network.
    pub agg_sig_me_additional_data: Hash,
}

/// Scan a wallet `SpendBundle` for settlement-payment outputs created by
/// `createOfferForIds` and append claim spends that consume them.
///
/// The real Chia wallet's `createOfferForIds` produces balanced spends: the
/// offered mojos are routed to a settlement-payment puzzle (OFFER_MOD) instead
/// of creating a true deficit.  Channel funding needs deficit spends so the
/// launcher's channel coin creation is covered.  By spending the settlement
/// coins with an empty solution (no outputs), their value becomes deficit.
fn claim_settlement_coins(allocator: &mut AllocEncoder, bundle: SpendBundle) -> SpendBundle {
    let settlement_ph = PuzzleHash::from_bytes(chia_puzzles::SETTLEMENT_PAYMENT_HASH);
    let settlement_puzzle = Puzzle::from_bytes(&chia_puzzles::SETTLEMENT_PAYMENT);
    let empty_solution: ProgramRef = Program::from_bytes(&[0x80]).into();

    let mut claim_spends = Vec::new();

    for spend in &bundle.spends {
        let puzzle_prog = spend.bundle.puzzle.to_program();
        let solution_prog = spend.bundle.solution.p();
        let conditions = match CoinCondition::from_puzzle_and_solution(
            allocator,
            &puzzle_prog,
            &solution_prog,
        ) {
            Ok(c) => c,
            Err(_) => continue,
        };

        let parent_coin_id = spend.coin.to_coin_id();

        for cond in &conditions {
            if let CoinCondition::CreateCoin(ph, amount) = cond {
                if *ph == settlement_ph {
                    let settlement_coin =
                        CoinString::from_parts(&parent_coin_id, &settlement_ph, amount);
                    claim_spends.push(CoinSpend {
                        coin: settlement_coin,
                        bundle: Spend {
                            puzzle: settlement_puzzle.clone(),
                            solution: empty_solution.clone(),
                            signature: Aggsig::default(),
                        },
                    });
                }
            }
        }
    }

    if claim_spends.is_empty() {
        return bundle;
    }

    let mut spends = bundle.spends;
    spends.extend(claim_spends);
    SpendBundle {
        name: bundle.name,
        spends,
    }
}

impl GameSession {
    pub fn new_with_keys(config: GameSessionConfig, private_keys: ChannelPrivateKeys) -> Self {
        GameSession {
            state: GameSessionState {
                is_initiator: config.have_potato,
                current_height: 0,
                identity: config.identity.clone(),
                channel_puzzle_hash: None,
                funding_coin: None,
                unfunded_offer: None,
                clean_shutdown: None,
                clean_shutdown_received: false,
                peer_disconnected: false,
                is_failed: false,
                is_on_chain: false,
                session_disposition: None,
                pending_outbound_terminal: None,
                next_terminal_handoff_id: 0,
                channel_creation_expiry: None,
                channel_established: false,
                channel_expired: false,
                agg_sig_me_additional_data: config.agg_sig_me_additional_data.clone(),
                events: GameSessionEventQueue::default(),
                inbound_messages: VecDeque::default(),
            },
            peer: {
                let phi = OffChainPhaseInit {
                    have_potato: config.have_potato,
                    private_keys,
                    game_types: config.game_types,
                    my_contribution: config.my_contribution.clone(),
                    their_contribution: config.their_contribution.clone(),
                    channel_timeout: config.channel_timeout,
                    unroll_timeout: config.unroll_timeout,
                    reward_puzzle_hash: config.reward_puzzle_hash,
                };
                if config.have_potato {
                    Box::new(HandshakeInitiatorPhase::new(phi)) as Box<dyn PeerLifecyclePhase>
                } else {
                    Box::new(HandshakeReceiverPhase::new(phi)) as Box<dyn PeerLifecyclePhase>
                }
            },
            last_channel_status: None,
            #[cfg(test)]
            saved_unroll_snapshot: None,
        }
    }
    pub fn new<R: Rng>(rng: &mut R, config: GameSessionConfig) -> Self {
        let private_keys: ChannelPrivateKeys = rng.random();
        GameSession::new_with_keys(config, private_keys)
    }
}

impl ChannelFundingWallet for GameSessionState {
    fn channel_puzzle_hash(&mut self, puzzle_hash: &PuzzleHash) -> Result<(), Error> {
        self.channel_puzzle_hash = Some(puzzle_hash.clone());
        Ok(())
    }

    fn received_channel_offer(&mut self, bundle: &SpendBundle) -> Result<(), Error> {
        self.unfunded_offer = Some(bundle.clone());
        Ok(())
    }
}

impl ToLocalUI for GameSessionState {
    fn notification(&mut self, notification: &GameNotification) -> Result<(), Error> {
        self.events
            .push_back(GameSessionEvent::Notification(notification.clone()));
        Ok(())
    }

    fn log(&mut self, line: &str) -> Result<(), Error> {
        self.events
            .push_back(GameSessionEvent::Log(line.to_string()));
        Ok(())
    }
}

impl GameSession {
    #[cfg(test)]
    pub fn proposal_contributions_for_testing(
        &self,
    ) -> Result<Vec<(GameID, Amount, Amount)>, Error> {
        let channel = self.peer.channel_state()?;
        Ok(channel.proposal_contributions_for_testing())
    }

    #[cfg(test)]
    pub fn allocated_balances_for_testing(&self) -> Result<(Amount, Amount), Error> {
        let channel = self.peer.channel_state()?;
        Ok((
            channel.my_allocated_balance(),
            channel.their_allocated_balance(),
        ))
    }

    #[cfg(test)]
    pub fn corrupt_state_for_testing(&mut self, new_sn: usize) -> Result<(), Error> {
        self.peer.corrupt_state_for_testing(new_sn)
    }

    #[cfg(test)]
    pub fn force_unroll_spend(&self, allocator: &mut AllocEncoder) -> Result<SpendBundle, Error> {
        let mut env =
            ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
        self.peer.force_unroll_spend_for_testing(&mut env)
    }

    #[cfg(test)]
    pub fn save_unroll_snapshot(&mut self) {
        self.saved_unroll_snapshot = self.peer.last_channel_coin_spend_info_for_testing();
    }

    #[cfg(test)]
    pub fn force_stale_unroll_spend(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Result<SpendBundle, Error> {
        let saved = self.saved_unroll_snapshot.as_ref().ok_or_else(|| {
            Error::StrErr("force_stale_unroll_spend: no snapshot saved".to_string())
        })?;
        let mut env =
            ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
        self.peer
            .force_stale_unroll_spend_for_testing(&mut env, saved)
    }

    /// Render the current protocol-level peer state as indented text for the
    /// dashboard. The peer is serialized to bencodex (via typetag, so the
    /// concrete phase becomes the top-level tag) and re-read into an untyped
    /// tree so the renderer can apply length- and name-based elision.
    pub fn protocol_state_pretty(&self) -> Result<String, Error> {
        let bytes = bencodex::to_vec(&self.peer)
            .map_err(|e| Error::StrErr(format!("protocol_state_pretty serialize: {e:?}")))?;
        let value: crate::protocol_pretty::BencodexValue = bencodex::from_slice(&bytes)
            .map_err(|e| Error::StrErr(format!("protocol_state_pretty parse: {e:?}")))?;
        Ok(crate::protocol_pretty::pretty_print(&value))
    }

    pub fn historical_unroll_count(&self) -> Option<usize> {
        self.peer
            .channel_state()
            .ok()
            .map(|channel| channel.unroll_puzzle_hash_map().len())
    }

    /// Labeled coin ids (hex) the dashboard shows above the protocol state so
    /// the user can look them up in a block explorer. Sourced from the active
    /// phase handler; an on-chain grouped hand can surface multiple entries.
    pub fn coins_of_interest(&self) -> Vec<(String, String)> {
        self.peer
            .coins_of_interest()
            .into_iter()
            .map(|(kind, coin)| (kind.label().to_string(), coin.to_coin_id().to_string()))
            .collect()
    }

    pub fn is_peer_disconnected(&self) -> bool {
        self.state.peer_disconnected
    }

    pub fn is_abandoned(&self) -> bool {
        matches!(
            self.state.session_disposition,
            Some(SessionDisposition::Abandoned)
        )
    }

    pub fn pending_terminal_handoff(&self) -> Option<TerminalHandoffCommand> {
        self.state.pending_outbound_terminal.clone()
    }

    /// True when the last emitted [`ChannelStatus`] is a terminal channel state (sim `should_end`).
    pub fn channel_status_terminal(&self) -> bool {
        self.state.channel_expired
            || matches!(
                self.last_channel_status.as_ref().map(|s| &s.state),
                Some(
                    ChannelStatus::ResolvedClean
                        | ChannelStatus::ResolvedUnrolled
                        | ChannelStatus::ResolvedStale
                        | ChannelStatus::Failed,
                )
            )
    }

    /// True when the session is fully resolved: channel status is terminal and
    /// no on-chain games are still being played out. A terminal channel
    /// snapshot does not supersede a pending cooperative handoff: the peer
    /// still needs the persisted close command before this local session may
    /// drain.
    pub fn is_fully_resolved(&self) -> bool {
        matches!(
            self.state.session_disposition,
            Some(SessionDisposition::Abandoned)
        ) || (self.state.session_disposition.is_none()
            && self.channel_status_terminal()
            && !self.peer.has_active_on_chain_games())
    }

    pub fn provide_launcher_coin(
        &mut self,
        allocator: &mut AllocEncoder,
        launcher_coin: CoinString,
    ) -> Result<(), Error> {
        let effects = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            self.peer.provide_launcher_coin(&mut env, launcher_coin)?
        };
        self.process_effects(effects, allocator)?;
        Ok(())
    }

    pub fn provide_coin_spend_bundle(
        &mut self,
        allocator: &mut AllocEncoder,
        bundle: SpendBundle,
    ) -> Result<(), Error> {
        let bundle = claim_settlement_coins(allocator, bundle);
        let effects = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            self.peer.provide_coin_spend_bundle(&mut env, bundle)?
        };
        self.process_effects(effects, allocator)?;
        Ok(())
    }

    pub fn wallet_callback_failed(
        &mut self,
        _allocator: &mut AllocEncoder,
        reason: String,
    ) -> Result<(), Error> {
        self.peer.wallet_callback_failed(reason);
        self.detect_phase_transition();
        Ok(())
    }

    /// Stop participating in this session immediately. This is a local user
    /// choice, not a protocol transition or a claim about on-chain resolution.
    pub fn abandon(&mut self) -> Result<(), Error> {
        if matches!(
            self.state.session_disposition,
            Some(SessionDisposition::AwaitOutboundTerminal)
        ) {
            return Err(Error::StrErr(
                "cannot abandon while cooperative terminal handoff is pending".to_string(),
            ));
        }
        self.mark_abandoned();
        Ok(())
    }

    fn mark_abandoned(&mut self) {
        self.state.session_disposition = Some(SessionDisposition::Abandoned);
        self.state.pending_outbound_terminal = None;
        self.state.peer_disconnected = true;
        self.state.inbound_messages.clear();
        // Abandonment replaces the session's pending presentation with one
        // terminal snapshot. Older notifications must not race the final
        // Abandoned status through an asynchronous host.
        self.state.events.clear();
        self.emit_channel_status_if_changed();
    }

    /// Finalize the local half of a zero-payout clean shutdown after the host
    /// has made the complete close spend available to the peer.
    pub fn complete_outbound_terminal_handoff(&mut self) -> Result<(), Error> {
        if !matches!(
            self.state.session_disposition,
            Some(SessionDisposition::AwaitOutboundTerminal)
        ) {
            return Err(Error::StrErr(
                "no cooperative terminal handoff is pending".to_string(),
            ));
        }
        self.mark_abandoned();
        Ok(())
    }

    /// Settle deferred channel-setup work and retry any re-queued messages,
    /// flush potato-gated pending actions, and collect all accumulated events.
    /// Call this after any operation that may have changed state (delivering a
    /// message, processing a block, making a move, etc.).
    pub fn flush_and_collect(
        &mut self,
        allocator: &mut AllocEncoder,
    ) -> Result<DrainResult, Error> {
        if self.state.session_disposition.is_some() {
            return Ok(DrainResult {
                events: std::mem::take(&mut self.state.events),
            });
        }
        while let Some(msg) = self.state.inbound_messages.pop_front() {
            let recv_result = {
                let mut env = ChannelEnv::new_with_genesis(
                    allocator,
                    &self.state.agg_sig_me_additional_data,
                )?;
                self.peer.received_message(&mut env, msg)
            };
            match recv_result {
                Ok(effects) => self.process_effects(effects, allocator)?,
                Err(e) => {
                    self.handle_peer_protocol_error(allocator, e)?;
                    break;
                }
            }
            if self.state.session_disposition.is_some() {
                self.state.inbound_messages.clear();
                break;
            }
        }

        let res = if self.state.session_disposition.is_some() {
            None
        } else {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            Some(self.peer.flush_pending_actions(&mut env))
        };
        match res {
            Some(Ok(effects)) => self.process_effects(effects, allocator)?,
            Some(Err(e)) => {
                let action_context = self.peer.take_failed_queued_action();
                self.state.events.push_back(GameSessionEvent::Notification(
                    GameNotification::ActionFailed {
                        id: action_context.as_ref().map(|(id, _)| *id),
                        action: action_context.map(|(_, action)| action),
                        reason: format!("{e:?}"),
                    },
                ));
            }
            None => {}
        }

        Ok(DrainResult {
            events: std::mem::take(&mut self.state.events),
        })
    }

    fn detect_phase_transition(&mut self) {
        if let Some(next) = self.peer.take_next_phase() {
            self.peer = next;
        }
        self.state.is_on_chain = self.peer.is_on_chain();
        self.state.is_failed = self
            .peer
            .channel_status_snapshot()
            .is_some_and(|s| s.state == ChannelStatus::Failed);

        self.emit_channel_status_if_changed();
    }

    fn should_emit_status(
        old: &Option<ChannelStatusSnapshot>,
        new: &Option<ChannelStatusSnapshot>,
    ) -> bool {
        if new == old {
            return false;
        }
        let new_state = new.as_ref().map(|s| &s.state);
        let old_state = old.as_ref().map(|s| &s.state);
        if new_state != old_state {
            return true;
        }
        if new
            .as_ref()
            .and_then(|snapshot| snapshot.session_disposition.as_ref())
            != old
                .as_ref()
                .and_then(|snapshot| snapshot.session_disposition.as_ref())
        {
            return true;
        }
        if new.as_ref().and_then(|snapshot| snapshot.unroll_initiator)
            != old.as_ref().and_then(|snapshot| snapshot.unroll_initiator)
            || new.as_ref().and_then(|snapshot| snapshot.semantic_phase)
                != old.as_ref().and_then(|snapshot| snapshot.semantic_phase)
        {
            return true;
        }
        // In Active state, re-emit on balance / potato / state_number changes.
        // In other states, suppress same-state re-emissions (e.g. coin
        // changes within Unrolling).
        new_state == Some(&ChannelStatus::Active)
    }

    fn make_channel_status_notification(snap: &ChannelStatusSnapshot) -> GameNotification {
        GameNotification::ChannelStatus(snap.clone())
    }

    fn emit_channel_status_if_changed(&mut self) {
        if self.state.channel_expired {
            return;
        }
        let session_disposition = self.state.session_disposition.clone();
        let snapshot = if let Some(session_disposition) = session_disposition {
            let mut snapshot = self
                .peer
                .channel_status_snapshot()
                .or_else(|| self.last_channel_status.clone())
                .unwrap_or_else(|| ChannelStatusSnapshot::new(ChannelStatus::Handshaking));
            snapshot.session_disposition = Some(session_disposition);
            Some(snapshot)
        } else {
            self.peer.channel_status_snapshot()
        };
        if Self::should_emit_status(&self.last_channel_status, &snapshot) {
            if let Some(ref snap) = snapshot {
                match snap.state {
                    ChannelStatus::ShuttingDown | ChannelStatus::ShutdownTransactionPending => {
                        self.state.clean_shutdown_received = true;
                    }
                    ChannelStatus::ResolvedClean => {
                        self.state.clean_shutdown = snap.coin.clone();
                    }
                    ChannelStatus::ResolvedUnrolled | ChannelStatus::ResolvedStale
                        if self.state.is_on_chain =>
                    {
                        self.state.peer_disconnected = true;
                    }
                    ChannelStatus::ResolvedUnrolled | ChannelStatus::ResolvedStale => {}
                    ChannelStatus::GoingOnChain | ChannelStatus::Unrolling => {
                        self.state.peer_disconnected = true;
                    }
                    _ => {}
                }
                self.state.events.push_back(GameSessionEvent::Notification(
                    Self::make_channel_status_notification(snap),
                ));
            }
            self.last_channel_status = snapshot;
        }
    }

    pub(crate) fn timeout_claim_submitted(
        &mut self,
        semantic: TimeoutClaimSemantic,
    ) -> Result<(), Error> {
        if let Some(notification) = self.peer.timeout_claim_submitted(semantic)? {
            self.state
                .events
                .push_back(GameSessionEvent::Notification(notification));
        }
        self.emit_channel_status_if_changed();
        Ok(())
    }

    pub(crate) fn timeout_claim_rearmed(
        &mut self,
        semantic: TimeoutClaimSemantic,
    ) -> Result<(), Error> {
        if let Some(notification) = self.peer.timeout_claim_rearmed(semantic)? {
            self.state
                .events
                .push_back(GameSessionEvent::Notification(notification));
        }
        self.emit_channel_status_if_changed();
        Ok(())
    }

    fn check_channel_creation_expiry(&mut self, height: u64, observations: &[CoinObservation]) {
        if self.state.channel_expired || self.state.channel_established {
            return;
        }
        if let Ok(channel) = self.peer.channel_state() {
            if observations.iter().any(
                |observation| matches!(observation, CoinObservation::Created(coin) if coin == channel.channel_coin()),
            ) {
                self.state.channel_established = true;
                return;
            }
        }
        let Some(expiry) = self.state.channel_creation_expiry else {
            return;
        };
        if height < expiry {
            return;
        }
        self.state.channel_expired = true;
        self.state.is_failed = true;
        let snapshot = ChannelStatusSnapshot {
            advisory: Some("channel coin not confirmed in time".to_string()),
            ..ChannelStatusSnapshot::new(ChannelStatus::Failed)
        };
        self.state.events.push_back(GameSessionEvent::Notification(
            Self::make_channel_status_notification(&snapshot),
        ));
        self.last_channel_status = Some(snapshot);
    }

    pub fn push_event(&mut self, event: GameSessionEvent) {
        self.state.events.push_back(event);
    }

    fn process_effects(
        &mut self,
        effects: Vec<Effect>,
        allocator: &mut AllocEncoder,
    ) -> Result<(), Error> {
        if self.state.session_disposition.is_some() {
            return Ok(());
        }
        let complete_zero_payout_shutdown = effects
            .iter()
            .any(|effect| matches!(effect, Effect::CompleteZeroPayoutShutdown));
        let go_on_chain_after_peer_error = effects
            .iter()
            .any(|effect| matches!(effect, Effect::GoOnChainAfterPeerError));
        let mut passthrough = Vec::new();
        for effect in effects {
            if let Effect::QueueTerminalHandoff(coin_spend) = effect {
                let message = bencodex::to_vec(&PeerMessage::CleanShutdownComplete(coin_spend))
                    .map_err(|e| Error::StrErr(format!("{e:?}")))?;
                assert!(
                    self.state.pending_outbound_terminal.is_none(),
                    "only one terminal outbound handoff may be pending"
                );
                let command = TerminalHandoffCommand {
                    id: self.state.next_terminal_handoff_id,
                    message,
                };
                self.state.next_terminal_handoff_id += 1;
                self.state.pending_outbound_terminal = Some(command);
                self.state.session_disposition = Some(SessionDisposition::AwaitOutboundTerminal);
            } else if matches!(effect, Effect::NeedLauncherCoinId) {
                self.state
                    .events
                    .push_back(GameSessionEvent::NeedLauncherCoin);
            } else if let Effect::NeedCoinSpend(req) = effect {
                self.state
                    .events
                    .push_back(GameSessionEvent::NeedCoinSpend(req));
            } else if matches!(effect, Effect::GoOnChainAfterPeerError) {
                // `go_on_chain` below owns this transition so the exhausted
                // side can abandon instead of constructing an unroll spend.
            } else {
                passthrough.push(effect);
            }
        }
        apply_effects(passthrough, allocator, &mut self.state)?;
        self.detect_phase_transition();
        if complete_zero_payout_shutdown {
            self.mark_abandoned();
            return Ok(());
        }
        if go_on_chain_after_peer_error {
            self.go_on_chain(allocator, true)?;
            return Ok(());
        }

        if self.state.peer_disconnected && self.peer.handshake_finished() && !self.state.is_on_chain
        {
            self.go_on_chain(allocator, true)?;
            return Ok(());
        }

        if self.peer.channel_state().is_ok() {
            if let Some(ph) = self.state.channel_puzzle_hash.take() {
                if !self.create_partial_spend_for_channel_coin(allocator, ph.clone())? {
                    self.state.channel_puzzle_hash = Some(ph);
                }
            }
            if let (false, Some(uo)) = (self.state.is_initiator, self.state.unfunded_offer.take()) {
                if !self.respond_to_unfunded_offer(allocator, uo.clone())? {
                    self.state.unfunded_offer = Some(uo);
                }
            }
        }

        if self.peer.handshake_finished() {
            while self.peer.has_queued_message() {
                let recv_result = {
                    let mut env = ChannelEnv::new_with_genesis(
                        allocator,
                        &self.state.agg_sig_me_additional_data,
                    )?;
                    self.peer.process_queued_message(&mut env)
                };
                match recv_result {
                    Ok(inner_effects) => {
                        if inner_effects.is_empty() {
                            break;
                        }
                        self.process_effects(inner_effects, allocator)?;
                        self.detect_phase_transition();
                    }
                    Err(e) => {
                        self.handle_peer_protocol_error(allocator, e)?;
                        break;
                    }
                }
            }
            while self.peer.has_queued_action() {
                let action_result = {
                    let mut env = ChannelEnv::new_with_genesis(
                        allocator,
                        &self.state.agg_sig_me_additional_data,
                    )?;
                    self.peer.process_queued_action(&mut env)
                };
                match action_result {
                    Ok(inner_effects) => {
                        if inner_effects.is_empty() {
                            break;
                        }
                        self.process_effects(inner_effects, allocator)?;
                        self.detect_phase_transition();
                    }
                    Err(e) => {
                        self.handle_peer_protocol_error(allocator, e)?;
                        break;
                    }
                }
            }
        }

        Ok(())
    }

    fn handle_peer_protocol_error(
        &mut self,
        allocator: &mut AllocEncoder,
        error: Error,
    ) -> Result<(), Error> {
        self.state
            .events
            .push_back(GameSessionEvent::ReceiveError(format!("{error:?}")));
        self.go_on_chain(allocator, true).map(|_| ())
    }

    fn create_partial_spend_for_channel_coin(
        &mut self,
        allocator: &mut AllocEncoder,
        channel_puzzle_hash: PuzzleHash,
    ) -> Result<bool, Error> {
        // Can only create the initial spend if we have the funding coin.
        let parent = if let Some(parent) = self.state.funding_coin.clone() {
            parent
        } else {
            return Ok(false);
        };

        // Unset this state trigger.
        self.state.channel_puzzle_hash = None;

        let channel_coin_amt = {
            let ch = self.peer.channel_state()?;
            let channel_coin = ch.channel_coin();
            if let Some((ch_parent, ph, amt)) = channel_coin.to_parts() {
                game_assert_eq!(ph, channel_puzzle_hash, "channel coin puzzle hash mismatch");
                // Launcher-based handshake sets the channel parent to launcher coin id,
                // so the legacy direct-parent partial-spend path is not applicable.
                if ch_parent != parent.to_coin_id() {
                    return Ok(false);
                }
                amt
            } else {
                return Err(Error::StrErr("no channel coin".to_string()));
            }
        };

        let conditions_clvm = [(
            CREATE_COIN,
            (channel_puzzle_hash.clone(), (channel_coin_amt, ())),
        )]
        .to_clvm(allocator)
        .into_gen()?;

        let reported_effects = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            let spend = standard_solution_partial(
                env.allocator,
                &self.state.identity.synthetic_private_key,
                &parent.to_coin_id(),
                conditions_clvm,
                &self.state.identity.synthetic_public_key,
                &env.agg_sig_me_additional_data,
                false,
            )?;

            let bundle = SpendBundle {
                name: Some("create channel".to_string()),
                spends: vec![CoinSpend {
                    coin: parent.clone(),
                    bundle: Spend {
                        puzzle: self.state.identity.puzzle.clone(),
                        solution: spend.solution.clone(),
                        signature: spend.signature.clone(),
                    },
                }],
            };

            self.peer.channel_offer(&mut env, bundle)?
        };
        if let Some(effect) = reported_effects {
            self.process_effects(vec![effect], allocator)?;
        }

        Ok(true)
    }

    fn respond_to_unfunded_offer(
        &mut self,
        allocator: &mut AllocEncoder,
        unfunded_offer: SpendBundle,
    ) -> Result<bool, Error> {
        let parent_coin = if let Some(parent) = self.state.funding_coin.clone() {
            parent
        } else {
            return Ok(false);
        };

        self.state.unfunded_offer = None;

        let reported_effects = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            let empty_conditions = ().to_clvm(env.allocator).into_gen()?;
            let quoted_empty_conditions = empty_conditions.to_quoted_program(env.allocator)?;
            let solution = solution_for_conditions(env.allocator, empty_conditions)?;
            let quoted_empty_hash = quoted_empty_conditions.sha256tree(env.allocator);

            let mut spends = unfunded_offer.clone();
            game_assert!(
                !spends.spends.is_empty(),
                "respond_to_unfunded_offer: empty spend bundle"
            );
            let signature = sign_agg_sig_me(
                &self.state.identity.synthetic_private_key,
                quoted_empty_hash.bytes(),
                &parent_coin.to_coin_id(),
                &env.agg_sig_me_additional_data,
            );
            spends.spends.push(CoinSpend {
                coin: parent_coin.clone(),
                bundle: Spend {
                    puzzle: self.state.identity.puzzle.clone(),
                    solution: Program::from_nodeptr(env.allocator, solution)?.into(),
                    signature,
                },
            });
            game_assert_eq!(
                spends.spends.len(),
                2,
                "respond_to_unfunded_offer: expected 2 spends"
            );

            self.state
                .events
                .push_back(GameSessionEvent::OutboundTransaction(spends, None));

            self.peer
                .channel_transaction_completion(&mut env, &unfunded_offer)?
        };
        if let Some(effect) = reported_effects {
            self.process_effects(vec![effect], allocator)?;
        }

        Ok(true)
    }
}

impl GameSession {
    #[cfg(test)]
    pub fn flush_pending(&mut self, allocator: &mut AllocEncoder) -> Result<(), Error> {
        let effects = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            self.peer.flush_pending_actions(&mut env)?
        };
        self.process_effects(effects, allocator)?;
        Ok(())
    }

    pub fn replace_last_message<F>(&mut self, f: F) -> Result<(), Error>
    where
        F: FnOnce(&PeerMessage) -> Result<PeerMessage, Error>,
    {
        let idx = self
            .state
            .events
            .iter()
            .rposition(|e| matches!(e, GameSessionEvent::OutboundMessage(_)))
            .ok_or_else(|| Error::StrErr("no message to replace".to_string()))?;
        let msg = match self.state.events.remove(idx) {
            Some(GameSessionEvent::OutboundMessage(data)) => data,
            _ => unreachable!(),
        };

        let msg_envelope: PeerMessage = bencodex::from_slice(&msg).into_gen()?;
        let fake_move = f(&msg_envelope)?;

        self.state.send_message(&fake_move)
    }

    pub fn channel_puzzle_hash(&self) -> Option<PuzzleHash> {
        self.state.channel_puzzle_hash.clone()
    }
}

impl GameSession {
    #[cfg(test)]
    pub fn self_accept_proposal(
        &mut self,
        allocator: &mut AllocEncoder,
        game_id: &GameID,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            self.peer.self_accept_proposal(&mut env, game_id)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    pub fn cheat(
        &mut self,
        allocator: &mut AllocEncoder,
        game_id: &GameID,
        mover_share: Amount,
    ) -> Result<(), Error> {
        let entropy: Hash = Hash::default();
        let reported_effects = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            self.peer
                .cheat_game(&mut env, game_id, mover_share, entropy)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    pub fn is_on_chain(&self) -> bool {
        self.state.is_on_chain
    }

    pub fn is_failed(&self) -> bool {
        self.state.is_failed
    }

    pub fn get_reward_puzzle_hash(
        &mut self,
        allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error> {
        let mut env =
            ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
        self.peer.channel_state()?.get_reward_puzzle_hash(&mut env)
    }

    pub fn set_funding_coin(
        &mut self,
        allocator: &mut AllocEncoder,
        coin: CoinString,
    ) -> Result<(), Error> {
        self.state.funding_coin = Some(coin.clone());

        let start_effect = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            self.peer.start_handshake(&mut env)?
        };
        let mut effects = Vec::new();
        effects.extend(start_effect);
        self.process_effects(effects, allocator)?;

        Ok(())
    }

    pub fn start_handshake(&mut self, allocator: &mut AllocEncoder) -> Result<(), Error> {
        let start_effect = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            self.peer.start_handshake(&mut env)?
        };
        let mut effects = Vec::new();
        effects.extend(start_effect);
        self.process_effects(effects, allocator)?;

        Ok(())
    }

    pub fn handshake_finished(&self) -> bool {
        self.peer.handshake_finished()
    }

    pub fn propose_games(
        &mut self,
        allocator: &mut AllocEncoder,
        games: &[GameProposal],
    ) -> Result<Vec<GameID>, Error> {
        let (result, reported_effects) = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            self.peer.propose_games(&mut env, games)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(result)
    }

    pub fn accept_proposal(
        &mut self,
        allocator: &mut AllocEncoder,
        game_id: &GameID,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            self.peer.accept_proposal(&mut env, game_id)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    pub fn cancel_proposal(
        &mut self,
        allocator: &mut AllocEncoder,
        game_id: &GameID,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            self.peer.cancel_proposal(&mut env, game_id)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    pub fn identity(&self) -> ChiaIdentity {
        self.state.identity.clone()
    }

    /// Signal making a move.  Forwards to FromLocalUI::make_move.
    pub fn make_move(
        &mut self,
        allocator: &mut AllocEncoder,
        id: &GameID,
        readable: ReadableMove,
        new_entropy: Hash,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            self.peer.make_move(&mut env, id, &readable, new_entropy)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    pub fn accept_proposal_and_move(
        &mut self,
        allocator: &mut AllocEncoder,
        id: &GameID,
        readable: ReadableMove,
        new_entropy: Hash,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            let mut effects = self.peer.accept_proposal(&mut env, id)?;
            effects.extend(self.peer.make_move(&mut env, id, &readable, new_entropy)?);
            effects
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    /// Signal accepting a game outcome.  Forwards to FromLocalUI::accept_settlement.
    pub fn accept_settlement(
        &mut self,
        allocator: &mut AllocEncoder,
        id: &GameID,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            self.peer.accept_settlement(&mut env, id)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    /// Signal shutdown.  Forwards to FromLocalUI::shut_down.
    pub fn shut_down(&mut self, allocator: &mut AllocEncoder) -> Result<(), Error> {
        let reported_effects = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            self.peer.shut_down(&mut env)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    /// Tell the game cradle that a new block arrived with ordered watch facts.
    pub fn new_block(
        &mut self,
        allocator: &mut AllocEncoder,
        height: u64,
        observations: &[CoinObservation],
    ) -> Result<(), Error> {
        if self.state.session_disposition.is_some() {
            return Ok(());
        }
        self.state.current_height = height;
        for observation in observations {
            let effects = {
                let mut env = ChannelEnv::new_with_genesis(
                    allocator,
                    &self.state.agg_sig_me_additional_data,
                )?;
                match observation {
                    CoinObservation::Created(coin) => {
                        self.peer.coin_created(&mut env, coin)?.unwrap_or_default()
                    }
                    CoinObservation::Spent(coin) => self.peer.coin_spent(&mut env, coin)?,
                }
            };
            self.process_effects(effects, allocator)?;
        }
        let height_effects = self.peer.new_block(self.state.current_height)?;
        self.process_effects(height_effects, allocator)?;
        self.check_channel_creation_expiry(height, observations);
        Ok(())
    }

    /// Advance handler clocks from a confirmed peak height without accepting a
    /// watched-coin snapshot. Used when polling is skipped or partial: the
    /// handshake needs the height to request its funding spend, but an empty
    /// report must never be mistaken for proof that the channel coin failed to
    /// appear before its deadline.
    pub fn new_block_height_only(
        &mut self,
        allocator: &mut AllocEncoder,
        height: u64,
    ) -> Result<(), Error> {
        if self.state.session_disposition.is_some() {
            return Ok(());
        }
        self.state.current_height = height;
        let height_effects = self.peer.new_block(height)?;
        self.process_effects(height_effects, allocator)
    }

    /// Queue a message from the peer for processing by `flush_and_collect`.
    pub fn deliver_message(&mut self, inbound_message: &[u8]) -> Result<(), Error> {
        if self.state.peer_disconnected || self.state.session_disposition.is_some() {
            return Ok(());
        }
        const MAX_MESSAGE_SIZE: usize = 10 * 1024 * 1024;
        if inbound_message.len() > MAX_MESSAGE_SIZE {
            return Err(Error::StrErr(format!(
                "Inbound message size {} exceeds maximum {}",
                inbound_message.len(),
                MAX_MESSAGE_SIZE,
            )));
        }
        self.state
            .inbound_messages
            .push_back(inbound_message.to_vec());
        Ok(())
    }

    /// True if an ordinary go-on-chain request should instead stop this local
    /// session because no channel payout or active game remains for us.
    pub fn should_abandon_on_go_on_chain(&self) -> bool {
        self.peer
            .channel_state()
            .ok()
            .is_some_and(|ch| ch.has_zero_payout())
    }

    /// Trigger going on chain.
    pub fn go_on_chain(
        &mut self,
        allocator: &mut AllocEncoder,
        got_error: bool,
    ) -> Result<(), Error> {
        if matches!(
            self.state.session_disposition,
            Some(SessionDisposition::AwaitOutboundTerminal)
        ) {
            return Ok(());
        }
        if self.state.session_disposition.is_some() {
            return Ok(());
        }
        if self.should_abandon_on_go_on_chain() {
            self.mark_abandoned();
            return Ok(());
        }
        self.state.peer_disconnected = true;
        let reported_effects = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            self.peer.go_on_chain(&mut env, got_error)?
        };
        if !reported_effects.is_empty() {
            self.process_effects(reported_effects, allocator)?;
        } else {
            // A phase may update its status (notably handshake failure) without
            // emitting effects. Synchronize that state without re-entering the
            // effect pipeline and its peer-disconnect escalation.
            self.detect_phase_transition();
        }
        Ok(())
    }

    pub fn report_puzzle_and_solution(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(), Error> {
        if self.state.session_disposition.is_some() {
            return Ok(());
        }
        let reported_effects = {
            let mut env =
                ChannelEnv::new_with_genesis(allocator, &self.state.agg_sig_me_additional_data)?;
            self.peer
                .coin_puzzle_and_solution(&mut env, coin_id, puzzle_and_solution)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }
}

#[cfg(test)]
impl GameSession {
    /// Get the on-chain game coin for a game (test harness only).
    pub fn get_game_coin(&self, game_id: &GameID) -> Option<CoinString> {
        self.peer.get_game_coin(game_id)
    }
}

#[cfg(test)]
mod sequencing_tests {
    use super::*;
    use crate::common::types::CoinID;
    use std::cell::RefCell;
    use std::rc::Rc;

    fn unrolling_snapshot(
        initiator: Option<crate::session_phases::effects::UnrollInitiator>,
        phase: Option<crate::session_phases::effects::ChannelSemanticPhase>,
    ) -> Option<ChannelStatusSnapshot> {
        Some(ChannelStatusSnapshot {
            unroll_initiator: initiator,
            semantic_phase: phase,
            ..ChannelStatusSnapshot::new(ChannelStatus::Unrolling)
        })
    }

    #[test]
    fn unrolling_progress_changes_emit_channel_status() {
        use crate::session_phases::effects::{ChannelSemanticPhase, UnrollInitiator};

        assert!(GameSession::should_emit_status(
            &unrolling_snapshot(None, Some(ChannelSemanticPhase::FinishingWaitingTimeout),),
            &unrolling_snapshot(None, Some(ChannelSemanticPhase::FinishingSpending)),
        ));
        assert!(GameSession::should_emit_status(
            &unrolling_snapshot(None, Some(ChannelSemanticPhase::FinishingWaitingTimeout),),
            &unrolling_snapshot(
                Some(UnrollInitiator::Opponent),
                Some(ChannelSemanticPhase::FinishingWaitingTimeout),
            ),
        ));
    }

    #[derive(Default)]
    struct Recorder {
        created: Vec<CoinString>,
        spent: Vec<CoinString>,
    }

    /// Stand-in for the handler a handshake transitions into (e.g. OffChainPhase):
    /// records the coin events it receives.
    struct PostTransitionHandler {
        rec: Rc<RefCell<Recorder>>,
    }

    impl SpendWalletReceiver for PostTransitionHandler {
        fn coin_created(
            &mut self,
            _env: &mut ChannelEnv<'_>,
            coin: &CoinString,
        ) -> Result<Option<Vec<Effect>>, Error> {
            self.rec.borrow_mut().created.push(coin.clone());
            Ok(None)
        }
        fn coin_spent(
            &mut self,
            _env: &mut ChannelEnv<'_>,
            coin: &CoinString,
        ) -> Result<Vec<Effect>, Error> {
            self.rec.borrow_mut().spent.push(coin.clone());
            Ok(vec![])
        }
        fn coin_puzzle_and_solution(
            &mut self,
            _env: &mut ChannelEnv<'_>,
            _coin: &CoinString,
            _puzzle_and_solution: Option<(&Program, &Program)>,
        ) -> Result<Vec<Effect>, Error> {
            Ok(vec![])
        }
    }

    /// Stand-in for a handshake handler: `coin_created` builds a replacement
    /// handler (mirroring `try_transition_to_potato`), while `coin_spent` is a
    /// no-op log -- it records into its own `Recorder` only so the test can
    /// prove the pre-transition handler never handles the spend.
    struct HandshakeLikeHandler {
        own: Rc<RefCell<Recorder>>,
        replacement_rec: Rc<RefCell<Recorder>>,
        replacement: Option<PostTransitionHandler>,
    }

    impl HandshakeLikeHandler {
        fn take_next_phase(&mut self) -> Option<PostTransitionHandler> {
            self.replacement.take()
        }
    }

    impl SpendWalletReceiver for HandshakeLikeHandler {
        fn coin_created(
            &mut self,
            _env: &mut ChannelEnv<'_>,
            coin: &CoinString,
        ) -> Result<Option<Vec<Effect>>, Error> {
            self.own.borrow_mut().created.push(coin.clone());
            self.replacement = Some(PostTransitionHandler {
                rec: self.replacement_rec.clone(),
            });
            Ok(Some(vec![]))
        }
        fn coin_spent(
            &mut self,
            _env: &mut ChannelEnv<'_>,
            coin: &CoinString,
        ) -> Result<Vec<Effect>, Error> {
            self.own.borrow_mut().spent.push(coin.clone());
            Ok(vec![])
        }
        fn coin_puzzle_and_solution(
            &mut self,
            _env: &mut ChannelEnv<'_>,
            _coin: &CoinString,
            _puzzle_and_solution: Option<(&Program, &Program)>,
        ) -> Result<Vec<Effect>, Error> {
            Ok(vec![])
        }
    }

    /// A channel coin first observed already-spent is represented as ordered
    /// `Created` then `Spent` observations. The cradle processes the creation,
    /// applies the handler transition, then processes the spend.
    /// This guarantees the spend reaches the post-transition handler rather than
    /// the handshake handler that ignores it.  See
    /// `GameSession::new_block` for the sequencing this mirrors.
    #[test]
    fn first_seen_spent_pair_delivers_spend_to_post_transition_handler() {
        let mut allocator = AllocEncoder::new();
        let mut env = ChannelEnv::new(&mut allocator).expect("env");

        let coin = CoinString::from_parts(
            &CoinID::new(Hash::from_bytes([7; 32])),
            &PuzzleHash::from_bytes([8; 32]),
            &Amount::new(1),
        );
        let handshake_rec = Rc::new(RefCell::new(Recorder::default()));
        let replacement_rec = Rc::new(RefCell::new(Recorder::default()));
        let mut handshake = HandshakeLikeHandler {
            own: handshake_rec.clone(),
            replacement_rec: replacement_rec.clone(),
            replacement: None,
        };

        // Created phase: the handshake handler builds its replacement.
        handshake
            .coin_created(&mut env, &coin)
            .expect("created phase");
        // Transition checkpoint (what detect_phase_transition does inside
        // process_effects between the two phases).
        let mut replacement = handshake
            .take_next_phase()
            .expect("coin_created must trigger the transition");
        // Spent phase: delivered to the post-transition handler.
        replacement
            .coin_spent(&mut env, &coin)
            .expect("spent phase");

        assert!(
            handshake_rec.borrow().spent.is_empty(),
            "the pre-transition handshake handler must not receive the spend"
        );
        assert_eq!(
            replacement_rec.borrow().spent,
            vec![coin.clone()],
            "the post-transition handler must receive the spend"
        );
        assert!(
            replacement_rec.borrow().created.is_empty(),
            "coin_created went to the handshake handler, not the replacement"
        );
    }
}

#[cfg(test)]
mod genesis_challenge_tests {
    use super::*;
    use crate::common::constants::AGG_SIG_ME_ADDITIONAL_DATA;
    use crate::common::types::PrivateKey;
    use rand::{Rng, SeedableRng};
    use rand_chacha::ChaCha8Rng;

    #[test]
    fn channel_env_new_with_genesis_uses_provided_challenge() {
        let mut allocator = AllocEncoder::new();
        let testnet = Hash::from_bytes([0x11; 32]);
        let env = ChannelEnv::new_with_genesis(&mut allocator, &testnet).expect("env");
        assert_eq!(env.agg_sig_me_additional_data, testnet);

        let mut mainnet_allocator = AllocEncoder::new();
        let env_default = ChannelEnv::new(&mut mainnet_allocator).expect("env");
        assert_eq!(
            env_default.agg_sig_me_additional_data,
            Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA)
        );
    }

    #[test]
    fn game_session_persists_genesis_challenge_across_serialize() {
        let mut allocator = AllocEncoder::new();
        let mut rng = ChaCha8Rng::from_seed([1u8; 32]);
        let private_key: PrivateKey = rng.random();
        let identity = ChiaIdentity::new(&mut allocator, private_key).expect("identity");
        let testnet = Hash::from_bytes([0x11; 32]);
        let config = GameSessionConfig {
            game_types: crate::session_phases::game_collection::game_collection(&mut allocator),
            have_potato: true,
            identity,
            my_contribution: Amount::new(100),
            their_contribution: Amount::new(100),
            channel_timeout: Timeout::new(5),
            unroll_timeout: Timeout::new(15),
            reward_puzzle_hash: PuzzleHash::from_bytes([2; 32]),
            agg_sig_me_additional_data: testnet.clone(),
        };
        let private_keys: ChannelPrivateKeys = rng.random();
        let session = GameSession::new_with_keys(config, private_keys);
        assert_eq!(session.state.agg_sig_me_additional_data, testnet);

        let bytes = bencodex::to_vec(&session).expect("serialize");
        assert!(
            bytes.len() < 100_000,
            "serialized session unexpectedly contains package factories: {} bytes",
            bytes.len()
        );
        assert!(
            !bytes
                .windows(b"game_types".len())
                .any(|window| window == b"game_types"),
            "immutable package factories must not be persisted"
        );
        let restored: GameSession = bencodex::from_slice(&bytes).expect("deserialize");
        assert_eq!(restored.state.agg_sig_me_additional_data, testnet);
        assert_ne!(
            restored.state.agg_sig_me_additional_data,
            Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA)
        );
    }

    #[test]
    fn receiver_phase_explicitly_handles_start_and_rejects_game_proposals() {
        let mut allocator = AllocEncoder::new();
        let mut rng = ChaCha8Rng::from_seed([2u8; 32]);
        let identity =
            ChiaIdentity::new(&mut allocator, rng.random::<PrivateKey>()).expect("identity");
        let mut session = GameSession::new_with_keys(
            GameSessionConfig {
                game_types: BTreeMap::new(),
                have_potato: false,
                identity,
                my_contribution: Amount::new(100),
                their_contribution: Amount::new(100),
                channel_timeout: Timeout::new(5),
                unroll_timeout: Timeout::new(15),
                reward_puzzle_hash: PuzzleHash::from_bytes([2; 32]),
                agg_sig_me_additional_data: Hash::from_bytes([0x11; 32]),
            },
            rng.random(),
        );

        session
            .start_handshake(&mut allocator)
            .expect("receiver start is an intentional no-op");
        let error = session
            .propose_games(&mut allocator, &[])
            .expect_err("receiver cannot propose games during handshake");
        assert!(matches!(
            error,
            Error::StrErr(message)
                if message == "propose_games is not available in handshake receiver phase"
        ));
    }
}
