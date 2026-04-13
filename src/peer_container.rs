use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use clvm_traits::ToClvm;

use rand::Rng;

use serde::{Deserialize, Serialize};
use serde_json_any_key::*;

#[cfg(test)]
use crate::channel_handler::types::ChannelCoinSpendInfo;
use crate::channel_handler::types::{ChannelHandlerEnv, ChannelHandlerPrivateKeys, ReadableMove};
use crate::channel_handler::ChannelHandler;
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    sign_agg_sig_me, solution_for_conditions, standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{
    Aggsig, AllocEncoder, Amount, CoinCondition, CoinSpend, CoinString, Error, GameID, GameType,
    Hash, IntoErr, Program, ProgramRef, Puzzle, PuzzleHash, Sha256tree, Spend, SpendBundle,
    Timeout, ToQuotedProgram,
};
use crate::potato_handler::effects::{
    apply_effects, ChannelState, ChannelStatusSnapshot, CradleEvent, CradleEventQueue, Effect,
    GameNotification, ResyncInfo,
};
use crate::potato_handler::handshake_initiator::HandshakeInitiatorHandler;
use crate::potato_handler::handshake_receiver::HandshakeReceiverHandler;
use crate::potato_handler::start::GameStart;
use crate::potato_handler::types::{
    BootstrapTowardWallet, GameFactory, PacketSender, PeerMessage, PotatoHandlerInit,
    SpendWalletReceiver, ToLocalUI, WalletSpendInterface,
};

#[cfg(test)]
use crate::potato_handler::spend_channel_coin_handler::SpendChannelCoinHandler;
#[cfg(test)]
use crate::potato_handler::PotatoHandler;

#[typetag::serde]
pub trait PeerHandler {
    fn has_pending_incoming(&self) -> bool;
    fn process_incoming_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error>;
    fn received_message(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        msg: Vec<u8>,
    ) -> Result<Vec<Effect>, Error>;
    fn coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error>;
    fn coin_timeout_reached(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error>;
    fn coin_created(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error>;
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(Vec<Effect>, Option<ResyncInfo>), Error>;
    fn make_move(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
        readable: &ReadableMove,
        new_entropy: Hash,
    ) -> Result<Vec<Effect>, Error>;
    fn accept_timeout(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        id: &GameID,
    ) -> Result<Vec<Effect>, Error>;
    fn cheat_game(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        game_id: &GameID,
        mover_share: Amount,
        entropy: Hash,
    ) -> Result<Vec<Effect>, Error>;
    fn take_replacement(&mut self) -> Option<Box<dyn PeerHandler>>;

    fn new_block(&mut self, _height: u64) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }

    fn handshake_finished(&self) -> bool {
        true
    }
    fn channel_offer(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _bundle: SpendBundle,
    ) -> Result<Option<Effect>, Error> {
        Ok(None)
    }
    fn channel_transaction_completion(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _bundle: &SpendBundle,
    ) -> Result<Option<Effect>, Error> {
        Ok(None)
    }
    fn provide_launcher_coin(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _launcher_coin: CoinString,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "provide_launcher_coin not available in this phase".to_string(),
        ))
    }
    fn provide_coin_spend_bundle(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _bundle: SpendBundle,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "provide_coin_spend_bundle not available in this phase".to_string(),
        ))
    }
    fn propose_game(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _game: &GameStart,
    ) -> Result<(Vec<GameID>, Vec<Effect>), Error> {
        Err(Error::StrErr(
            "propose_game: not in off-chain phase".to_string(),
        ))
    }
    fn accept_proposal(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "accept_proposal: not in off-chain phase".to_string(),
        ))
    }
    fn cancel_proposal(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _game_id: &GameID,
    ) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "cancel_proposal: not in off-chain phase".to_string(),
        ))
    }
    fn shut_down(&mut self, _env: &mut ChannelHandlerEnv<'_>) -> Result<Vec<Effect>, Error> {
        Err(Error::StrErr(
            "shut_down: not in off-chain phase".to_string(),
        ))
    }
    fn go_on_chain(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
        _got_error: bool,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }
    fn flush_pending_actions(
        &mut self,
        _env: &mut ChannelHandlerEnv<'_>,
    ) -> Result<Vec<Effect>, Error> {
        Ok(vec![])
    }
    fn channel_handler(&self) -> Result<&ChannelHandler, Error> {
        Err(Error::StrErr(
            "no channel handler in this phase".to_string(),
        ))
    }

    fn channel_status_snapshot(&self) -> Option<ChannelStatusSnapshot> {
        None
    }

    fn as_any(&self) -> &dyn std::any::Any;
    fn as_any_mut(&mut self) -> &mut dyn std::any::Any;
}

