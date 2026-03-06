use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::mem::swap;
use std::rc::Rc;

use clvm_traits::ToClvm;

use rand::Rng;

use serde::{Deserialize, Serialize};
use serde_json_any_key::*;

#[cfg(test)]
use crate::channel_handler::types::ChannelCoinSpendInfo;
use crate::channel_handler::types::{ChannelHandlerEnv, ChannelHandlerPrivateKeys, ReadableMove};
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    sign_agg_sig_me, solution_for_conditions, standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{
    AllocEncoder, Amount, CoinSpend, CoinString, Error, GameID, GameType, Hash, IntoErr, Program,
    PuzzleHash, Sha256tree, Spend, SpendBundle, Timeout, ToQuotedProgram,
};
use crate::potato_handler::effects::{apply_effects, Effect, GameNotification};
use crate::potato_handler::start::GameStart;
use crate::potato_handler::types::{
    BootstrapTowardGame, BootstrapTowardWallet, FromLocalUI, GameFactory, PacketSender,
    PeerMessage, PotatoHandlerInit, SpendWalletReceiver, ToLocalUI, WalletSpendInterface,
};
use crate::potato_handler::PotatoHandler;

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
pub struct IdleResult {
    pub continue_on: bool,
    pub finished: bool,
    pub clean_shutdown_received: bool,
    pub handshake_done: bool,
    pub channel_created: bool,
    pub outbound_transactions: VecDeque<SpendBundle>,
    pub coin_solution_requests: VecDeque<CoinString>,
    pub outbound_messages: VecDeque<Vec<u8>>,
    pub notifications: Vec<GameNotification>,
    pub receive_error: Option<Error>,
    pub resync: Option<(usize, bool)>,
}

pub trait GameCradle {
    /// Tell this cradle to use this coin for funding.
    fn opening_coin<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        coin: CoinString,
    ) -> Result<(), Error>;

    /// Tell the user that handshake has finished.
    fn handshake_finished(&self) -> bool;

    /// Ask whether it's my turn in the indicated game.
    fn my_move_in_game(&self, game_id: &GameID) -> Option<bool>;

    /// Propose a new game. The game enters the proposed state and is
    /// communicated to the peer as metadata (no unroll/balance impact).
    fn propose_game<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        game: &GameStart,
    ) -> Result<Vec<GameID>, Error>;

    /// Explicitly accept a proposed game. Moves it from proposed to live,
    /// deducting balances and updating the unroll commitment.
    fn accept_proposal<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        game_id: &GameID,
    ) -> Result<(), Error>;

    /// Cancel a proposed game.
    fn cancel_proposal<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        game_id: &GameID,
    ) -> Result<(), Error>;

    /// Signal making a move.  Forwards to FromLocalUI::make_move.
    fn make_move<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        id: &GameID,
        readable: Vec<u8>,
        new_entropy: Hash,
    ) -> Result<(), Error>;

    /// Accept a proposed game and immediately make a move in it.
    /// The peer protocol sends these as two separate batch actions.
    fn accept_proposal_and_move<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        id: &GameID,
        readable: Vec<u8>,
        new_entropy: Hash,
    ) -> Result<(), Error>;

    fn identity(&self) -> ChiaIdentity;

    /// Signal accepting a game outcome.  Forwards to FromLocalUI::accept_timeout.
    fn accept_timeout<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        id: &GameID,
    ) -> Result<(), Error>;

    /// Signal shutdown.  Forwards to FromLocalUI::shut_down.
    fn shut_down<R: Rng>(&mut self, allocator: &mut AllocEncoder, rng: &mut R)
        -> Result<(), Error>;

    /// Tell the game cradle that a new block arrived, giving a watch report.
    fn new_block<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        height: usize,
        report: &WatchReport,
    ) -> Result<(), Error>;

    /// Deliver a message from the peer.
    fn deliver_message(&mut self, inbound_message: &[u8]) -> Result<(), Error>;

    /// Allow the game to carry out tasks it needs to perform, yielding peer messages that
    /// should be forwarded.  Returns `Ok(None)` when no more work is needed.
    fn idle<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        local_ui: &mut dyn ToLocalUI,
    ) -> Result<Option<IdleResult>, Error>;

    /// Cheat in a game: enable cheating on the referee (substituting fake
    /// move bytes and the given mover_share), then queue a normal move.
    /// For testing and demonstration purposes only.
    fn cheat<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        game_id: &GameID,
        mover_share: Amount,
    ) -> Result<(), Error>;

    /// Check whether we're on chain.
    fn is_on_chain(&self) -> bool;

    /// Check whether the channel has failed.
    fn is_failed(&self) -> bool;

    /// Trigger going on chain.
    fn go_on_chain<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        local_ui: &mut dyn ToLocalUI,
        got_error: bool,
    ) -> Result<(), Error>;

    /// Report a puzzle and solution for a spent coin.
    fn report_puzzle_and_solution<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(), Error>;

    /// Get the reward puzzle hash
    fn get_reward_puzzle_hash<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
    ) -> Result<PuzzleHash, Error>;

    /// Get an id which uniquely identifies this game state.
    fn get_game_state_id<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
    ) -> Result<Option<Hash>, Error>;

    /// Get the current on-chain coin for a game (if on-chain).
    fn get_game_coin(&self, game_id: &GameID) -> Option<CoinString>;
}

