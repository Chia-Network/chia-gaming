use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::mem::swap;
use std::rc::Rc;

use clvm_traits::ToClvm;
use log::debug;
use rand::Rng;

use crate::channel_handler::runner::channel_handler_env;
use crate::channel_handler::types::{
    ChannelHandlerEnv, ChannelHandlerPrivateKeys, GameStartFailed, ReadableMove,
};
use crate::common::constants::CREATE_COIN;
use crate::common::standard_coin::{
    sign_agg_sig_me, solution_for_conditions, standard_solution_partial, ChiaIdentity,
};
use crate::common::types::{
    AllocEncoder, Amount, CoinSpend, CoinString, Error, GameID, Hash, IntoErr, Program, PuzzleHash,
    Sha256tree, Spend, SpendBundle, Timeout, ToQuotedProgram,
};
use crate::potato_handler::types::{
    BootstrapTowardGame, BootstrapTowardWallet, FromLocalUI, GameFactory, GameStart, GameType,
    PacketSender, PeerEnv, PeerMessage, PotatoHandlerInit, SpendWalletReceiver, ToLocalUI,
    WalletSpendInterface,
};
use crate::potato_handler::PotatoHandler;
use crate::shutdown::ShutdownConditions;

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

#[derive(Debug)]
pub struct WatchEntry {
    pub timeout_blocks: Timeout,
    pub timeout_at: Option<u64>,
    pub name: Option<&'static str>,
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
pub struct SimulatedWalletSpend {
    #[allow(dead_code)]
    watching_coins: HashMap<CoinString, WatchEntry>,

    #[allow(dead_code)]
    outbound_transactions: Vec<SpendBundle>,
    #[allow(dead_code)]
    channel_puzzle_hash: Option<PuzzleHash>,
}

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

pub struct RegisteredCoinsIterator<'a> {
    internal_iterator: std::collections::btree_map::Iter<'a, CoinString, WatchEntry>,
}

impl<'a> Iterator for RegisteredCoinsIterator<'a> {
    type Item = (&'a CoinString, &'a WatchEntry);

    fn next(&mut self) -> std::option::Option<<Self as Iterator>::Item> {
        self.internal_iterator.next()
    }
}

#[derive(Clone, Debug)]
pub struct GameStartRecord {
    pub game_ids: Vec<GameID>,
    pub failed: Option<GameStartFailed>,
}

#[derive(Default)]
pub struct IdleResult {
    pub continue_on: bool,
    pub finished: bool,
    pub shutdown_received: bool,
    pub handshake_done: bool,
    pub outbound_transactions: VecDeque<SpendBundle>,
    pub coin_solution_requests: VecDeque<CoinString>,
    pub outbound_messages: VecDeque<Vec<u8>>,
    pub opponent_move: Option<(GameID, usize, ReadableMove)>,
    pub game_started: Option<GameStartRecord>,
    pub game_finished: Option<(GameID, Amount)>,
    pub receive_error: Option<Error>,
    pub action_queue: Vec<String>,
    pub incoming_messages: Vec<String>,
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

    /// Signal game start.  Passes through to FromLocalUI::start_games.
    fn start_games<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        i_initiated: bool,
        game: &GameStart,
    ) -> Result<Vec<GameID>, Error>;

    /// Signal making a move.  Forwards to FromLocalUI::make_move.
    fn make_move<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        id: &GameID,
        readable: Vec<u8>,
        new_entropy: Hash,
    ) -> Result<(), Error>;

    /// Signal accepting a game outcome.  Forwards to FromLocalUI::accept.
    /// Perhaps we should consider reporting the rewards.
    fn accept<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        id: &GameID,
    ) -> Result<(), Error>;

    /// Signal shutdown.  Forwards to FromLocalUI::shut_down.
    /// Perhaps we should consider reporting the reward coins.
    fn shut_down<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        conditions: Rc<dyn ShutdownConditions>,
    ) -> Result<(), Error>;

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
    /// should be forwarded.  Returns false when no more work is needed.
    fn idle<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        local_ui: &mut dyn ToLocalUI,
        flags: u32,
    ) -> Result<Option<IdleResult>, Error>;

    /// Check whether we're on chain.
    fn is_on_chain(&self) -> bool;

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
}