impl SpendWalletReceiver for Box<dyn PeerHandler> {
    fn coin_created(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Option<Vec<Effect>>, Error> {
        (**self).coin_created(env, coin_id)
    }
    fn coin_spent(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        (**self).coin_spent(env, coin_id)
    }
    fn coin_timeout_reached(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
        coin_id: &CoinString,
    ) -> Result<Vec<Effect>, Error> {
        (**self).coin_timeout_reached(env, coin_id)
    }
    fn coin_puzzle_and_solution(
        &mut self,
        env: &mut ChannelHandlerEnv<'_>,
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
    pub timeout_blocks: Timeout,
    pub timeout_at: Option<u64>,
    pub name: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct WatchReport {
    pub created_watched: HashSet<CoinString>,
    pub deleted_watched: HashSet<CoinString>,
    pub timed_out: HashSet<CoinString>,
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
            timed_out: HashSet::default(),
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
    pub events: CradleEventQueue,
    pub resync: Option<(usize, bool)>,
}

pub trait GameCradle {
    /// Tell this cradle to use this coin for funding.
    fn opening_coin(&mut self, allocator: &mut AllocEncoder, coin: CoinString)
        -> Result<(), Error>;

    /// Start handshake without selecting a funding coin up-front.
    fn start_handshake(&mut self, allocator: &mut AllocEncoder) -> Result<(), Error>;

    /// Tell the user that handshake has finished.
    fn handshake_finished(&self) -> bool;

    /// Propose a new game. The game enters the proposed state and is
    /// communicated to the peer as metadata (no unroll/balance impact).
    fn propose_game(
        &mut self,
        allocator: &mut AllocEncoder,
        game: &GameStart,
    ) -> Result<Vec<GameID>, Error>;

    /// Explicitly accept a proposed game. Moves it from proposed to live,
    /// deducting balances and updating the unroll commitment.
    fn accept_proposal(
        &mut self,
        allocator: &mut AllocEncoder,
        game_id: &GameID,
    ) -> Result<(), Error>;

    /// Cancel a proposed game.
    fn cancel_proposal(
        &mut self,
        allocator: &mut AllocEncoder,
        game_id: &GameID,
    ) -> Result<(), Error>;

    /// Signal making a move.  Forwards to FromLocalUI::make_move.
    fn make_move(
        &mut self,
        allocator: &mut AllocEncoder,
        id: &GameID,
        readable: ReadableMove,
        new_entropy: Hash,
    ) -> Result<(), Error>;

    /// Accept a proposed game and immediately make a move in it.
    /// The peer protocol sends these as two separate batch actions.
    fn accept_proposal_and_move(
        &mut self,
        allocator: &mut AllocEncoder,
        id: &GameID,
        readable: ReadableMove,
        new_entropy: Hash,
    ) -> Result<(), Error>;

    fn identity(&self) -> ChiaIdentity;

    /// Signal accepting a game outcome.  Forwards to FromLocalUI::accept_timeout.
    fn accept_timeout(&mut self, allocator: &mut AllocEncoder, id: &GameID) -> Result<(), Error>;

    /// Signal shutdown.  Forwards to FromLocalUI::shut_down.
    fn shut_down(&mut self, allocator: &mut AllocEncoder) -> Result<(), Error>;

    /// Tell the game cradle that a new block arrived, giving a watch report.
    fn new_block(
        &mut self,
        allocator: &mut AllocEncoder,
        height: usize,
        report: &WatchReport,
    ) -> Result<(), Error>;

    /// Queue a message from the peer for processing by `flush_and_collect`.
    fn deliver_message(&mut self, inbound_message: &[u8]) -> Result<(), Error>;

    /// Cheat in a game: enable cheating on the referee (substituting fake
    /// move bytes and the given mover_share), then queue a normal move.
    /// For testing and demonstration purposes only.
    fn cheat(
        &mut self,
        allocator: &mut AllocEncoder,
        game_id: &GameID,
        mover_share: Amount,
    ) -> Result<(), Error>;

    /// Check whether we're on chain.
    fn is_on_chain(&self) -> bool;

    /// Check whether the channel has failed.
    fn is_failed(&self) -> bool;

    /// Trigger going on chain.
    fn go_on_chain(
        &mut self,
        allocator: &mut AllocEncoder,
        local_ui: &mut dyn ToLocalUI,
        got_error: bool,
    ) -> Result<(), Error>;

    /// Report a puzzle and solution for a spent coin.
    fn report_puzzle_and_solution(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(), Error>;

    /// Get the reward puzzle hash
    fn get_reward_puzzle_hash(&mut self, allocator: &mut AllocEncoder)
        -> Result<PuzzleHash, Error>;

    /// Get an id which uniquely identifies this game state.
    fn get_game_state_id(&mut self, allocator: &mut AllocEncoder) -> Result<Option<Hash>, Error>;
}

#[derive(Serialize, Deserialize)]
struct SynchronousGameCradleState {
    #[serde(skip)]
    current_height: u64,
    #[serde(with = "any_key_map")]
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
    events: CradleEventQueue,
}

impl PacketSender for SynchronousGameCradleState {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error> {
        if self.peer_disconnected {
            return Ok(());
        }
        let bson_doc = bson::to_bson(&msg).map_err(|e| Error::StrErr(format!("{e:?}")))?;
        let msg_data = bson::to_vec(&bson_doc).map_err(|e| Error::StrErr(format!("{e:?}")))?;
        self.events
            .push_back(CradleEvent::OutboundMessage(msg_data));
        Ok(())
    }
}

impl WalletSpendInterface for SynchronousGameCradleState {
    fn spend_transaction_and_add_fee(&mut self, bundle: &SpendBundle) -> Result<(), Error> {
        self.events
            .push_back(CradleEvent::OutboundTransaction(bundle.clone()));
        Ok(())
    }
    fn register_coin(
        &mut self,
        coin_id: &CoinString,
        timeout: &Timeout,
        name: Option<&'static str>,
    ) -> Result<(), Error> {
        let timeout_at = timeout.to_u64() + self.current_height;
        self.watching_coins.insert(
            coin_id.clone(),
            WatchEntry {
                timeout_at: Some(timeout_at),
                timeout_blocks: timeout.clone(),
                name: name.map(|s| s.to_string()),
            },
        );

        self.events.push_back(CradleEvent::WatchCoin {
            coin_name: coin_id.to_coin_id(),
            coin_string: coin_id.clone(),
        });

        Ok(())
    }
    fn request_puzzle_and_solution(&mut self, coin_id: &CoinString) -> Result<(), Error> {
        self.events
            .push_back(CradleEvent::CoinSolutionRequest(coin_id.clone()));
        Ok(())
    }
}

/// A game cradle that operates synchronously.  It can be composed with a game cradle that
/// operates message pipes to become asynchronous.
#[derive(Serialize, Deserialize)]
pub struct SynchronousGameCradle {
    state: SynchronousGameCradleState,
    peer: Box<dyn PeerHandler>,
    amount: Amount,
    #[serde(skip)]
    last_channel_status: Option<ChannelStatusSnapshot>,
    #[cfg(test)]
    #[serde(skip)]
    saved_unroll_snapshot: Option<ChannelCoinSpendInfo>,
}

#[derive(Debug, Clone)]
pub struct SynchronousGameCradleConfig {
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

impl SynchronousGameCradle {
    pub fn new_with_keys(
        config: SynchronousGameCradleConfig,
        private_keys: ChannelHandlerPrivateKeys,
    ) -> Self {
        SynchronousGameCradle {
            state: SynchronousGameCradleState {
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
                events: CradleEventQueue::default(),
                inbound_messages: VecDeque::default(),
            },
            peer: {
                let phi = PotatoHandlerInit {
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
                    Box::new(HandshakeInitiatorHandler::new(phi)) as Box<dyn PeerHandler>
                } else {
                    Box::new(HandshakeReceiverHandler::new(phi)) as Box<dyn PeerHandler>
                }
            },
            amount: config.my_contribution + config.their_contribution,
            last_channel_status: None,
            #[cfg(test)]
            saved_unroll_snapshot: None,
        }
    }
    pub fn new<R: Rng>(rng: &mut R, config: SynchronousGameCradleConfig) -> Self {
        let private_keys: ChannelHandlerPrivateKeys = rng.gen();
        SynchronousGameCradle::new_with_keys(config, private_keys)
    }
}

impl BootstrapTowardWallet for SynchronousGameCradleState {
    fn channel_puzzle_hash(&mut self, puzzle_hash: &PuzzleHash) -> Result<(), Error> {
        self.channel_puzzle_hash = Some(puzzle_hash.clone());
        Ok(())
    }

    fn received_channel_offer(&mut self, bundle: &SpendBundle) -> Result<(), Error> {
        self.unfunded_offer = Some(bundle.clone());
        Ok(())
    }
}

impl ToLocalUI for SynchronousGameCradleState {
    fn notification(&mut self, notification: &GameNotification) -> Result<(), Error> {
        self.events
            .push_back(CradleEvent::Notification(notification.clone()));
        Ok(())
    }

    fn debug_log(&mut self, line: &str) -> Result<(), Error> {
        self.events
            .push_back(CradleEvent::DebugLog(line.to_string()));
        Ok(())
    }
}

pub fn report_coin_changes_to_peer<P: SpendWalletReceiver>(
    env: &mut ChannelHandlerEnv<'_>,
    peer: &mut P,
    watch_report: &WatchReport,
) -> Result<Vec<Effect>, Error> {
    let mut effects = Vec::new();
    for d in watch_report.deleted_watched.iter() {
        effects.extend(peer.coin_spent(env, d)?);
    }

    for t in watch_report.timed_out.iter() {
        effects.extend(peer.coin_timeout_reached(env, t)?);
    }

    for c in watch_report.created_watched.iter() {
        effects.extend(peer.coin_created(env, c)?.into_iter().flatten());
    }

    Ok(effects)
}

impl SynchronousGameCradle {
    #[cfg(test)]
    pub fn corrupt_state_for_testing(&mut self, new_sn: usize) -> Result<(), Error> {
        let ph = self
            .peer
            .as_any_mut()
            .downcast_mut::<PotatoHandler>()
            .ok_or_else(|| {
                Error::StrErr("corrupt_state_for_testing: not a PotatoHandler".to_string())
            })?;
        ph.corrupt_state_for_testing(new_sn)
    }

    #[cfg(test)]
    pub fn force_unroll_spend(&self, allocator: &mut AllocEncoder) -> Result<SpendBundle, Error> {
        let mut env = ChannelHandlerEnv::new(allocator)?;
        if let Some(ph) = self.peer.as_any().downcast_ref::<PotatoHandler>() {
            return ph.force_unroll_spend(&mut env);
        }
        if let Some(h) = self.peer.as_any().downcast_ref::<SpendChannelCoinHandler>() {
            return h.force_unroll_spend(&mut env);
        }
        Err(Error::StrErr(
            "force_unroll_spend: not available in this phase".to_string(),
        ))
    }

    #[cfg(test)]
    pub fn save_unroll_snapshot(&mut self) {
        if let Some(ph) = self.peer.as_any().downcast_ref::<PotatoHandler>() {
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
        let mut env = ChannelHandlerEnv::new(allocator)?;
        let ph = self
            .peer
            .as_any()
            .downcast_ref::<PotatoHandler>()
            .ok_or_else(|| {
                Error::StrErr("force_stale_unroll_spend: not a PotatoHandler".to_string())
            })?;
        ph.force_stale_unroll_spend(&mut env, saved)
    }

    pub fn amount(&self) -> Amount {
        self.amount.clone()
    }

    pub fn get_our_current_share(&self) -> Option<Amount> {
        self.peer
            .channel_handler()
            .ok()
            .map(|ch| ch.get_our_current_share())
    }

    pub fn get_their_current_share(&self) -> Option<Amount> {
        self.peer
            .channel_handler()
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
                ChannelState::ResolvedClean
                    | ChannelState::ResolvedUnrolled
                    | ChannelState::ResolvedStale
                    | ChannelState::Failed,
            )
        )
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
            let mut env = ChannelHandlerEnv::new(allocator)?;
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
            let mut env = ChannelHandlerEnv::new(allocator)?;
            self.peer.provide_coin_spend_bundle(&mut env, bundle)?
        };
        self.process_effects(effects, allocator)?;
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
                let mut env = ChannelHandlerEnv::new(allocator)?;
                self.peer.received_message(&mut env, msg)
            };
            match recv_result {
                Ok(effects) => self.process_effects(effects, allocator)?,
                Err(e) => {
                    self.state
                        .events
                        .push_back(CradleEvent::ReceiveError(format!("{e:?}")));
                }
            }
        }

        let effects = {
            let mut env = ChannelHandlerEnv::new(allocator)?;
            self.peer.flush_pending_actions(&mut env)?
        };
        self.process_effects(effects, allocator)?;

        Ok(DrainResult {
            events: std::mem::take(&mut self.state.events),
            resync: self.state.resync.take(),
        })
    }

    fn detect_phase_transition(&mut self) {
        if let Some(next) = self.peer.take_replacement() {
            self.peer = next;
        }
        // Update phase metadata from current handler
        use crate::potato_handler::on_chain::OnChainGameHandler;

        self.state.is_on_chain = self
            .peer
            .as_any()
            .downcast_ref::<OnChainGameHandler>()
            .is_some();
        self.state.is_failed = self
            .peer
            .channel_status_snapshot()
            .is_some_and(|s| s.state == ChannelState::Failed);

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
        new_state == Some(&ChannelState::Active)
    }

    fn make_channel_status_notification(snap: &ChannelStatusSnapshot) -> GameNotification {
        GameNotification::ChannelStatus {
            state: snap.state.clone(),
            advisory: snap.advisory.clone(),
            coin: snap.coin.clone(),
            our_balance: snap.our_balance.clone(),
            their_balance: snap.their_balance.clone(),
            game_allocated: snap.game_allocated.clone(),
        }
    }

    fn emit_channel_status_if_changed(&mut self) {
        let snapshot = self.peer.channel_status_snapshot();
        if Self::should_emit_status(&self.last_channel_status, &snapshot) {
            if let Some(ref snap) = snapshot {
                match snap.state {
                    ChannelState::ShuttingDown | ChannelState::ShutdownTransactionPending => {
                        self.state.clean_shutdown_received = true;
                    }
                    ChannelState::ResolvedClean => {
                        self.state.clean_shutdown = snap.coin.clone();
                    }
                    ChannelState::ResolvedUnrolled | ChannelState::ResolvedStale => {
                        if self.state.is_on_chain {
                            self.state.peer_disconnected = true;
                        }
                    }
                    ChannelState::GoingOnChain | ChannelState::Unrolling => {
                        self.state.peer_disconnected = true;
                    }
                    _ => {}
                }
                self.state.events.push_back(CradleEvent::Notification(
                    Self::make_channel_status_notification(snap),
                ));
            }
            self.last_channel_status = snapshot;
        }
    }

    pub fn push_event(&mut self, event: CradleEvent) {
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
                self.state.events.push_back(CradleEvent::NeedLauncherCoin);
            } else if let Effect::NeedCoinSpend(req) = effect {
                self.state.events.push_back(CradleEvent::NeedCoinSpend(req));
            } else {
                passthrough.push(effect);
            }
        }
        apply_effects(passthrough, allocator, &mut self.state)?;
        self.detect_phase_transition();

