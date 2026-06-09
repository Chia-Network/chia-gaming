//! Transaction manager: a coherent coin-lifecycle layer that wraps a game
//! cradle.
//!
//! The manager owns the blockchain-facing bookkeeping that previously lived
//! partly in JavaScript (`CoinStateMonitor`/`BlockchainPoller`) and partly in
//! the cradle (`FullCoinSetAdapter`/`filter_coin_report`):
//!
//! - It computes the created/deleted coin diff from raw per-coin chain state
//!   (`report_coin_states`) instead of receiving a pre-computed `WatchReport`.
//! - It captures outbound transactions the cradle wants submitted
//!   (`drain_submissions`) so the hosting layer becomes a thin RPC proxy.
//! - It tracks which coins to poll (`get_coins_to_poll`).
//!
//! Phase 1 is a structural move: timeout firing still happens inside the inner
//! cradle. The manager records per-coin birthdays and timeouts so that Phase 2
//! can take over ripeness-based submission, resubmission of vanished outputs,
//! and reorg handling.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::common::types::{AllocEncoder, CoinID, CoinString, Error, SpendBundle, Timeout};
use crate::peer_container::{DrainResult, SynchronousGameCradle, WatchReport};
use crate::potato_handler::effects::{CradleEvent, CradleEventQueue};

/// Raw per-coin chain state as reported by the polling layer for a single
/// watched coin.  `created_height`/`spent_height` are `None` until the coin is
/// observed created/spent on-chain.
#[derive(Debug, Clone)]
pub struct CoinStateRecord {
    pub coin: CoinString,
    pub created_height: Option<u64>,
    pub spent_height: Option<u64>,
}

/// A transaction the manager has handed to the hosting layer for submission,
/// retained so its outputs can be resubmitted if a reorg rolls them back.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct SubmittedTx {
    bundle: SpendBundle,
    /// Coin ids this transaction spends.  An output coin's parent is one of
    /// these, which is how a vanished output is matched back to its creator.
    spent_coin_ids: Vec<CoinID>,
    /// Absolute height at/after which the transaction can no longer be included
    /// (from an `ASSERT_BEFORE_HEIGHT_ABSOLUTE`).  `None` means no expiry.
    expiry: Option<u64>,
}

/// Per-watched-coin bookkeeping owned by the manager.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WatchedCoin {
    pub coin: CoinString,
    /// Relative timeout (in blocks) registered with the coin.
    pub timeout_blocks: Timeout,
    /// Optional human-readable label for diagnostics.
    pub name: Option<String>,
    /// Confirmed creation height, learned the first time the coin is observed
    /// on-chain.  May change under a reorg (Phase 2).
    pub birthday: Option<u64>,
    /// Confirmed spend height, set once the coin is observed spent.
    pub spent_confirmed_at: Option<u64>,
    /// Whether the eager `timeout_spend` has already been queued for submission
    /// for the current birthday.  Re-armed when the birthday changes or is
    /// cleared (e.g. by a reorg) so a reorg that rolls back the coin's creation
    /// causes the claim to be resubmitted.
    pub claim_submitted: bool,
    /// The eagerly-built spend to submit once this coin reaches its relative
    /// timeout age.  Set by the handler at registration time; held here so the
    /// manager is the sole submitter and can resubmit across reorgs.
    pub timeout_spend: Option<SpendBundle>,
    pub creation_spend: Option<SpendBundle>,
}

impl WatchedCoin {
    fn new(coin: CoinString, timeout_blocks: Timeout, name: Option<String>) -> Self {
        WatchedCoin {
            coin,
            timeout_blocks,
            name,
            birthday: None,
            spent_confirmed_at: None,
            claim_submitted: false,
            timeout_spend: None,
            creation_spend: None,
        }
    }
}

/// Result of draining the manager: the events the hosting layer still needs to
/// act on (notifications, outbound messages, coin-solution requests, launcher
/// and coin-spend requests), plus any resync signal.  Outbound transactions and
/// watch-coin registrations are intercepted by the manager and are not present
/// here.
#[derive(Default)]
pub struct ManagerDrain {
    pub events: CradleEventQueue,
    pub resync: Option<(usize, bool)>,
}

/// The minimal interface the [`TransactionManager`] needs from the cradle it
/// wraps.  Implemented by [`SynchronousGameCradle`] in production and by
/// `MockGameCradle` in unit tests.
pub trait ManagedCradle {
    fn cradle_new_block(
        &mut self,
        allocator: &mut AllocEncoder,
        height: u64,
        report: &WatchReport,
    ) -> Result<(), Error>;