struct SynchronousGameCradleState {
    current_height: u64,
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
    our_moves: VecDeque<(GameID, usize, Vec<u8>)>,
    opponent_moves: VecDeque<(GameID, usize, ReadableMove, Amount)>,
    raw_game_messages: VecDeque<(GameID, Vec<u8>)>,
    game_messages: VecDeque<(GameID, ReadableMove)>,
    game_started: VecDeque<GameStartRecord>,
    game_finished: VecDeque<(GameID, Amount)>,
    shutdown_received: bool,
    finished: bool,
    shutdown: Option<CoinString>,
    identity: ChiaIdentity,
}

impl PacketSender for SynchronousGameCradleState {
    fn send_message(&mut self, msg: &PeerMessage) -> Result<(), Error> {
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
        debug!("register coin {coin_id:?} as {name:?}");
        self.watching_coins.insert(
            coin_id.clone(),
            WatchEntry {
                timeout_at: Some(timeout.to_u64() + self.current_height),
                timeout_blocks: timeout.clone(),
                name,
            },
        );

        Ok(())
    }
    /// Request the puzzle and solution from a coin spend.
    fn request_puzzle_and_solution(&mut self, coin_id: &CoinString) -> Result<(), Error> {
        debug!("request puzzle and solution for {coin_id:?}");
        self.coin_solution_requests.push_back(coin_id.clone());
        Ok(())
    }
}

/// A game cradle that operates synchronously.  It can be composed with a game cradle that
/// operates message pipes to become asynchronous.
pub struct SynchronousGameCradle {
    state: SynchronousGameCradleState,
    peer: PotatoHandler,
}

pub struct SynchronousGameCradleConfig<'a> {
    pub game_types: BTreeMap<GameType, GameFactory>,
    pub have_potato: bool,
    pub identity: &'a ChiaIdentity,
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
                our_moves: VecDeque::default(),
                opponent_moves: VecDeque::default(),
                game_messages: VecDeque::default(),
                raw_game_messages: VecDeque::default(),
                game_started: VecDeque::default(),
                game_finished: VecDeque::default(),
                channel_puzzle_hash: None,
                funding_coin: None,
                unfunded_offer: None,
                shutdown: None,
                resync: None,
                shutdown_received: false,
                finished: false,
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
        debug!("received_channel_offer {:?}", self.identity.public_key);
        self.unfunded_offer = Some(bundle.clone());
        Ok(())
    }

    fn received_channel_transaction_completion(
        &mut self,
        _bundle: &SpendBundle,
    ) -> Result<(), Error> {
        todo!();
    }
}

impl ToLocalUI for SynchronousGameCradleState {
    fn resync_move(
        &mut self,
        _id: &GameID,
        state_number: usize,
        is_my_turn: bool,
    ) -> Result<(), Error> {
        self.resync = Some((state_number, is_my_turn));
        Ok(())
    }

    fn self_move(
        &mut self,
        id: &GameID,
        state_number: usize,
        readable: &[u8],
    ) -> Result<(), Error> {
        self.our_moves
            .push_back((id.clone(), state_number, readable.to_vec()));
        Ok(())
    }