        if self.peer.channel_handler().is_ok() {
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
            while self.peer.has_pending_incoming() {
                let recv_result = {
                    let mut env = ChannelHandlerEnv::new(allocator)?;
                    self.peer.process_incoming_message(&mut env)
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
                            .push_back(CradleEvent::ReceiveError(format!("{e:?}")));
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
            let ch = self.peer.channel_handler()?;
            let channel_coin = ch.state_channel_coin();
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
            let mut env = ChannelHandlerEnv::new(allocator)?;
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
            let mut env = ChannelHandlerEnv::new(allocator)?;
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
                .push_back(CradleEvent::OutboundTransaction(spends));

            self.peer
                .channel_transaction_completion(&mut env, &unfunded_offer)?
        };
        if let Some(effect) = reported_effects {
            self.process_effects(vec![effect], allocator)?;
        }

        Ok(true)
    }
}

impl SynchronousGameCradle {
    #[cfg(test)]
    pub fn flush_pending(&mut self, allocator: &mut AllocEncoder) -> Result<(), Error> {
        let effects = {
            let mut env = ChannelHandlerEnv::new(allocator)?;
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
            .rposition(|e| matches!(e, CradleEvent::OutboundMessage(_)))
            .ok_or_else(|| Error::StrErr("no message to replace".to_string()))?;
        let msg = match self.state.events.remove(idx) {
            Some(CradleEvent::OutboundMessage(data)) => data,
            _ => unreachable!(),
        };

        let doc = bson::Document::from_reader(&mut msg.as_slice()).into_gen()?;
        let msg_envelope: PeerMessage = bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
        let fake_move = f(&msg_envelope)?;

        self.state.send_message(&fake_move)
    }

    pub fn channel_puzzle_hash(&self) -> Option<PuzzleHash> {
        self.state.channel_puzzle_hash.clone()
    }

    fn filter_coin_report(&mut self, block: u64, watch_report: &WatchReport) -> WatchReport {
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
        for c in created_watched.iter() {
            if let Some(w) = self.state.watching_coins.get_mut(c) {
                w.timeout_at = Some(w.timeout_blocks.to_u64() + block);
            }
        }

        // Get timeouts
        let mut timed_out = HashSet::new();
        for (k, w) in self.state.watching_coins.iter_mut() {
            if let Some(t) = w.timeout_at {
                if t <= block {
                    w.timeout_at = None;
                    timed_out.insert(k.clone());
                }
            }
        }

        WatchReport {
            created_watched,
            deleted_watched,
            timed_out,
        }
    }
}

impl GameCradle for SynchronousGameCradle {
    fn cheat(
        &mut self,
        allocator: &mut AllocEncoder,
        game_id: &GameID,
        mover_share: Amount,
    ) -> Result<(), Error> {
        let entropy: Hash = Hash::default();
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator)?;
            self.peer
                .cheat_game(&mut env, game_id, mover_share, entropy)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    fn is_on_chain(&self) -> bool {
        self.state.is_on_chain
    }

