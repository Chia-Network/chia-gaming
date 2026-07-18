use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

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
    apply_effects, ChannelStatus, ChannelStatusSnapshot, CoinOfInterest, Effect, GameNotification,
    GameSessionEvent, GameSessionEventQueue, ResyncInfo,
};
use crate::session_phases::handshake_initiator::HandshakeInitiatorPhase;
use crate::session_phases::handshake_receiver::HandshakeReceiverPhase;
use crate::session_phases::proposal::GameProposal;
use crate::session_phases::types::{
    ChannelFundingWallet, GameFactory, OffChainPhaseInit, PacketSender, PeerMessage,
    SpendWalletReceiver, ToLocalUI, WalletSpendInterface,
};

#[cfg(test)]
use crate::session_phases::spend_channel_coin_phase::SpendChannelCoinPhase;
#[cfg(test)]
use crate::session_phases::OffChainPhase;

#[typetag::serde]
pub trait PeerLifecyclePhase {
    fn has_queued_message(&self) -> bool;
    fn process_queued_message(&mut self, env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error>;
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
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error>;
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
        _env: &mut ChannelEnv<'_>,
        _game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "self_accept_proposal: not in off-chain phase".to_string(),
        ))
    }
    fn take_next_phase(&mut self) -> Option<Box<dyn PeerLifecyclePhase>>;

    fn new_block(&mut self, _height: u64) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }

    fn handshake_finished(&self) -> bool {
        true
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
        Err(Error::StrErr(
            "provide_launcher_coin not available in this phase".to_string(),
        ))
    }
    fn provide_coin_spend_bundle(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _bundle: SpendBundle,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "provide_coin_spend_bundle not available in this phase".to_string(),
        ))
    }
    fn propose_game(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _game: &GameProposal,
    ) -> Result<(Vec<GameID>, Vec<Effect>), Error> {
        Err(Error::StrErr(
            "propose_game: not in off-chain phase".to_string(),
        ))
    }
    fn propose_games(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _games: &[GameProposal],
    ) -> Result<(Vec<GameID>, Vec<Effect>), Error> {
        Err(Error::StrErr(
            "propose_games: not in off-chain phase".to_string(),
        ))
    }
    fn accept_proposal(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "accept_proposal: not in off-chain phase".to_string(),
        ))
    }
    fn cancel_proposal(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "cancel_proposal: not in off-chain phase".to_string(),
        ))
    }
    fn shut_down(&mut self, _env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "shut_down: not in off-chain phase".to_string(),
        ))
    }
    fn go_on_chain(
        &mut self,
        _env: &mut ChannelEnv<'_>,
        _got_error: bool,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }
    fn flush_pending_actions(&mut self, _env: &mut ChannelEnv<'_>) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }
    fn channel_state(&self) -> Result<&ChannelState, Error> {
        Err(Error::StrErr(
            "no channel handler in this phase".to_string(),
        ))
    }

    fn channel_status_snapshot(&self) -> Option<ChannelStatusSnapshot> {
        None
    }

    fn wallet_callback_failed(&mut self, _reason: String) {}

    fn has_active_on_chain_games(&self) -> bool {
        false
    }

    /// Coin ids worth surfacing in the dashboard (channel/unroll/change/game/
    /// game-change), each tagged with its kind. Defaults to none, which is the
    /// correct answer during handshake before any coin exists.
    fn coins_of_interest(&self) -> Vec<(CoinOfInterest, CoinString)> {
        vec![]
    }

    fn as_any(&self) -> &dyn std::any::Any;
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any;
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
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
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

#[derive(Debug, Serialize, Deserialize)]
pub struct WatchEntry {
    /// Relative timeout age (in blocks).  The transaction manager combines this
    /// with the coin's reorg-aware birthday to decide ripeness.
    pub timeout_blocks: Timeout,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct WatchReport {
    pub created_watched: HashSet<CoinString>,
    pub deleted_watched: HashSet<CoinString>,
}

pub enum WalletBootstrapState {
    PartlySigned(Spend),
    FullySigned(Spend),
}

/// Normally the blockchain reports additions and subtractions to the coin set.
/// This allows the simulator and others to be used with the full coin set by computing the
/// watch report.
#[derive(Default)]
pub struct FullCoinSetAdapter {
    pub current_height: u64,
    pub current_coins: HashSet<CoinString>,
}

impl FullCoinSetAdapter {
    pub fn make_report_from_coin_set_update(
        &mut self,
        current_height: u64,
        current_coins: &[CoinString],
    ) -> Result<WatchReport, Error> {
        self.current_height = current_height;
        let mut current_coin_set: HashSet<CoinString> = current_coins.iter().cloned().collect();
        let created_coins: HashSet<CoinString> = current_coin_set
            .difference(&self.current_coins)
            .cloned()
            .collect();
        let deleted_coins: HashSet<CoinString> = self
            .current_coins
            .difference(&current_coin_set)
            .cloned()
            .collect();
        std::mem::swap(&mut current_coin_set, &mut self.current_coins);
        Ok(WatchReport {
            created_watched: created_coins,
            deleted_watched: deleted_coins,
        })
    }
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
    pub resync: Option<(usize, bool)>,
}

#[derive(Serialize, Deserialize)]
struct GameSessionState {
    current_height: u64,
    watching_coins: HashMap<CoinString, WatchEntry>,

    is_initiator: bool,
    channel_puzzle_hash: Option<PuzzleHash>,
    funding_coin: Option<CoinString>,
    unfunded_offer: Option<SpendBundle>,
    inbound_messages: VecDeque<Vec<u8>>,
    resync: Option<(usize, bool)>,
    clean_shutdown_received: bool,
    clean_shutdown: Option<CoinString>,
    identity: ChiaIdentity,
    peer_disconnected: bool,

    pub is_failed: bool,
    pub is_on_chain: bool,

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
        name: Option<&'static str>,
        spend: Option<SpendBundle>,
    ) -> Result<(), Error> {
        self.watching_coins.insert(
            coin_id.clone(),
            WatchEntry {
                timeout_blocks: timeout.clone(),
                name: name.map(|s| s.to_string()),
            },
        );

        self.events.push_back(GameSessionEvent::WatchCoin {
            coin_name: coin_id.to_coin_id(),
            coin_string: coin_id.clone(),
            timeout: timeout.clone(),
            spend,
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
    amount: Amount,
    last_channel_status: Option<ChannelStatusSnapshot>,
    #[cfg(test)]
    #[serde(skip)]
    saved_unroll_snapshot: Option<ChannelCoinSpendInfo>,
}

#[derive(Debug, Clone)]
pub struct GameSessionConfig {
    pub game_types: BTreeMap<GameType, GameFactory>,
    pub have_potato: bool,
    pub identity: ChiaIdentity,
    pub my_contribution: Amount,
    pub their_contribution: Amount,
    pub channel_timeout: Timeout,
    pub unroll_timeout: Timeout,
    pub reward_puzzle_hash: PuzzleHash,
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
                watching_coins: HashMap::default(),
                identity: config.identity.clone(),
                channel_puzzle_hash: None,
                funding_coin: None,
                unfunded_offer: None,
                clean_shutdown: None,
                resync: None,
                clean_shutdown_received: false,
                peer_disconnected: false,
                is_failed: false,
                is_on_chain: false,
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
            amount: config.my_contribution + config.their_contribution,
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

/// Which half of a coin report to dispatch.  A coin that is first observed
/// already-spent appears in BOTH `created_watched` and `deleted_watched` (see
/// `TransactionManager::report_coin_states`).  The two halves must be delivered
/// separately so that any handler transition triggered by `coin_created` is
/// applied before the matching `coin_spent` is delivered -- otherwise the spend
/// would still reach the pre-transition (handshake) handler, which ignores it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CoinReportPhase {
    Created,
    Spent,
}

pub fn report_coin_changes_to_peer<P: SpendWalletReceiver>(
    env: &mut ChannelEnv<'_>,
    peer: &mut P,
    watch_report: &WatchReport,
    phase: CoinReportPhase,
) -> Result<Vec<Effect>, Error> {
    let mut effects = Vec::new();
    match phase {
        CoinReportPhase::Created => {
            for c in watch_report.created_watched.iter() {
                effects.extend(peer.coin_created(env, c)?.into_iter().flatten());
            }
        }
        CoinReportPhase::Spent => {
            for d in watch_report.deleted_watched.iter() {
                effects.extend(peer.coin_spent(env, d)?);
            }
        }
    }

    Ok(effects)
}

impl GameSession {
    #[cfg(test)]
    pub fn proposal_contributions_for_testing(
        &self,
    ) -> Result<Vec<(GameID, Amount, Amount)>, Error> {
        let handler = self
            .peer
            .as_any()
            .downcast_ref::<OffChainPhase>()
            .ok_or_else(|| {
                Error::StrErr("proposal_contributions_for_testing: not a OffChainPhase".to_string())
            })?;
        let channel = handler.channel_state()?;
        Ok(channel.proposal_contributions_for_testing())
    }

    #[cfg(test)]
    pub fn allocated_balances_for_testing(&self) -> Result<(Amount, Amount), Error> {
        let handler = self
            .peer
            .as_any()
            .downcast_ref::<OffChainPhase>()
            .ok_or_else(|| {
                Error::StrErr("allocated_balances_for_testing: not a OffChainPhase".to_string())
            })?;
        let channel = handler.channel_state()?;
        Ok((
            channel.my_allocated_balance(),
            channel.their_allocated_balance(),
        ))
    }

    #[cfg(test)]
    pub fn corrupt_state_for_testing(&mut self, new_sn: usize) -> Result<(), Error> {
        let ph = self
            .peer
            .as_any_mut()
            .downcast_mut::<OffChainPhase>()
            .ok_or_else(|| {
                Error::StrErr("corrupt_state_for_testing: not a OffChainPhase".to_string())
            })?;
        ph.corrupt_state_for_testing(new_sn)
    }

    #[cfg(test)]
    pub fn force_unroll_spend(&self, allocator: &mut AllocEncoder) -> Result<SpendBundle, Error> {
        let mut env = ChannelEnv::new(allocator)?;
        if let Some(ph) = self.peer.as_any().downcast_ref::<OffChainPhase>() {
            return ph.force_unroll_spend(&mut env);
        }
        if let Some(h) = self.peer.as_any().downcast_ref::<SpendChannelCoinPhase>() {
            return h.force_unroll_spend(&mut env);
        }
        Err(Error::StrErr(
            "force_unroll_spend: not available in this phase".to_string(),
        ))
    }

    #[cfg(test)]
    pub fn save_unroll_snapshot(&mut self) {
        if let Some(ph) = self.peer.as_any().downcast_ref::<OffChainPhase>() {
            self.saved_unroll_snapshot = ph.get_last_channel_coin_spend_info().cloned();
        }
    }

    #[cfg(test)]
    pub fn force_stale_unroll_spend(
        &self,
        allocator: &mut AllocEncoder,
    ) -> Result<SpendBundle, Error> {
        let saved = self.saved_unroll_snapshot.as_ref().ok_or_else(|| {
            Error::StrErr("force_stale_unroll_spend: no snapshot saved".to_string())
        })?;
        let mut env = ChannelEnv::new(allocator)?;
        let ph = self
            .peer
            .as_any()
            .downcast_ref::<OffChainPhase>()
            .ok_or_else(|| {
                Error::StrErr("force_stale_unroll_spend: not a OffChainPhase".to_string())
            })?;
        ph.force_stale_unroll_spend(&mut env, saved)
    }

    pub fn amount(&self) -> Amount {
        self.amount.clone()
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
    /// phase handler; 0-2 entries in practice.
    pub fn coins_of_interest(&self) -> Vec<(String, String)> {
        self.peer
            .coins_of_interest()
            .into_iter()
            .map(|(kind, coin)| (kind.label().to_string(), coin.to_coin_id().to_string()))
            .collect()
    }

    pub fn get_our_current_share(&self) -> Option<Amount> {
        self.peer
            .channel_state()
            .ok()
            .map(|ch| ch.get_our_current_share())
    }

    pub fn get_their_current_share(&self) -> Option<Amount> {
        self.peer
            .channel_state()
            .ok()
            .map(|ch| ch.get_their_current_share())
    }

    pub fn is_peer_disconnected(&self) -> bool {
        self.state.peer_disconnected
    }

    /// True when the last emitted [`ChannelStatus`] is a terminal channel state (sim `should_end`).
    pub fn channel_status_terminal(&self) -> bool {
        matches!(
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
    /// no on-chain games are still being played out.
    pub fn is_fully_resolved(&self) -> bool {
        self.channel_status_terminal() && !self.peer.has_active_on_chain_games()
    }

    pub fn get_watching_coins(&self) -> Vec<CoinString> {
        self.state.watching_coins.keys().cloned().collect()
    }

    pub fn provide_launcher_coin(
        &mut self,
        allocator: &mut AllocEncoder,
        launcher_coin: CoinString,
    ) -> Result<(), Error> {
        let effects = {
            let mut env = ChannelEnv::new(allocator)?;
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
            let mut env = ChannelEnv::new(allocator)?;
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

    /// Settle deferred channel-setup work and retry any re-queued messages,
    /// flush potato-gated pending actions, and collect all accumulated events.
    /// Call this after any operation that may have changed state (delivering a
    /// message, processing a block, making a move, etc.).
    pub fn flush_and_collect(
        &mut self,
        allocator: &mut AllocEncoder,
    ) -> Result<DrainResult, Error> {
        while let Some(msg) = self.state.inbound_messages.pop_front() {
            let recv_result = {
                let mut env = ChannelEnv::new(allocator)?;
                self.peer.received_message(&mut env, msg)
            };
            match recv_result {
                Ok(effects) => self.process_effects(effects, allocator)?,
                Err(e) => {
                    self.state
                        .events
                        .push_back(GameSessionEvent::ReceiveError(format!("{e:?}")));
                    self.state.peer_disconnected = true;
                    let go_effects = {
                        let mut env = ChannelEnv::new(allocator)?;
                        self.peer.go_on_chain(&mut env, true)?
                    };
                    self.process_effects(go_effects, allocator)?;
                    break;
                }
            }
        }

        let res = {
            let mut env = ChannelEnv::new(allocator)?;
            self.peer.flush_pending_actions(&mut env)
        };
        match res {
            Ok(effects) => self.process_effects(effects, allocator)?,
            Err(e) => {
                self.state.events.push_back(GameSessionEvent::Notification(
                    GameNotification::ActionFailed {
                        reason: format!("{e:?}"),
                    },
                ));
            }
        }

        Ok(DrainResult {
            events: std::mem::take(&mut self.state.events),
            resync: self.state.resync.take(),
        })
    }

    fn detect_phase_transition(&mut self) {
        if let Some(next) = self.peer.take_next_phase() {
            self.peer = next;
        }
        // Update phase metadata from current handler
        use crate::session_phases::on_chain::OnChainPhase;

        self.state.is_on_chain = self.peer.as_any().downcast_ref::<OnChainPhase>().is_some();
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
        // In Active state, re-emit on balance changes (potato firings).
        // In other states, suppress same-state re-emissions (e.g. coin
        // changes within Unrolling).
        new_state == Some(&ChannelStatus::Active)
    }

    fn make_channel_status_notification(snap: &ChannelStatusSnapshot) -> GameNotification {
        GameNotification::ChannelStatus {
            state: snap.state.clone(),
            advisory: snap.advisory.clone(),
            coin: snap.coin.clone(),
            our_balance: snap.our_balance.clone(),
            their_balance: snap.their_balance.clone(),
            game_allocated: snap.game_allocated.clone(),
            have_potato: snap.have_potato,
        }
    }

    fn emit_channel_status_if_changed(&mut self) {
        let snapshot = self.peer.channel_status_snapshot();
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

    pub fn push_event(&mut self, event: GameSessionEvent) {
        self.state.events.push_back(event);
    }

    fn process_effects(
        &mut self,
        effects: Vec<Effect>,
        allocator: &mut AllocEncoder,
    ) -> Result<(), Error> {
        let mut passthrough = Vec::new();
        for effect in effects {
            if matches!(effect, Effect::NeedLauncherCoinId) {
                self.state
                    .events
                    .push_back(GameSessionEvent::NeedLauncherCoin);
            } else if let Effect::NeedCoinSpend(req) = effect {
                self.state
                    .events
                    .push_back(GameSessionEvent::NeedCoinSpend(req));
            } else {
                passthrough.push(effect);
            }
        }
        apply_effects(passthrough, allocator, &mut self.state)?;
        self.detect_phase_transition();

        if self.state.peer_disconnected && self.peer.handshake_finished() && !self.state.is_on_chain
        {
            let go_effects = {
                let mut env = ChannelEnv::new(allocator)?;
                self.peer.go_on_chain(&mut env, true)?
            };
            if !go_effects.is_empty() {
                return self.process_effects(go_effects, allocator);
            }
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
                    let mut env = ChannelEnv::new(allocator)?;
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
                        self.state
                            .events
                            .push_back(GameSessionEvent::ReceiveError(format!("{e:?}")));
                        self.state.peer_disconnected = true;
                        let go_effects = {
                            let mut env = ChannelEnv::new(allocator)?;
                            self.peer.go_on_chain(&mut env, true)?
                        };
                        self.process_effects(go_effects, allocator)?;
                        break;
                    }
                }
            }
            while self.peer.has_queued_action() {
                let action_result = {
                    let mut env = ChannelEnv::new(allocator)?;
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
                        self.state
                            .events
                            .push_back(GameSessionEvent::ReceiveError(format!("{e:?}")));
                        self.state.peer_disconnected = true;
                        break;
                    }
                }
            }
        }

        Ok(())
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
            let mut env = ChannelEnv::new(allocator)?;
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
            let mut env = ChannelEnv::new(allocator)?;
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
            let mut env = ChannelEnv::new(allocator)?;
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

    fn filter_coin_report(&mut self, watch_report: &WatchReport) -> WatchReport {
        // Pass on creates and deletes that are being watched.
        let deleted_watched: HashSet<CoinString> = watch_report
            .deleted_watched
            .iter()
            .filter(|c| self.state.watching_coins.contains_key(c))
            .cloned()
            .collect();
        for d in deleted_watched.iter() {
            self.state.watching_coins.remove(d);
        }
        let created_watched: HashSet<CoinString> = watch_report
            .created_watched
            .iter()
            .filter(|c| self.state.watching_coins.contains_key(c))
            .cloned()
            .collect();

        WatchReport {
            created_watched,
            deleted_watched,
        }
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
            let mut env = ChannelEnv::new(allocator)?;
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
            let mut env = ChannelEnv::new(allocator)?;
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
        let mut env = ChannelEnv::new(allocator)?;
        self.peer.channel_state()?.get_reward_puzzle_hash(&mut env)
    }

    pub fn get_game_state_id(
        &mut self,
        allocator: &mut AllocEncoder,
    ) -> Result<Option<Hash>, Error> {
        let mut env = ChannelEnv::new(allocator)?;
        match self.peer.channel_state() {
            Ok(ch) => ch.get_game_state_id(&mut env).map(Some),
            Err(_) => Ok(None),
        }
    }

    pub fn set_funding_coin(
        &mut self,
        allocator: &mut AllocEncoder,
        coin: CoinString,
    ) -> Result<(), Error> {
        self.state.funding_coin = Some(coin.clone());

        if !self.state.is_initiator {
            return Ok(());
        }

        let start_effect = {
            let mut env = ChannelEnv::new(allocator)?;
            if let Some(hh) = self
                .peer
                .as_any_mut()
                .downcast_mut::<HandshakeInitiatorPhase>()
            {
                hh.start(&mut env)?
            } else {
                None
            }
        };
        let mut effects = Vec::new();
        effects.extend(start_effect);
        self.process_effects(effects, allocator)?;

        Ok(())
    }

    pub fn start_handshake(&mut self, allocator: &mut AllocEncoder) -> Result<(), Error> {
        if !self.state.is_initiator {
            return Ok(());
        }

        let start_effect = {
            let mut env = ChannelEnv::new(allocator)?;
            if let Some(hh) = self
                .peer
                .as_any_mut()
                .downcast_mut::<HandshakeInitiatorPhase>()
            {
                hh.start(&mut env)?
            } else {
                None
            }
        };
        let mut effects = Vec::new();
        effects.extend(start_effect);
        self.process_effects(effects, allocator)?;

        Ok(())
    }

    pub fn handshake_finished(&self) -> bool {
        self.peer.handshake_finished()
    }

    pub fn propose_game(
        &mut self,
        allocator: &mut AllocEncoder,
        game: &GameProposal,
    ) -> Result<Vec<GameID>, Error> {
        self.propose_games(allocator, std::slice::from_ref(game))
    }

    pub fn propose_games(
        &mut self,
        allocator: &mut AllocEncoder,
        games: &[GameProposal],
    ) -> Result<Vec<GameID>, Error> {
        let (result, reported_effects) = {
            let mut env = ChannelEnv::new(allocator)?;
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
            let mut env = ChannelEnv::new(allocator)?;
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
            let mut env = ChannelEnv::new(allocator)?;
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
            let mut env = ChannelEnv::new(allocator)?;
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
            let mut env = ChannelEnv::new(allocator)?;
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
            let mut env = ChannelEnv::new(allocator)?;
            self.peer.accept_settlement(&mut env, id)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    /// Signal shutdown.  Forwards to FromLocalUI::shut_down.
    pub fn shut_down(&mut self, allocator: &mut AllocEncoder) -> Result<(), Error> {
        let reported_effects = {
            let mut env = ChannelEnv::new(allocator)?;
            self.peer.shut_down(&mut env)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    /// Tell the game cradle that a new block arrived, giving a watch report.
    pub fn new_block(
        &mut self,
        allocator: &mut AllocEncoder,
        height: u64,
        report: &WatchReport,
    ) -> Result<(), Error> {
        self.state.current_height = height;
        let filtered_report = self.filter_coin_report(report);
        // Process creations first and apply any resulting handler transition via
        // process_effects, THEN process spends against the (possibly now-swapped)
        // peer.  A channel coin first seen already-spent arrives as a
        // created-then-spent pair: coin_created transitions a handshake handler
        // to OffChainPhase, and the spend must reach that new handler.
        let created_effects = {
            let mut env = ChannelEnv::new(allocator)?;
            report_coin_changes_to_peer(
                &mut env,
                &mut self.peer,
                &filtered_report,
                CoinReportPhase::Created,
            )?
        };
        self.process_effects(created_effects, allocator)?;
        let spent_effects = {
            let mut env = ChannelEnv::new(allocator)?;
            report_coin_changes_to_peer(
                &mut env,
                &mut self.peer,
                &filtered_report,
                CoinReportPhase::Spent,
            )?
        };
        self.process_effects(spent_effects, allocator)?;
        let height_effects = self.peer.new_block(self.state.current_height)?;
        self.process_effects(height_effects, allocator)?;
        Ok(())
    }

    /// Queue a message from the peer for processing by `flush_and_collect`.
    pub fn deliver_message(&mut self, inbound_message: &[u8]) -> Result<(), Error> {
        if self.state.peer_disconnected {
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

    /// Trigger going on chain.
    pub fn go_on_chain(
        &mut self,
        allocator: &mut AllocEncoder,
        _local_ui: &mut dyn ToLocalUI,
        got_error: bool,
    ) -> Result<(), Error> {
        self.state.peer_disconnected = true;
        let reported_effects = {
            let mut env = ChannelEnv::new(allocator)?;
            self.peer.go_on_chain(&mut env, got_error)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    pub fn report_puzzle_and_solution(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(), Error> {
        let (reported_effects, resync) = {
            let mut env = ChannelEnv::new(allocator)?;
            self.peer
                .coin_puzzle_and_solution(&mut env, coin_id, puzzle_and_solution)?
        };
        if let Some(info) = resync {
            self.state.resync = Some((info.state_number, info.is_my_turn));
        }
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }
}

#[cfg(test)]
impl GameSession {
    /// Get the on-chain game coin for a game (test harness only). Downcasts to
    /// OnChainPhase when the cradle is in on-chain phase.
    pub fn get_game_coin(&self, game_id: &GameID) -> Option<CoinString> {
        use crate::session_phases::on_chain::OnChainPhase;
        if let Some(och) = self.peer.as_any().downcast_ref::<OnChainPhase>() {
            return och.get_game_coin(game_id);
        }
        None
    }
}

#[cfg(test)]
mod sequencing_tests {
    use super::*;
    use crate::common::types::CoinID;
    use std::cell::RefCell;
    use std::rc::Rc;

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
        ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
            Ok((vec![], None))
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
        ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error> {
            Ok((vec![], None))
        }
    }

    /// A channel coin first observed already-spent is reported in BOTH
    /// `created_watched` and `deleted_watched`.  The cradle processes the created
    /// phase, applies the handler transition, then processes the spent phase.
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
        let mut report = WatchReport::default();
        report.created_watched.insert(coin.clone());
        report.deleted_watched.insert(coin.clone());

        let handshake_rec = Rc::new(RefCell::new(Recorder::default()));
        let replacement_rec = Rc::new(RefCell::new(Recorder::default()));
        let mut handshake = HandshakeLikeHandler {
            own: handshake_rec.clone(),
            replacement_rec: replacement_rec.clone(),
            replacement: None,
        };

        // Created phase: the handshake handler builds its replacement.
        report_coin_changes_to_peer(&mut env, &mut handshake, &report, CoinReportPhase::Created)
            .expect("created phase");
        // Transition checkpoint (what detect_phase_transition does inside
        // process_effects between the two phases).
        let mut replacement = handshake
            .take_next_phase()
            .expect("coin_created must trigger the transition");
        // Spent phase: delivered to the post-transition handler.
        report_coin_changes_to_peer(&mut env, &mut replacement, &report, CoinReportPhase::Spent)
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