    fn opponent_moved(
        &mut self,
        _allocator: &mut AllocEncoder,
        id: &GameID,
        state_number: usize,
        readable: ReadableMove,
        my_share: Amount,
    ) -> Result<(), Error> {
        self.opponent_moves
            .push_back((id.clone(), state_number, readable, my_share));
        Ok(())
    }
    fn raw_game_message(&mut self, id: &GameID, readable: &[u8]) -> Result<(), Error> {
        self.raw_game_messages
            .push_back((id.clone(), readable.to_vec()));
        Ok(())
    }
    fn game_message(
        &mut self,
        _allocator: &mut AllocEncoder,
        id: &GameID,
        readable: ReadableMove,
    ) -> Result<(), Error> {
        self.game_messages.push_back((id.clone(), readable.clone()));
        Ok(())
    }
    fn game_start(&mut self, ids: &[GameID], failed: Option<GameStartFailed>) -> Result<(), Error> {
        self.game_started.push_back(GameStartRecord {
            game_ids: ids.to_vec(),
            failed: failed.clone(),
        });
        Ok(())
    }
    fn game_finished(&mut self, id: &GameID, my_share: Amount) -> Result<(), Error> {
        self.game_finished.push_back((id.clone(), my_share));
        Ok(())
    }
    fn game_cancelled(&mut self, id: &GameID) -> Result<(), Error> {
        // XXX cancelled list
        self.game_finished
            .push_back((id.clone(), Amount::default()));
        Ok(())
    }
    fn shutdown_started(&mut self) -> Result<(), Error> {
        self.shutdown_received = true;
        Ok(())
    }
    fn shutdown_complete(&mut self, reward_coin_string: Option<&CoinString>) -> Result<(), Error> {
        debug!("cradle detected shutdown");
        self.shutdown = reward_coin_string.cloned();
        self.finished = true;
        Ok(())
    }
    fn going_on_chain(&mut self, _got_error: bool) -> Result<(), Error> {
        todo!();
    }
}

struct SynchronousGamePeerEnv<'a, R: Rng> {
    env: &'a mut ChannelHandlerEnv<'a, R>,
    system_interface: &'a mut SynchronousGameCradleState,
}

impl<'a, R: Rng> PeerEnv<'a, SynchronousGameCradleState, R> for SynchronousGamePeerEnv<'a, R> {
    fn env(
        &mut self,
    ) -> (
        &mut ChannelHandlerEnv<'a, R>,
        &mut SynchronousGameCradleState,
    ) {
        (self.env, self.system_interface)
    }
}

pub fn report_coin_changes_to_peer<'a, G, R: Rng + 'a>(
    penv: &mut dyn PeerEnv<'a, G, R>,
    peer: &mut PotatoHandler,
    watch_report: &WatchReport,
) -> Result<(), Error>
where
    G: ToLocalUI + BootstrapTowardWallet + WalletSpendInterface + PacketSender + 'a,
{
    for t in watch_report.timed_out.iter() {
        debug!("reporting coin timeout: {t:?}");
        peer.coin_timeout_reached(penv, t)?;
    }

    // Report deleted coins
    for d in watch_report.deleted_watched.iter() {
        debug!("reporting coin deletion: {d:?}");
        peer.coin_spent(penv, d)?;
    }

    // Report created coins
    for c in watch_report.created_watched.iter() {
        debug!("reporting coin creation: {c:?}");
        peer.coin_created(penv, c)?;
    }

    Ok(())
}