    fn is_failed(&self) -> bool {
        self.state.is_failed
    }

    fn get_reward_puzzle_hash(
        &mut self,
        allocator: &mut AllocEncoder,
    ) -> Result<PuzzleHash, Error> {
        let mut env = ChannelHandlerEnv::new(allocator)?;
        self.peer
            .channel_handler()?
            .get_reward_puzzle_hash(&mut env)
    }

    fn get_game_state_id(&mut self, allocator: &mut AllocEncoder) -> Result<Option<Hash>, Error> {
        let mut env = ChannelHandlerEnv::new(allocator)?;
        match self.peer.channel_handler() {
            Ok(ch) => ch.get_game_state_id(&mut env).map(Some),
            Err(_) => Ok(None),
        }
    }

    fn opening_coin(
        &mut self,
        allocator: &mut AllocEncoder,
        coin: CoinString,
    ) -> Result<(), Error> {
        self.state.funding_coin = Some(coin.clone());

        if !self.state.is_initiator {
            return Ok(());
        }

        let start_effect = {
            let mut env = ChannelHandlerEnv::new(allocator)?;
            if let Some(hh) = self
                .peer
                .as_any_mut()
                .downcast_mut::<HandshakeInitiatorHandler>()
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

    fn start_handshake(&mut self, allocator: &mut AllocEncoder) -> Result<(), Error> {
        if !self.state.is_initiator {
            return Ok(());
        }

        let start_effect = {
            let mut env = ChannelHandlerEnv::new(allocator)?;
            if let Some(hh) = self
                .peer
                .as_any_mut()
                .downcast_mut::<HandshakeInitiatorHandler>()
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

    fn handshake_finished(&self) -> bool {
        self.peer.handshake_finished()
    }

    fn propose_game(
        &mut self,
        allocator: &mut AllocEncoder,
        game: &GameStart,
    ) -> Result<Vec<GameID>, Error> {
        let (result, reported_effects) = {
            let mut env = ChannelHandlerEnv::new(allocator)?;
            self.peer.propose_game(&mut env, game)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(result)
    }

    fn accept_proposal(
        &mut self,
        allocator: &mut AllocEncoder,
        game_id: &GameID,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator)?;
            self.peer.accept_proposal(&mut env, game_id)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    fn cancel_proposal(
        &mut self,
        allocator: &mut AllocEncoder,
        game_id: &GameID,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator)?;
            self.peer.cancel_proposal(&mut env, game_id)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    fn identity(&self) -> ChiaIdentity {
        self.state.identity.clone()
    }

    /// Signal making a move.  Forwards to FromLocalUI::make_move.
    fn make_move(
        &mut self,
        allocator: &mut AllocEncoder,
        id: &GameID,
        readable: ReadableMove,
        new_entropy: Hash,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator)?;
            self.peer.make_move(&mut env, id, &readable, new_entropy)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    fn accept_proposal_and_move(
        &mut self,
        allocator: &mut AllocEncoder,
        id: &GameID,
        readable: ReadableMove,
        new_entropy: Hash,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator)?;
            let mut effects = self.peer.accept_proposal(&mut env, id)?;
            effects.extend(self.peer.make_move(&mut env, id, &readable, new_entropy)?);
            effects
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    /// Signal accepting a game outcome.  Forwards to FromLocalUI::accept_timeout.
    fn accept_timeout(&mut self, allocator: &mut AllocEncoder, id: &GameID) -> Result<(), Error> {
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator)?;
            self.peer.accept_timeout(&mut env, id)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    /// Signal shutdown.  Forwards to FromLocalUI::shut_down.
    fn shut_down(&mut self, allocator: &mut AllocEncoder) -> Result<(), Error> {
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator)?;
            self.peer.shut_down(&mut env)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    /// Tell the game cradle that a new block arrived, giving a watch report.
    fn new_block(
        &mut self,
        allocator: &mut AllocEncoder,
        height: usize,
        report: &WatchReport,
    ) -> Result<(), Error> {
        self.state.current_height = height as u64;
        let filtered_report = self.filter_coin_report(self.state.current_height, report);
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator)?;
            report_coin_changes_to_peer(&mut env, &mut self.peer, &filtered_report)?
        };
        self.process_effects(reported_effects, allocator)?;
        let height_effects = self.peer.new_block(self.state.current_height)?;
        self.process_effects(height_effects, allocator)?;
        Ok(())
    }

    /// Queue a message from the peer for processing by `flush_and_collect`.
    fn deliver_message(&mut self, inbound_message: &[u8]) -> Result<(), Error> {
        if self.state.peer_disconnected {
            return Ok(());
        }
        self.state
            .inbound_messages
            .push_back(inbound_message.to_vec());
        Ok(())
    }

    /// Trigger going on chain.
    fn go_on_chain(
        &mut self,
        allocator: &mut AllocEncoder,
        _local_ui: &mut dyn ToLocalUI,
        got_error: bool,
    ) -> Result<(), Error> {
        self.state.peer_disconnected = true;
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator)?;
            self.peer.go_on_chain(&mut env, got_error)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    fn report_puzzle_and_solution(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(), Error> {
        let (reported_effects, resync) = {
            let mut env = ChannelHandlerEnv::new(allocator)?;
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
impl SynchronousGameCradle {
    /// Get the on-chain game coin for a game (test harness only). Downcasts to
    /// OnChainGameHandler when the cradle is in on-chain phase.
    pub fn get_game_coin(&self, game_id: &GameID) -> Option<CoinString> {
        use crate::potato_handler::on_chain::OnChainGameHandler;
        if let Some(och) = self.peer.as_any().downcast_ref::<OnChainGameHandler>() {
            return och.get_game_coin(game_id);
        }
        None
    }
}