#[derive(Serialize, Deserialize)]
struct SynchronousGameCradleState {
    current_height: u64,
    #[serde(with = "any_key_map")]
    watching_coins: HashMap<CoinString, WatchEntry>,

    is_initiator: bool,
    channel_puzzle_hash: Option<PuzzleHash>,
    funding_coin: Option<CoinString>,
    unfunded_offer: Option<SpendBundle>,
    inbound_messages: VecDeque<Vec<u8>>,
    outbound_messages: VecDeque<Vec<u8>>,
    outbound_transactions: VecDeque<SpendBundle>,
    coin_solution_requests: VecDeque<CoinString>,
    resync: Option<(usize, bool)>,
    opponent_moves: VecDeque<(GameID, usize, ReadableMove, Amount)>,
    game_messages: VecDeque<(GameID, ReadableMove)>,
    #[serde(skip)]
    pending_notifications: VecDeque<GameNotification>,
    channel_created: bool,
    clean_shutdown_received: bool,
    finished: bool,
    clean_shutdown: Option<CoinString>,
    identity: ChiaIdentity,
    peer_disconnected: bool,
    went_on_chain: Option<String>,
}

impl PacketSender for SynchronousGameCradleState {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error> {
        if self.peer_disconnected {
            return Ok(());
        }
        let bson_doc = bson::to_bson(&msg).map_err(|e| Error::StrErr(format!("{e:?}")))?;
        let msg_data = bson::to_vec(&bson_doc).map_err(|e| Error::StrErr(format!("{e:?}")))?;
        self.outbound_messages.push_back(msg_data);
        Ok(())
    }
}

impl WalletSpendInterface for SynchronousGameCradleState {
    /// Enqueue an outbound transaction.
    fn spend_transaction_and_add_fee(&mut self, bundle: &SpendBundle) -> Result<(), Error> {
        self.outbound_transactions.push_back(bundle.clone());
        Ok(())
    }
    /// Coin should report its lifecycle until it gets spent, then should be
    /// de-registered.
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

        Ok(())
    }
    /// Request the puzzle and solution from a coin spend.
    fn request_puzzle_and_solution(&mut self, coin_id: &CoinString) -> Result<(), Error> {
        self.coin_solution_requests.push_back(coin_id.clone());
        Ok(())
    }
}

/// A game cradle that operates synchronously.  It can be composed with a game cradle that
/// operates message pipes to become asynchronous.
#[derive(Serialize, Deserialize)]
pub struct SynchronousGameCradle {
    state: SynchronousGameCradleState,
    peer: PotatoHandler,
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
                inbound_messages: VecDeque::default(),
                outbound_transactions: VecDeque::default(),
                outbound_messages: VecDeque::default(),
                coin_solution_requests: VecDeque::default(),
                opponent_moves: VecDeque::default(),
                game_messages: VecDeque::default(),
                pending_notifications: VecDeque::default(),
                channel_created: false,
                channel_puzzle_hash: None,
                funding_coin: None,
                unfunded_offer: None,
                clean_shutdown: None,
                resync: None,
                clean_shutdown_received: false,
                finished: false,
                peer_disconnected: false,
                went_on_chain: None,
            },
            peer: PotatoHandler::new(PotatoHandlerInit {
                have_potato: config.have_potato,
                private_keys,
                game_types: config.game_types,
                my_contribution: config.my_contribution,
                their_contribution: config.their_contribution,
                channel_timeout: config.channel_timeout,
                unroll_timeout: config.unroll_timeout,
                reward_puzzle_hash: config.reward_puzzle_hash,
            }),
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
        match notification {
            GameNotification::OpponentMoved {
                id,
                state_number,
                readable,
                mover_share,
            } => {
                self.opponent_moves.push_back((
                    *id,
                    *state_number,
                    readable.clone(),
                    mover_share.clone(),
                ));
            }
            GameNotification::GameMessage { id, readable } => {
                self.game_messages.push_back((*id, readable.clone()));
            }
            GameNotification::ChannelCreated => {
                self.channel_created = true;
            }
            GameNotification::CleanShutdownStarted => {
                self.clean_shutdown_received = true;
            }
            GameNotification::CleanShutdownComplete { reward_coin } => {
                self.clean_shutdown = reward_coin.clone();
                self.finished = true;
            }
            GameNotification::GoingOnChain { reason } => {
                self.peer_disconnected = true;
                self.went_on_chain = Some(reason.clone());
            }
            other => {
                self.pending_notifications.push_back(other.clone());
            }
        }
        Ok(())
    }
}