impl SynchronousGameCradle {
    pub fn has_potato(&self) -> bool {
        self.peer.has_potato()
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

    pub fn next_game_id(&mut self) -> Result<GameID, Error> {
        self.peer.next_game_id()
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
        let channel_coin_amt =
            if let Some((ch_parent, ph, amt)) = channel_coin.coin_string().to_parts() {
                // We can be sure we've got the right puzzle hash separately.
                assert_eq!(ph, channel_puzzle_hash);
                assert_eq!(ch_parent, parent.to_coin_id());
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

        let mut env = channel_handler_env(allocator, rng)?;
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

        let mut penv: SynchronousGamePeerEnv<R> = SynchronousGamePeerEnv {
            env: &mut env,
            system_interface: &mut self.state,
        };
        self.peer.channel_offer(&mut penv, bundle)?;

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

        let mut env = channel_handler_env(allocator, rng)?;
        let empty_conditions = ().to_clvm(env.allocator).into_gen()?;
        let quoted_empty_conditions = empty_conditions.to_quoted_program(env.allocator)?;
        let solution = solution_for_conditions(env.allocator, empty_conditions)?;
        let quoted_empty_hash = quoted_empty_conditions.sha256tree(env.allocator);

        let mut spends = unfunded_offer.clone();
        assert!(!spends.spends.is_empty());
        // Create no coins.  The target is already created in the partially funded
        // transaction.
        //
        // XXX break this code out
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
        debug!("s1 {:?}", spends.spends[0]);
        debug!("s2 {:?}", spends.spends[1]);
        assert_eq!(spends.spends.len(), 2);

        self.state.outbound_transactions.push_back(spends);

        {
            let mut penv: SynchronousGamePeerEnv<R> = SynchronousGamePeerEnv {
                env: &mut env,
                system_interface: &mut self.state,
            };
            self.peer
                .channel_transaction_completion(&mut penv, &unfunded_offer)?;
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
    fn is_on_chain(&self) -> bool {
        self.peer.is_on_chain()
    }

    fn my_move_in_game(&self, game_id: &GameID) -> Option<bool> {
        self.peer.my_move_in_game(game_id)
    }

    fn get_reward_puzzle_hash<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
    ) -> Result<PuzzleHash, Error> {
        let mut env = channel_handler_env(allocator, rng)?;
        let mut penv: SynchronousGamePeerEnv<R> = SynchronousGamePeerEnv {
            env: &mut env,
            system_interface: &mut self.state,
        };
        self.peer.get_reward_puzzle_hash(&mut penv)
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

        let mut env = channel_handler_env(allocator, rng)?;
        let mut penv: SynchronousGamePeerEnv<R> = SynchronousGamePeerEnv {
            env: &mut env,
            system_interface: &mut self.state,
        };
        self.peer.start(&mut penv, coin)?;

        Ok(())
    }

    fn handshake_finished(&self) -> bool {
        self.peer.handshake_finished()
    }

    /// Signal game start.  Passes through to FromLocalUI::start_games.
    fn start_games<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        i_initiated: bool,
        game: &GameStart,
    ) -> Result<Vec<GameID>, Error> {
        let mut env = channel_handler_env(allocator, rng)?;
        let mut penv: SynchronousGamePeerEnv<R> = SynchronousGamePeerEnv {
            env: &mut env,
            system_interface: &mut self.state,
        };
        self.peer.start_games(&mut penv, i_initiated, game)
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
        let mut env = channel_handler_env(allocator, rng)?;
        let rehydrated_move = Rc::new(Program::from_bytes(&readable));
        let readable = ReadableMove::from_program(rehydrated_move);
        let mut penv: SynchronousGamePeerEnv<R> = SynchronousGamePeerEnv {
            env: &mut env,
            system_interface: &mut self.state,
        };
        self.peer.make_move(&mut penv, id, &readable, new_entropy)
    }

    /// Signal accepting a game outcome.  Forwards to FromLocalUI::accept.
    /// Perhaps we should consider reporting the rewards.
    fn accept<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        id: &GameID,
    ) -> Result<(), Error> {
        let mut env = channel_handler_env(allocator, rng)?;
        let mut penv: SynchronousGamePeerEnv<R> = SynchronousGamePeerEnv {
            env: &mut env,
            system_interface: &mut self.state,
        };
        self.peer.accept(&mut penv, id)
    }

    /// Signal shutdown.  Forwards to FromLocalUI::shut_down.
    fn shut_down<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        conditions: Rc<dyn ShutdownConditions>,
    ) -> Result<(), Error> {
        // The conditions relate to spending the remaining money in the channel coin.
        let mut env = channel_handler_env(allocator, rng)?;
        let mut penv: SynchronousGamePeerEnv<R> = SynchronousGamePeerEnv {
            env: &mut env,
            system_interface: &mut self.state,
        };
        self.peer.shut_down(&mut penv, conditions)?;
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
        let mut env = channel_handler_env(allocator, rng)?;
        let mut penv: SynchronousGamePeerEnv<R> = SynchronousGamePeerEnv {
            env: &mut env,
            system_interface: &mut self.state,
        };
        report_coin_changes_to_peer(&mut penv, &mut self.peer, &filtered_report)?;
        Ok(())
    }