    fn cradle_flush_and_collect(
        &mut self,
        allocator: &mut AllocEncoder,
    ) -> Result<DrainResult, Error>;
}

impl ManagedCradle for SynchronousGameCradle {
    fn cradle_new_block(
        &mut self,
        allocator: &mut AllocEncoder,
        height: u64,
        report: &WatchReport,
    ) -> Result<(), Error> {
        use crate::peer_container::GameCradle;
        GameCradle::new_block(self, allocator, height as usize, report)
    }

    fn cradle_flush_and_collect(
        &mut self,
        allocator: &mut AllocEncoder,
    ) -> Result<DrainResult, Error> {
        SynchronousGameCradle::flush_and_collect(self, allocator)
    }
}

/// A coherent coin-lifecycle layer wrapping a cradle.
#[derive(Serialize, Deserialize)]
pub struct TransactionManager<C> {
    cradle: C,
    /// Coins we are tracking, keyed by their full `CoinString`.
    watched_coins: HashMap<CoinString, WatchedCoin>,
    /// Transactions the cradle asked to submit, awaiting the hosting layer.
    pending_submissions: Vec<SpendBundle>,
    /// Events for the hosting layer that were not intercepted by the manager.
    #[serde(skip)]
    pending_events: CradleEventQueue,
    /// Resync signal observed during draining, surfaced to the hosting layer.
    #[serde(skip)]
    pending_resync: Option<(usize, bool)>,
    /// How many blocks a coin must remain confirmed-spent before eviction.
    confirmation_depth: u64,
    /// Most recent height reported via `report_coin_states`.
    last_height: u64,
    /// Watched coins that left the live set without a confirmed spend (e.g.
    /// reorged out before their creating transaction re-confirmed).  Surfaced to
    /// the resubmission layer so the creating transaction can be replayed.
    vanished_coins: std::collections::HashSet<CoinString>,
    /// Transactions handed out for submission, kept so a reorged-out output can
    /// be replayed by resubmitting the transaction that created it.
    submitted: Vec<SubmittedTx>,
    /// Coins observed live on-chain in the previous report.  Used to compute
    /// the created/deleted set difference, exactly mirroring the previous
    /// `FullCoinSetAdapter`.  Includes coins not (yet) watched so that a coin
    /// which appears one block before the manager learns to watch it is still
    /// reported as created at its true appearance height (the inner cradle
    /// filters the diff to the coins it actually watches).
    present_coins: std::collections::HashSet<CoinString>,
}

/// Default confirmation depth.  Chosen to be far deeper than any plausible
/// Chia reorg.
pub const DEFAULT_CONFIRMATION_DEPTH: u64 = 32;

/// Transparent access to the wrapped cradle for the many pass-through
/// operations (game actions, status queries) the manager does not intercept.
/// The manager's own inherent methods (`flush_and_collect`, etc.) take
/// precedence over deref for name collisions.
impl<C> std::ops::Deref for TransactionManager<C> {
    type Target = C;
    fn deref(&self) -> &C {
        &self.cradle
    }
}

impl<C> std::ops::DerefMut for TransactionManager<C> {
    fn deref_mut(&mut self) -> &mut C {
        &mut self.cradle
    }
}

impl<C> TransactionManager<C> {
    pub fn new(cradle: C) -> Self {
        TransactionManager {
            cradle,
            watched_coins: HashMap::new(),
            pending_submissions: Vec::new(),
            pending_events: CradleEventQueue::default(),
            pending_resync: None,
            confirmation_depth: DEFAULT_CONFIRMATION_DEPTH,
            last_height: 0,
            present_coins: std::collections::HashSet::new(),
            vanished_coins: std::collections::HashSet::new(),
            submitted: Vec::new(),
        }
    }

    pub fn cradle(&self) -> &C {
        &self.cradle
    }

    pub fn cradle_mut(&mut self) -> &mut C {
        &mut self.cradle
    }

    pub fn last_height(&self) -> u64 {
        self.last_height
    }

    pub fn confirmation_depth(&self) -> u64 {
        self.confirmation_depth
    }

    /// Coin strings the hosting layer should poll for on-chain state.
    pub fn get_coins_to_poll(&self) -> Vec<CoinString> {
        self.watched_coins.keys().cloned().collect()
    }

    /// Coin string for a watched coin, if tracked.
    pub fn watched_coin(&self, coin: &CoinString) -> Option<&WatchedCoin> {
        self.watched_coins.get(coin)
    }