pub fn report_coin_changes_to_peer<R: Rng>(
    env: &mut ChannelHandlerEnv<'_, R>,
    peer: &mut PotatoHandler,
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
    pub fn has_potato(&self) -> bool {
        self.peer.has_potato()
    }

    #[cfg(test)]
    pub fn corrupt_state_for_testing(&mut self, new_sn: usize) -> Result<(), Error> {
        self.peer.corrupt_state_for_testing(new_sn)
    }

    #[cfg(test)]
    pub fn force_unroll_spend<R: Rng>(
        &self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
    ) -> Result<SpendBundle, Error> {
        let mut env = ChannelHandlerEnv::new(allocator, rng)?;
        self.peer.force_unroll_spend(&mut env)
    }

    #[cfg(test)]
    pub fn save_unroll_snapshot(&mut self) {
        self.saved_unroll_snapshot = self.peer.get_last_channel_coin_spend_info().cloned();
    }

    #[cfg(test)]
    pub fn force_stale_unroll_spend<R: Rng>(
        &self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
    ) -> Result<SpendBundle, Error> {
        let saved = self.saved_unroll_snapshot.as_ref().ok_or_else(|| {
            Error::StrErr("force_stale_unroll_spend: no snapshot saved".to_string())
        })?;
        let mut env = ChannelHandlerEnv::new(allocator, rng)?;
        self.peer.force_stale_unroll_spend(&mut env, saved)
    }

    pub fn amount(&self) -> Amount {
        self.peer.amount()
    }

    pub fn get_our_current_share(&self) -> Option<Amount> {
        self.peer.get_our_current_share()
    }

    pub fn get_their_current_share(&self) -> Option<Amount> {
        self.peer.get_their_current_share()
    }

    pub fn finished(&self) -> bool {
        self.state.finished
    }

    pub fn is_peer_disconnected(&self) -> bool {
        self.state.peer_disconnected
    }

    pub fn next_game_id(&mut self) -> Result<GameID, Error> {
        self.peer.next_game_id()
    }

    fn process_effects(
        &mut self,
        effects: Vec<Effect>,
        allocator: &mut AllocEncoder,
    ) -> Result<(), Error> {
        apply_effects(effects, allocator, &mut self.state)
    }

    fn create_partial_spend_for_channel_coin<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
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

        let ch = self.peer.channel_handler()?;
        let channel_coin = ch.state_channel_coin();
        let channel_coin_amt = if let Some((ch_parent, ph, amt)) = channel_coin.to_parts() {
            game_assert_eq!(ph, channel_puzzle_hash, "channel coin puzzle hash mismatch");
            game_assert_eq!(
                ch_parent,
                parent.to_coin_id(),
                "channel coin parent mismatch"
            );
            amt
        } else {
            return Err(Error::StrErr("no channel coin".to_string()));
        };

        let conditions_clvm = [(
            CREATE_COIN,
            (channel_puzzle_hash.clone(), (channel_coin_amt, ())),
        )]
        .to_clvm(allocator)
        .into_gen()?;

        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
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

    fn respond_to_unfunded_offer<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        unfunded_offer: SpendBundle,
    ) -> Result<bool, Error> {
        let parent_coin = if let Some(parent) = self.state.funding_coin.clone() {
            parent
        } else {
            return Ok(false);
        };

        self.state.unfunded_offer = None;

        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
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

            self.state.outbound_transactions.push_back(spends);

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
    pub fn replace_last_message<F>(&mut self, f: F) -> Result<(), Error>
    where
        F: FnOnce(&PeerMessage) -> Result<PeerMessage, Error>,
    {
        // Grab and decode the message.
        let msg = if let Some(msg) = self.state.outbound_messages.pop_back() {
            msg
        } else {
            return Err(Error::StrErr("no message to replace".to_string()));
        };

        let doc = bson::Document::from_reader(&mut msg.as_slice()).into_gen()?;
        let msg_envelope: PeerMessage = bson::from_bson(bson::Bson::Document(doc)).into_gen()?;
        let fake_move = f(&msg_envelope)?;

        self.state.send_message(&fake_move)
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
    fn cheat<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        game_id: &GameID,
        mover_share: Amount,
    ) -> Result<(), Error> {
        let entropy: Hash = rng.gen();
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
            self.peer
                .cheat_game(&mut env, game_id, mover_share, entropy)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    fn is_on_chain(&self) -> bool {
        self.peer.is_on_chain()
    }

    fn is_failed(&self) -> bool {
        self.peer.is_failed()
    }

    fn my_move_in_game(&self, game_id: &GameID) -> Option<bool> {
        self.peer.my_move_in_game(game_id)
    }

    fn get_reward_puzzle_hash<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
    ) -> Result<PuzzleHash, Error> {
        let result = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
            self.peer.get_reward_puzzle_hash(&mut env)?
        };
        Ok(result)
    }

    fn get_game_state_id<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
    ) -> Result<Option<Hash>, Error> {
        let result = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
            self.peer.get_game_state_id(&mut env)?
        };
        Ok(result)
    }

    fn get_game_coin(&self, game_id: &GameID) -> Option<CoinString> {
        self.peer.get_game_coin(game_id)
    }

    fn opening_coin<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        coin: CoinString,
    ) -> Result<(), Error> {
        self.state.funding_coin = Some(coin.clone());

        if !self.peer.is_initiator() {
            return Ok(());
        }

        let start_effect = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
            self.peer.start(&mut env, coin)?
        };
        let mut effects = Vec::new();
        effects.extend(start_effect);
        self.process_effects(effects, allocator)?;

        Ok(())
    }

    fn handshake_finished(&self) -> bool {
        self.peer.handshake_finished()
    }

    fn propose_game<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        game: &GameStart,
    ) -> Result<Vec<GameID>, Error> {
        let (result, reported_effects) = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
            self.peer.propose_game(&mut env, game)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(result)
    }

    fn accept_proposal<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        game_id: &GameID,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
            self.peer.accept_proposal(&mut env, game_id)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    fn cancel_proposal<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        game_id: &GameID,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
            self.peer.cancel_proposal(&mut env, game_id)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    fn identity(&self) -> ChiaIdentity {
        self.state.identity.clone()
    }

    /// Signal making a move.  Forwards to FromLocalUI::make_move.
    fn make_move<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        id: &GameID,
        readable: Vec<u8>,
        new_entropy: Hash,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
            let rehydrated_move = Rc::new(Program::from_bytes(&readable));
            let readable = ReadableMove::from_program(rehydrated_move);
            self.peer.make_move(&mut env, id, &readable, new_entropy)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    fn accept_proposal_and_move<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        id: &GameID,
        readable: Vec<u8>,
        new_entropy: Hash,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
            let mut effects = self.peer.accept_proposal(&mut env, id)?;
            let rehydrated_move = Rc::new(Program::from_bytes(&readable));
            let readable_move = ReadableMove::from_program(rehydrated_move);
            effects.extend(
                self.peer
                    .make_move(&mut env, id, &readable_move, new_entropy)?,
            );
            effects
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    /// Signal accepting a game outcome.  Forwards to FromLocalUI::accept_timeout.
    fn accept_timeout<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        id: &GameID,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
            self.peer.accept_timeout(&mut env, id)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    /// Signal shutdown.  Forwards to FromLocalUI::shut_down.
    fn shut_down<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
    ) -> Result<(), Error> {
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
            self.peer.shut_down(&mut env)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    /// Tell the game cradle that a new block arrived, giving a watch report.
    fn new_block<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        height: usize,
        report: &WatchReport,
    ) -> Result<(), Error> {
        self.state.current_height = height as u64;
        let filtered_report = self.filter_coin_report(self.state.current_height, report);
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
            report_coin_changes_to_peer(&mut env, &mut self.peer, &filtered_report)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    /// Deliver a message from the peer.
    fn deliver_message(&mut self, inbound_message: &[u8]) -> Result<(), Error> {
        if self.state.peer_disconnected {
            return Ok(());
        }
        self.state
            .inbound_messages
            .push_back(inbound_message.to_vec());
        Ok(())
    }

    /// Allow the game to carry out tasks it needs to perform, yielding peer messages that
    /// should be forwarded.  Returns `Ok(None)` when no more work is needed.
    fn idle<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        local_ui: &mut dyn ToLocalUI,
    ) -> Result<Option<IdleResult>, Error> {
        if self.state.clean_shutdown.is_some() {
            if !self.state.pending_notifications.is_empty() {
                let mut result = IdleResult::default();
                while let Some(notification) = self.state.pending_notifications.pop_front() {
                    local_ui.notification(&notification)?;
                    result.notifications.push(notification);
                }
                return Ok(Some(result));
            }
            return Ok(None);
        }

        let mut result = IdleResult {
            finished: self.finished(),
            clean_shutdown_received: self.state.clean_shutdown_received,
            ..IdleResult::default()
        };

        result.handshake_done = self.peer.handshake_done();
        if self.state.channel_created {
            result.channel_created = true;
            self.state.channel_created = false;
            local_ui.notification(&GameNotification::ChannelCreated)?;
        }

        swap(
            &mut result.outbound_transactions,
            &mut self.state.outbound_transactions,
        );
        self.state.outbound_transactions.clear();

        swap(
            &mut result.outbound_messages,
            &mut self.state.outbound_messages,
        );
        self.state.outbound_messages.clear();

        swap(
            &mut result.coin_solution_requests,
            &mut self.state.coin_solution_requests,
        );

        swap(&mut result.resync, &mut self.state.resync);

        self.state.coin_solution_requests.clear();

        while let Some(notification) = self.state.pending_notifications.pop_front() {
            local_ui.notification(&notification)?;
            result.notifications.push(notification);
        }

        if let Some((id, readable)) = self.state.game_messages.pop_front() {
            local_ui.notification(&GameNotification::GameMessage { id, readable })?;
            return Ok(Some(result));
        }

        if let Some((id, state_number, readable, mover_share)) =
            self.state.opponent_moves.pop_front()
        {
            local_ui.notification(&GameNotification::OpponentMoved {
                id,
                state_number,
                readable,
                mover_share,
            })?;
            result.continue_on = true;
            return Ok(Some(result));
        }

        if let Some(msg) = self.state.inbound_messages.pop_front() {
            let recv_result = {
                let mut env = ChannelHandlerEnv::new(allocator, rng)?;
                self.peer.received_message(&mut env, msg)
            };
            if let Ok(returned_effects) = recv_result.as_ref() {
                self.process_effects(returned_effects.clone(), allocator)?;
            }

            if let Some(reason) = self.state.went_on_chain.take() {
                local_ui.notification(&GameNotification::GoingOnChain { reason })?;
            }

            match recv_result {
                Ok(_) => {
                    result.continue_on = true;
                    return Ok(Some(result));
                }
                Err(e) => {
                    local_ui.notification(&GameNotification::GoingOnChain {
                        reason: format!("error receiving peer message: {e:?}"),
                    })?;
                    result.receive_error = Some(e);
                    return Ok(Some(result));
                }
            }
        }

        if let Some(ph) = self.state.channel_puzzle_hash.clone() {
            result.continue_on = self.create_partial_spend_for_channel_coin(allocator, rng, ph)?;
            return Ok(Some(result));
        }

        if let (false, Some(uo)) = (self.state.is_initiator, self.state.unfunded_offer.clone()) {
            result.continue_on = self.respond_to_unfunded_offer(allocator, rng, uo)?;
            return Ok(Some(result));
        }

        Ok(Some(result))
    }

    /// Trigger going on chain.
    fn go_on_chain<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        _local_ui: &mut dyn ToLocalUI,
        got_error: bool,
    ) -> Result<(), Error> {
        self.state.peer_disconnected = true;
        let reported_effects = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
            self.peer.go_on_chain(&mut env, got_error)?
        };
        self.process_effects(reported_effects, allocator)?;
        Ok(())
    }

    fn report_puzzle_and_solution<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(), Error> {
        let (reported_effects, resync) = {
            let mut env = ChannelHandlerEnv::new(allocator, rng)?;
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