    /// Deliver a message from the peer.
    fn deliver_message(&mut self, inbound_message: &[u8]) -> Result<(), Error> {
        self.state
            .inbound_messages
            .push_back(inbound_message.to_vec());
        Ok(())
    }

    /// Allow the game to carry out tasks it needs to perform, yielding peer messages that
    /// should be forwarded.  Returns false when no more work is needed.
    fn idle<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        local_ui: &mut dyn ToLocalUI,
        flags: u32,
    ) -> Result<Option<IdleResult>, Error> {
        if self.state.shutdown.is_some() {
            return Ok(None);
        }

        let mut result = IdleResult {
            finished: self.finished(),
            shutdown_received: self.state.shutdown_received,
            ..IdleResult::default()
        };

        if (flags & 1) != 0 {
            self.peer.examine_game_action_queue(|actions| {
                actions.map(|a| format!("{a:?}")).collect::<Vec<String>>()
            });
        }
        if (flags & 2) != 0 {
            self.peer.examine_incoming_messages(|messages| {
                messages.map(|m| format!("{m:?}")).collect::<Vec<String>>()
            });
        }

        result.handshake_done = self.peer.handshake_done();

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

        if let Some((id, state_number, msg)) = self.state.our_moves.pop_front() {
            local_ui.self_move(&id, state_number, &msg)?;
            return Ok(Some(result));
        }

        if let Some((id, msg)) = self.state.game_messages.pop_front() {
            local_ui.game_message(allocator, &id, msg)?;
            return Ok(Some(result));
        }

        if let Some((id, state_number, readable, my_share)) = self.state.opponent_moves.pop_front()
        {
            local_ui.opponent_moved(allocator, &id, state_number, readable, my_share)?;
            result.continue_on = true;
            return Ok(Some(result));
        }

        if let Some(gs) = self.state.game_started.pop_front() {
            local_ui.game_start(&gs.game_ids, gs.failed.clone())?;
            result.game_started = Some(gs.clone());
            result.continue_on = true;
            return Ok(Some(result));
        }

        if let Some((id, amount)) = self.state.game_finished.pop_front() {
            local_ui.game_finished(&id, amount.clone())?;
            result.continue_on = true;
            return Ok(Some(result));
        }

        // If there's a message to deliver, deliver it and signal to continue.
        if let Some(msg) = self.state.inbound_messages.pop_front() {
            let mut env = channel_handler_env(allocator, rng)?;
            let mut penv: SynchronousGamePeerEnv<R> = SynchronousGamePeerEnv {
                env: &mut env,
                system_interface: &mut self.state,
            };
            // Try to receive a message.  If we get failure back, then a cheat was probably
            // attempted so we need to go on chain.
            match self.peer.received_message(&mut penv, msg) {
                Ok(_) => {
                    result.continue_on = true;
                    return Ok(Some(result));
                }
                Err(e) => {
                    debug!("going on chain for error {e:?}");
                    result.receive_error = Some(e);
                    // Go on chain.
                    local_ui.going_on_chain(true)?;
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
        let mut env = channel_handler_env(allocator, rng)?;
        let mut penv: SynchronousGamePeerEnv<R> = SynchronousGamePeerEnv {
            env: &mut env,
            system_interface: &mut self.state,
        };
        self.peer.go_on_chain(&mut penv, got_error)
    }

    fn report_puzzle_and_solution<R: Rng>(
        &mut self,
        allocator: &mut AllocEncoder,
        rng: &mut R,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(), Error> {
        let mut env = channel_handler_env(allocator, rng)?;
        let mut penv: SynchronousGamePeerEnv<R> = SynchronousGamePeerEnv {
            env: &mut env,
            system_interface: &mut self.state,
        };
        self.peer
            .coin_puzzle_and_solution(&mut penv, coin_id, puzzle_and_solution)
    }
}