    /// Drain transactions queued for submission to the network.  Each drained
    /// transaction is retained (keyed by the coins it spends) so its outputs can
    /// be resubmitted if a reorg rolls them back.
    pub fn drain_submissions(&mut self) -> Vec<SpendBundle> {
        let out = std::mem::take(&mut self.pending_submissions);
        for bundle in out.iter() {
            let spent_coin_ids: Vec<CoinID> =
                bundle.spends.iter().map(|s| s.coin.to_coin_id()).collect();
            // Don't double-track the same creating transaction across resubmits.
            if self
                .submitted
                .iter()
                .all(|t| t.spent_coin_ids != spent_coin_ids)
            {
                self.submitted.push(SubmittedTx {
                    bundle: bundle.clone(),
                    spent_coin_ids,
                    expiry: None,
                });
            }
        }
        out
    }

    /// Register (or refresh) a watched coin, its timeout, and the eager spend to
    /// submit when it matures.  A `None` spend on a refresh leaves any existing
    /// eager spend in place.
    fn register_watch(&mut self, coin: CoinString, timeout: Timeout, spend: Option<SpendBundle>) {
        self.watched_coins
            .entry(coin.clone())
            .and_modify(|w| {
                w.timeout_blocks = timeout.clone();
                if spend.is_some() {
                    w.timeout_spend = spend.clone();
                }
            })
            .or_insert_with(|| {
                let mut w = WatchedCoin::new(coin, timeout, None);
                w.timeout_spend = spend;
                w
            });
    }

    /// Partition cradle events: intercept outbound transactions and watch-coin
    /// registrations; buffer the rest for the hosting layer.
    fn absorb_events(&mut self, events: CradleEventQueue) {
        for event in events {
            match event {
                CradleEvent::OutboundTransaction(tx) => {
                    self.pending_submissions.push(tx);
                }
                CradleEvent::WatchCoin {
                    coin_string,
                    timeout,
                    spend,
                    ..
                } => {
                    self.register_watch(coin_string, timeout, spend);
                }
                other => {
                    self.pending_events.push_back(other);
                }
            }
        }
    }
}

