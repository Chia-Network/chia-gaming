use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};

use log::debug;

use crate::channel_handler::types::ReadableMove;
use crate::common::types::{CoinString, Error, GameID, PuzzleHash, Spend, SpendBundle, Timeout};
use crate::outside::{GameStart, ToLocalUI};

pub trait MessagePeerQueue {
    fn message_pipe(&mut self) -> &mut MessagePipe;
    fn get_channel_puzzle_hash(&self) -> Option<PuzzleHash>;
    fn set_channel_puzzle_hash(&mut self, ph: Option<PuzzleHash>);
    fn get_unfunded_offer(&self) -> Option<SpendBundle>;
}

pub struct WatchEntry {
    pub established_height: Option<Timeout>,
    pub timeout_height: Timeout,
}

#[derive(Debug, Clone)]
pub struct WatchReport {
    pub created_watched: HashSet<CoinString>,
    pub deleted_watched: HashSet<CoinString>,
    pub timed_out: HashSet<CoinString>,
}

#[derive(Default)]
pub struct MessagePipe {
    pub my_id: usize,

    // PacketSender
    pub queue: VecDeque<Vec<u8>>,
}

pub enum WalletBootstrapState {
    PartlySigned(Spend),
    FullySigned(Spend),
}

/// Normally the blockchain reports additions and subtractions to the coin set.
/// This allows the simulator and others to be used with the full coin set by computing the
/// watch report.
pub struct FullCoinSetAdapter {
    watching_coins: HashMap<CoinString, WatchEntry>,
    current_coins: HashSet<CoinString>
}

impl FullCoinSetAdapter {
    pub fn make_report_from_coin_set_update(
        &mut self,
        current_height: usize,
        current_coins: &[CoinString],
    ) -> Result<WatchReport, Error> {
        debug!(
            "update known coins {current_height}: current coins from blockchain {current_coins:?}"
        );
        let mut current_coin_set: HashSet<CoinString> = current_coins.iter().cloned().collect();
        let created_coins: HashSet<CoinString> = current_coin_set
            .difference(&self.current_coins)
            .filter(|c| {
                // Report coin if it's being watched.
                self.watching_coins.contains_key(c)
            })
            .cloned()
            .collect();
        let deleted_coins: HashSet<CoinString> = self
            .current_coins
            .difference(&current_coin_set)
            .filter(|c| self.watching_coins.contains_key(c))
            .cloned()
            .collect();
        std::mem::swap(&mut current_coin_set, &mut self.current_coins);

        for d in deleted_coins.iter() {
            self.watching_coins.remove(d);
        }

        // Bump timeout if created.
        for c in created_coins.iter() {
            if let Some(m) = self.watching_coins.get_mut(c) {
                m.established_height = None;
            }
        }

        let mut timeouts = HashSet::new();
        for (k, v) in self.watching_coins.iter_mut() {
            if v.established_height.is_none() {
                v.established_height = Some(Timeout::new(current_height as u64));
                v.timeout_height =
                    Timeout::new(v.timeout_height.to_u64() + (current_height as u64));
            }

            if Timeout::new(current_height as u64) > v.timeout_height {
                // No action on this coin in the timeout.
                timeouts.insert(k.clone());
            }
        }

        for t in timeouts.iter() {
            self.watching_coins.remove(&t);
        }

        Ok(WatchReport {
            created_watched: created_coins,
            deleted_watched: deleted_coins,
            timed_out: timeouts,
        })
    }
}

// potato handler tests with simulator.
#[derive(Default)]
pub struct SimulatedWalletSpend {
    watching_coins: HashMap<CoinString, WatchEntry>,
    current_coins: HashSet<CoinString>,

    outbound_transactions: Vec<Spend>,
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

impl SimulatedPeer<SimulatedWalletSpend> {
    pub fn watch_and_report_coins(
        &mut self,
        current_height: usize,
        current_coins: &[CoinString],
    ) -> Result<WatchReport, Error> {
        self.simulated_wallet_spend
            .watch_and_report_coins(current_height, current_coins)
    }
}

#[derive(Default)]
struct Pipe {
    message_pipe: MessagePipe,

    // WalletSpendInterface
    outgoing_transactions: VecDeque<Spend>,
    registered_coins: HashMap<CoinString, Timeout>,

    // Opponent moves
    opponent_moves: Vec<(GameID, ReadableMove)>,
    opponent_messages: Vec<(GameID, Vec<u8>)>,

    // Bootstrap info
    channel_puzzle_hash: Option<PuzzleHash>,

    // Have other side's offer
    unfunded_offer: Option<SpendBundle>,