impl<C: ManagedCradle> TransactionManager<C> {
    /// Report the latest confirmed height and the on-chain state of the watched
    /// coins.  Computes the created/deleted diff against tracked state and feeds
    /// it to the inner cradle.  Does not drain events; call
    /// [`TransactionManager::flush_and_collect`] afterwards (mirroring the
    /// previous `new_block` + `flush_and_collect` sequence).
    pub fn report_coin_states(
        &mut self,
        allocator: &mut AllocEncoder,
        height: u64,
        records: &[CoinStateRecord],
    ) -> Result<(), Error> {
        // A decrease in confirmed height means the chain rolled back.  Any
        // creation/spend we recorded above the new tip is no longer valid: it
        // may never reappear, or reappear at a different height.  Clear those
        // confirmations so this report re-derives them from the rolled-back
        // chain state.
        let reorg = height < self.last_height;
        self.last_height = height;
        let mut newly_vanished: Vec<CoinString> = Vec::new();
        if reorg {
            for (coin, watched) in self.watched_coins.iter_mut() {
                if matches!(watched.birthday, Some(b) if b > height) {
                    // The block that created this coin was rolled back.  Drop
                    // the birthday (re-arming its timeout) and flag it so the
                    // transaction that created it can be resubmitted.
                    watched.birthday = None;
                    watched.claim_submitted = false;
                    if self.vanished_coins.insert(coin.clone()) {
                        newly_vanished.push(coin.clone());
                    }
                }
                if matches!(watched.spent_confirmed_at, Some(s) if s > height) {
                    watched.spent_confirmed_at = None;
                }
            }
        }

        // Build the live set and reconcile per-watched-coin bookkeeping.  A
        // coin's birthday can *shift* under a reorg (re-mined at a new height),
        // so we update it rather than only setting it once.
        let mut present_now = std::collections::HashSet::new();
        for rec in records {
            let live = rec.created_height.is_some() && rec.spent_height.is_none();
            if live {
                present_now.insert(rec.coin.clone());
            }
            if let Some(watched) = self.watched_coins.get_mut(&rec.coin) {
                if let Some(created_height) = rec.created_height {
                    if watched.birthday != Some(created_height) {
                        // Birthday changed (first sighting or reorg re-mine):
                        // re-arm the relative timeout against the new birthday.
                        watched.birthday = Some(created_height);
                        watched.claim_submitted = false;
                    }
                }
                if let Some(spent_height) = rec.spent_height {
                    watched.spent_confirmed_at = Some(spent_height);
                }
            }
        }

        // Created/deleted are the symmetric difference against the previous
        // report.  We pass the full diff to the inner cradle, which filters it
        // to the coins it actually watches.  This is what lets a coin that was
        // registered the same block it appears still be reported created at the
        // correct height: the inner cradle already watches it even though the
        // manager only intercepts its watch registration after this report.
        let created_watched: std::collections::HashSet<CoinString> = present_now
            .difference(&self.present_coins)
            .cloned()
            .collect();
        let deleted_watched: std::collections::HashSet<CoinString> = self
            .present_coins
            .difference(&present_now)
            .cloned()
            .collect();
        self.present_coins = present_now;

        // A watched coin leaving the live set during forward progress is a
        // spend.  Some feeds (the full coin set) omit spent coins rather than
        // reporting a spend height, so fall back to the current height as a
        // lower bound.  Reorg-vanish is *not* detected here -- it is handled by
        // the rollback branch above, which is the only situation in which a
        // confirmed creation legitimately disappears.
        for coin in deleted_watched.iter() {
            // A coin whose creation was just rolled back (flagged vanished by
            // the reorg branch) did not get spent -- skip it.
            if self.vanished_coins.contains(coin) {
                continue;
            }
            if let Some(watched) = self.watched_coins.get_mut(coin) {
                if watched.spent_confirmed_at.is_none() {
                    watched.spent_confirmed_at = Some(height);
                }
            }
        }
        // A coin that re-confirmed live is no longer vanished.
        for coin in created_watched.iter() {
            self.vanished_coins.remove(coin);
        }

        // Resubmit the transaction that created each freshly-vanished output, so
        // a reorged-out coin reappears once its creating spend re-confirms.  A
        // transaction past its expiry is dropped rather than resubmitted.
        self.resubmit_vanished(&newly_vanished, height);

        // Ripeness: a watched coin whose relative timeout age has elapsed since
        // its (reorg-aware) birthday is ready for its eager timeout claim.  The
        // manager owns this decision and is the sole submitter -- the inner
        // cradle no longer computes an absolute deadline or receives a timeout
        // callback.  Eager claims that have reached their relative age and whose
        // coin is still unspent are submitted here once per birthday (and, via
        // the re-arm of `claim_submitted` on reorg, resubmitted), so submission
        // is fully decoupled from the handler.
        let mut to_submit: Vec<SpendBundle> = Vec::new();
        for watched in self.watched_coins.values_mut() {
            let ripe = matches!(watched.birthday, Some(b) if b + watched.timeout_blocks.to_u64() <= height);
            if !ripe {
                continue;
            }
            // Submit the eager claim once per birthday, only while the coin
            // remains unspent.
            if !watched.claim_submitted && watched.spent_confirmed_at.is_none() {
                if let Some(spend) = &watched.timeout_spend {
                    to_submit.push(spend.clone());
                    watched.claim_submitted = true;
                }
            }
        }
        self.pending_submissions.extend(to_submit);

        let report = WatchReport {
            created_watched,
            deleted_watched,
        };

        self.cradle.cradle_new_block(allocator, height, &report)?;

        self.evict_confirmed_spends(height);
        Ok(())
    }

    /// Re-queue the creating transaction for each freshly-vanished output coin.
    /// The creator is the tracked submission that spends the vanished coin's
    /// parent.  Expired transactions are dropped (the output is gone for good).
    fn resubmit_vanished(&mut self, newly_vanished: &[CoinString], height: u64) {
        for coin in newly_vanished {
            let parent = match coin.to_parts() {
                Some((parent, _, _)) => parent,
                None => continue,
            };
            // Find (and prune expired) the transaction that created this coin.
            let mut resubmit: Option<SpendBundle> = None;
            self.submitted.retain(|tx| {
                if !tx.spent_coin_ids.contains(&parent) {
                    return true;
                }
                if matches!(tx.expiry, Some(e) if height >= e) {
                    return false;
                }
                resubmit = Some(tx.bundle.clone());
                true
            });
            if let Some(bundle) = resubmit {
                self.pending_submissions.push(bundle);
            }
        }
    }

    /// Drop coins whose confirmed spend is buried at least `confirmation_depth`
    /// blocks deep, so a reorg can no longer revert it.  Stops the host from
    /// polling terminal coins.
    fn evict_confirmed_spends(&mut self, height: u64) {
        let depth = self.confirmation_depth;
        let mut evicted = Vec::new();
        self.watched_coins.retain(|coin, w| {
            let buried = matches!(w.spent_confirmed_at, Some(s) if s + depth <= height);
            if buried {
                evicted.push(coin.clone());
            }
            !buried
        });
        for coin in evicted {
            self.present_coins.remove(&coin);
            self.vanished_coins.remove(&coin);
        }
    }

    /// Coins that vanished (reorged out) without a confirmed spend, whose
    /// creating transaction should be resubmitted.
    pub fn vanished_coins(&self) -> &std::collections::HashSet<CoinString> {
        &self.vanished_coins
    }

    /// Drain the inner cradle, intercepting transactions and watch
    /// registrations, and return the remaining events for the hosting layer.
    pub fn flush_and_collect(
        &mut self,
        allocator: &mut AllocEncoder,
    ) -> Result<ManagerDrain, Error> {
        let result = self.cradle.cradle_flush_and_collect(allocator)?;
        if result.resync.is_some() {
            self.pending_resync = result.resync;
        }
        self.absorb_events(result.events);
        Ok(ManagerDrain {
            events: std::mem::take(&mut self.pending_events),
            resync: self.pending_resync.take(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::types::{Amount, CoinID, Hash, PuzzleHash};
    use crate::potato_handler::effects::CradleEvent;

    fn test_coin(tag: u8) -> CoinString {
        CoinString::from_parts(
            &CoinID::new(Hash::from_bytes([tag; 32])),
            &PuzzleHash::from_bytes([tag.wrapping_add(1); 32]),
            &Amount::new(1),
        )
    }

    fn test_bundle(name: &str) -> SpendBundle {
        SpendBundle {
            name: Some(name.to_string()),
            spends: vec![],
        }
    }

    /// A scriptable cradle for exercising the manager in isolation.  Each call
    /// to `cradle_flush_and_collect` returns the next queued `DrainResult`.
    #[derive(Default)]
    struct MockGameCradle {
        /// Reports seen via `cradle_new_block`, for assertions.
        seen_reports: Vec<(u64, WatchReport)>,
        /// Pre-scripted drains, returned in order.
        scripted_drains: std::collections::VecDeque<DrainResult>,
    }

    impl MockGameCradle {
        fn queue_drain(&mut self, events: Vec<CradleEvent>) {
            self.scripted_drains.push_back(DrainResult {
                events: events.into_iter().collect(),
                resync: None,
            });
        }

        fn queue_drain_with_resync(&mut self, events: Vec<CradleEvent>, resync: (usize, bool)) {
            self.scripted_drains.push_back(DrainResult {
                events: events.into_iter().collect(),
                resync: Some(resync),
            });
        }
    }

    impl ManagedCradle for MockGameCradle {
        fn cradle_new_block(
            &mut self,
            _allocator: &mut AllocEncoder,
            height: u64,
            report: &WatchReport,
        ) -> Result<(), Error> {
            self.seen_reports.push((height, report.clone()));
            Ok(())
        }

        fn cradle_flush_and_collect(
            &mut self,
            _allocator: &mut AllocEncoder,
        ) -> Result<DrainResult, Error> {
            Ok(self.scripted_drains.pop_front().unwrap_or_default())
        }
    }

    fn watch_event(coin: &CoinString, timeout: u64) -> CradleEvent {
        CradleEvent::WatchCoin {
            coin_name: coin.to_coin_id(),
            coin_string: coin.clone(),
            timeout: Timeout::new(timeout),
            spend: None,
        }
    }

    /// A `WatchCoin` event that also registers an eager timeout spend.
    fn watch_event_with_spend(coin: &CoinString, timeout: u64, spend: SpendBundle) -> CradleEvent {
        CradleEvent::WatchCoin {
            coin_name: coin.to_coin_id(),
            coin_string: coin.clone(),
            timeout: Timeout::new(timeout),
            spend: Some(spend),
        }
    }

    #[test]
    fn intercepts_watch_coin_and_tracks_timeout() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(1);
        let mut mock = MockGameCradle::default();
        mock.queue_drain(vec![watch_event(&coin, 100)]);
        let mut mgr = TransactionManager::new(mock);

        let drain = mgr.flush_and_collect(&mut allocator).expect("drain");

        // WatchCoin is intercepted, not forwarded.
        assert!(drain.events.is_empty());
        let watched = mgr.watched_coin(&coin).expect("tracked");
        assert_eq!(watched.timeout_blocks, Timeout::new(100));
        assert_eq!(watched.birthday, None);
        assert_eq!(mgr.get_coins_to_poll(), vec![coin]);
    }

    #[test]
    fn intercepts_outbound_transaction_into_submissions() {
        let mut allocator = AllocEncoder::new();
        let mut mock = MockGameCradle::default();
        mock.queue_drain(vec![
            CradleEvent::OutboundTransaction(test_bundle("tx-a")),
            CradleEvent::Log("kept".to_string()),
        ]);
        let mut mgr = TransactionManager::new(mock);

        let drain = mgr.flush_and_collect(&mut allocator).expect("drain");

        // The log is forwarded; the transaction is intercepted.
        assert_eq!(drain.events.len(), 1);
        assert!(matches!(drain.events[0], CradleEvent::Log(_)));
        let subs = mgr.drain_submissions();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].name.as_deref(), Some("tx-a"));
        // Draining empties the buffer.
        assert!(mgr.drain_submissions().is_empty());
    }

    #[test]
    fn records_birthday_and_spend_and_emits_diff() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(2);
        let mut mock = MockGameCradle::default();
        mock.queue_drain(vec![watch_event(&coin, 50)]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");

        // First sighting at height 10: created.
        let records = vec![CoinStateRecord {
            coin: coin.clone(),
            created_height: Some(10),
            spent_height: None,
        }];
        mgr.report_coin_states(&mut allocator, 10, &records)
            .expect("report");
        assert_eq!(mgr.watched_coin(&coin).unwrap().birthday, Some(10));

        // Second sighting at height 12, still unspent: no new diff.
        let records = vec![CoinStateRecord {
            coin: coin.clone(),
            created_height: Some(10),
            spent_height: None,
        }];
        mgr.report_coin_states(&mut allocator, 12, &records)
            .expect("report");

        // Third sighting at height 20: spent.
        let records = vec![CoinStateRecord {
            coin: coin.clone(),
            created_height: Some(10),
            spent_height: Some(20),
        }];
        mgr.report_coin_states(&mut allocator, 20, &records)
            .expect("report");
        assert_eq!(
            mgr.watched_coin(&coin).unwrap().spent_confirmed_at,
            Some(20)
        );

        let reports = &mgr.cradle().seen_reports;
        assert_eq!(reports.len(), 3);
        // Block 10: created only.
        assert!(reports[0].1.created_watched.contains(&coin));
        assert!(reports[0].1.deleted_watched.is_empty());
        // Block 12: nothing new.
        assert!(reports[1].1.created_watched.is_empty());
        assert!(reports[1].1.deleted_watched.is_empty());
        // Block 20: deleted only.
        assert!(reports[2].1.created_watched.is_empty());
        assert!(reports[2].1.deleted_watched.contains(&coin));
        assert_eq!(mgr.last_height(), 20);
    }

    #[test]
    fn does_not_track_unwatched_coins_but_passes_diff_through() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(3);
        let mut mgr = TransactionManager::new(MockGameCradle::default());

        let records = vec![CoinStateRecord {
            coin: coin.clone(),
            created_height: Some(5),
            spent_height: None,
        }];
        mgr.report_coin_states(&mut allocator, 5, &records)
            .expect("report");

        // The manager does not add bookkeeping for coins it was not told to
        // watch, but it still forwards the created transition so the inner
        // cradle (which owns the watch set in phase 1) can filter it.
        assert!(mgr.watched_coin(&coin).is_none());
        let reports = &mgr.cradle().seen_reports;
        assert_eq!(reports.len(), 1);
        assert!(reports[0].1.created_watched.contains(&coin));
    }