    #[allow(dead_code)]
    bootstrap_state: Option<WalletBootstrapState>,
}

pub struct RegisteredCoinsIterator<'a> {
    internal_iterator: std::collections::btree_map::Iter<'a, CoinString, WatchEntry>,
}

impl<'a> Iterator for RegisteredCoinsIterator<'a> {
    type Item = (&'a CoinString, &'a WatchEntry);

    fn next(&mut self) -> std::option::Option<<Self as Iterator>::Item> {
        self.internal_iterator.next().map(|(k,v)| (k,v))
    }
}

pub trait GameCradle {
    /// Signal game start.  Passes through to FromLocalUI::start_games.
    fn start_games(
        &mut self,
        i_initiated: bool,
        game: &GameStart
    ) -> Result<Vec<GameID>, Error>;

    /// Signal making a move.  Forwards to FromLocalUI::make_move.
    fn make_move(
        &mut self,
        id: &GameID,
        readable: Vec<u8>
    ) -> Result<(), Error>;

    /// Signal accepting a game outcome.  Forwards to FromLocalUI::accept.
    /// Perhaps we should consider reporting the rewards.
    fn accept(&mut self, id: &GameID) -> Result<(), Error>;

    /// Signal shutdown.  Forwards to FromLocalUI::shut_down.
    /// Perhaps we should consider reporting the reward coins.
    fn shut_down(&mut self) -> Result<(), Error>;

    /// Whether changes were made to the registered coins.
    fn registered_coins_changed(&self) -> bool;

    /// Tell us the coin list so we can register missing ones ourselves and pick out
    /// the proper notifications to bubble up.
    fn get_registered_coins(&self) -> RegisteredCoinsIterator<'_>;

    /// Tell the game cradle that a new block arrived, giving a watch report.
    fn new_block(&mut self, report: &WatchReport) -> Result<(), Error>;

    /// Deliver a message from the peer.
    fn deliver_message(&mut self, inbound_message: &[u8]) -> Result<(), Error>;

    /// Allow the game to carry out tasks it needs to perform, yielding peer messages that
    /// should be forwarded.  Returns false when no more work is needed.
    fn idle(
        &mut self,
        outbound_messages: &mut VecDeque<Vec<u8>>,
        local_ui: &mut dyn ToLocalUI
    ) -> Result<bool, Error>;
}

/// A game cradle that operates synchronously.  It can be composed with a game cradle that
/// operates message pipes to become asynchronous.
pub struct SynchronousGameCradle {
    registrations: BTreeMap<CoinString, WatchEntry>,
}

impl GameCradle for SynchronousGameCradle {
    /// Signal game start.  Passes through to FromLocalUI::start_games.
    fn start_games(
        &mut self,
        i_initiated: bool,
        game: &GameStart
    ) -> Result<Vec<GameID>, Error> {
        todo!();
    }

    /// Signal making a move.  Forwards to FromLocalUI::make_move.
    fn make_move(
        &mut self,
        id: &GameID,
        readable: Vec<u8>
    ) -> Result<(), Error> {
        todo!();
    }

    /// Signal accepting a game outcome.  Forwards to FromLocalUI::accept.
    /// Perhaps we should consider reporting the rewards.
    fn accept(&mut self, id: &GameID) -> Result<(), Error> {
        todo!();
    }

    /// Signal shutdown.  Forwards to FromLocalUI::shut_down.
    /// Perhaps we should consider reporting the reward coins.
    fn shut_down(&mut self) -> Result<(), Error> {
        todo!();
    }

    /// Whether changes were made to the registered coins.
    fn registered_coins_changed(&self) -> bool {
        todo!();
    }

    /// Tell us the coin list so we can register missing ones ourselves and pick out
    /// the proper notifications to bubble up.
    fn get_registered_coins(&self) -> RegisteredCoinsIterator<'_> {
        todo!();
    }

    /// Tell the game cradle that a new block arrived, giving a watch report.
    fn new_block(&mut self, report: &WatchReport) -> Result<(), Error> {
        todo!();
    }

    /// Deliver a message from the peer.
    fn deliver_message(&mut self, inbound_message: &[u8]) -> Result<(), Error> {
        todo!();
    }

    /// Allow the game to carry out tasks it needs to perform, yielding peer messages that
    /// should be forwarded.  Returns false when no more work is needed.
    fn idle(
        &mut self,
        outbound_messages: &mut VecDeque<Vec<u8>>,
        local_ui: &mut dyn ToLocalUI
    ) -> Result<bool, Error> {
        todo!();
    }
}