    #[test]
    fn eager_timeout_spend_submitted_once_at_maturity() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(10);
        let claim = test_bundle("timeout-claim");
        let mut mock = MockGameCradle::default();
        mock.queue_drain(vec![watch_event_with_spend(&coin, 5, claim.clone())]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");

        let live = vec![CoinStateRecord {
            coin: coin.clone(),
            created_height: Some(10),
            spent_height: None,
        }];

        // Before maturity: nothing submitted.
        mgr.report_coin_states(&mut allocator, 14, &live)
            .expect("report");
        assert!(mgr.drain_submissions().is_empty());

        // At maturity (10 + 5 = 15): the eager claim is queued exactly once.
        mgr.report_coin_states(&mut allocator, 15, &live)
            .expect("report");
        let subs = mgr.drain_submissions();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].name.as_deref(), Some("timeout-claim"));

        // Still mature next block, but already submitted for this birthday.
        mgr.report_coin_states(&mut allocator, 16, &live)
            .expect("report");
        assert!(mgr.drain_submissions().is_empty());
    }

    #[test]
    fn eager_timeout_spend_resubmitted_after_birthday_rollback() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(11);
        let claim = test_bundle("timeout-claim");
        let mut mock = MockGameCradle::default();
        mock.queue_drain(vec![watch_event_with_spend(&coin, 5, claim.clone())]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");

        let rec = |created: u64| {
            vec![CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(created),
                spent_height: None,
            }]
        };

        // Birthday 10 -> matures and submits at 15.
        mgr.report_coin_states(&mut allocator, 10, &rec(10))
            .expect("report");
        mgr.report_coin_states(&mut allocator, 15, &rec(10))
            .expect("report");
        assert_eq!(mgr.drain_submissions().len(), 1);

        // Reorg re-mines the coin at birthday 13: the claim re-arms and is
        // resubmitted once it matures again at 18.
        mgr.report_coin_states(&mut allocator, 12, &rec(13))
            .expect("report");
        assert!(mgr.drain_submissions().is_empty());
        mgr.report_coin_states(&mut allocator, 18, &rec(13))
            .expect("report");
        let resub = mgr.drain_submissions();
        assert_eq!(resub.len(), 1);
        assert_eq!(resub[0].name.as_deref(), Some("timeout-claim"));
    }

    #[test]
    fn eager_timeout_spend_not_submitted_if_coin_already_spent() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(12);
        let claim = test_bundle("timeout-claim");
        let mut mock = MockGameCradle::default();
        mock.queue_drain(vec![watch_event_with_spend(&coin, 5, claim.clone())]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");

        // Coin created at 10 and spent at 14, before its timeout age (15) is
        // reached: the opponent moved, so our claim must not be submitted.
        mgr.report_coin_states(
            &mut allocator,
            14,
            &[CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(10),
                spent_height: Some(14),
            }],
        )
        .expect("report");
        mgr.report_coin_states(
            &mut allocator,
            15,
            &[CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(10),
                spent_height: Some(14),
            }],
        )
        .expect("report");
        assert!(mgr.drain_submissions().is_empty());
    }

    #[test]
    fn reorged_out_output_resubmits_creating_transaction() {
        use crate::common::types::{CoinSpend, Spend};

        let mut allocator = AllocEncoder::new();
        // Parent coin spent by the creating transaction; its output is `child`.
        let parent = test_coin(20);
        let child = CoinString::from_parts(
            &parent.to_coin_id(),
            &PuzzleHash::from_bytes([21; 32]),
            &Amount::new(1),
        );
        let creating_tx = SpendBundle {
            name: Some("create-child".to_string()),
            spends: vec![CoinSpend {
                coin: parent.clone(),
                bundle: Spend::default(),
            }],
        };

        let mut mock = MockGameCradle::default();
        // The cradle wants to watch the child and submits the creating tx.
        mock.queue_drain(vec![
            watch_event(&child, 50),
            CradleEvent::OutboundTransaction(creating_tx.clone()),
        ]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");

        // The host submits the creating tx; the manager remembers it.
        let submitted = mgr.drain_submissions();
        assert_eq!(submitted.len(), 1);

        // Child confirms at height 10.
        mgr.report_coin_states(
            &mut allocator,
            10,
            &[CoinStateRecord {
                coin: child.clone(),
                created_height: Some(10),
                spent_height: None,
            }],
        )
        .expect("report");
        assert!(mgr.drain_submissions().is_empty());

        // Reorg to height 8 rolls back the child's creating block.  The manager
        // flags it vanished and re-queues the creating transaction.
        mgr.report_coin_states(&mut allocator, 8, &[])
            .expect("report");
        assert!(mgr.vanished_coins().contains(&child));
        let resubmitted = mgr.drain_submissions();
        assert_eq!(resubmitted.len(), 1);
        assert_eq!(resubmitted[0].name.as_deref(), Some("create-child"));
    }

    #[test]
    fn reorg_resets_creation_and_spend_above_new_tip() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(4);
        let mut mock = MockGameCradle::default();
        mock.queue_drain(vec![watch_event(&coin, 50)]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");

        // Created at 10, then spent at 20.
        mgr.report_coin_states(
            &mut allocator,
            10,
            &[CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(10),
                spent_height: None,
            }],
        )
        .expect("report");
        mgr.report_coin_states(
            &mut allocator,
            20,
            &[CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(10),
                spent_height: Some(20),
            }],
        )
        .expect("report");
        assert_eq!(mgr.watched_coin(&coin).unwrap().birthday, Some(10));
        assert_eq!(
            mgr.watched_coin(&coin).unwrap().spent_confirmed_at,
            Some(20)
        );

        // Chain rolls back to height 15: the spend at 20 is reverted, the
        // creation at 10 survives.  The post-rollback poll shows the coin live
        // again (created 10, unspent).
        mgr.report_coin_states(
            &mut allocator,
            15,
            &[CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(10),
                spent_height: None,
            }],
        )
        .expect("report");
        assert_eq!(mgr.watched_coin(&coin).unwrap().birthday, Some(10));
        assert_eq!(mgr.watched_coin(&coin).unwrap().spent_confirmed_at, None);
    }

    #[test]
    fn reorg_drops_birthday_when_creation_rolled_back() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(5);
        let mut mock = MockGameCradle::default();
        mock.queue_drain(vec![watch_event(&coin, 50)]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");

        mgr.report_coin_states(
            &mut allocator,
            12,
            &[CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(12),
                spent_height: None,
            }],
        )
        .expect("report");
        assert_eq!(mgr.watched_coin(&coin).unwrap().birthday, Some(12));

        // Roll back below the creation height; the coin vanishes from the feed.
        mgr.report_coin_states(&mut allocator, 8, &[])
            .expect("report");
        assert_eq!(mgr.watched_coin(&coin).unwrap().birthday, None);
        assert!(mgr.vanished_coins().contains(&coin));

        // Replay: the creating transaction re-confirms at a new height.  The
        // birthday shifts and the coin is no longer flagged vanished.
        mgr.report_coin_states(
            &mut allocator,
            13,
            &[CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(13),
                spent_height: None,
            }],
        )
        .expect("report");
        assert_eq!(mgr.watched_coin(&coin).unwrap().birthday, Some(13));
        assert!(!mgr.vanished_coins().contains(&coin));
    }

    #[test]
    fn forward_progress_disappearance_is_a_spend_not_a_vanish() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(6);
        let mut mock = MockGameCradle::default();
        mock.queue_drain(vec![watch_event(&coin, 50)]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");

        mgr.report_coin_states(
            &mut allocator,
            10,
            &[CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(10),
                spent_height: None,
            }],
        )
        .expect("report");
        // The coin disappears while the height advances: on the full-coin-set
        // feed that is exactly how a spend looks, so it must be recorded as
        // spent, never flagged for resubmission.
        mgr.report_coin_states(&mut allocator, 11, &[])
            .expect("report");
        assert!(!mgr.vanished_coins().contains(&coin));
        assert_eq!(
            mgr.watched_coin(&coin).unwrap().spent_confirmed_at,
            Some(11)
        );
    }

    #[test]
    fn spent_coin_evicted_after_confirmation_depth() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(7);
        let mut mock = MockGameCradle::default();
        mock.queue_drain(vec![watch_event(&coin, 50)]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");
        let depth = mgr.confirmation_depth();

        mgr.report_coin_states(
            &mut allocator,
            100,
            &[CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(90),
                spent_height: Some(100),
            }],
        )
        .expect("report");
        assert!(mgr.watched_coin(&coin).is_some());

        // One block short of the eviction threshold: still tracked.
        mgr.report_coin_states(&mut allocator, 100 + depth - 1, &[])
            .expect("report");
        assert!(mgr.watched_coin(&coin).is_some());

        // At the threshold the spend is buried deeply enough to evict.
        mgr.report_coin_states(&mut allocator, 100 + depth, &[])
            .expect("report");
        assert!(mgr.watched_coin(&coin).is_none());
        assert!(mgr.get_coins_to_poll().is_empty());
    }

    #[test]
    fn surfaces_resync_signal() {
        let mut allocator = AllocEncoder::new();
        let mut mock = MockGameCradle::default();
        mock.queue_drain_with_resync(vec![], (7, true));
        let mut mgr = TransactionManager::new(mock);

        let drain = mgr.flush_and_collect(&mut allocator).expect("drain");
        assert_eq!(drain.resync, Some((7, true)));
        // Subsequent drains do not repeat the resync.
        let drain = mgr.flush_and_collect(&mut allocator).expect("drain");
        assert_eq!(drain.resync, None);
    }
}
