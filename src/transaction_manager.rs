//! Transaction manager: a coherent coin-lifecycle layer that wraps a game
//! cradle.
//!
//! The manager owns the blockchain-facing bookkeeping that previously lived
//! partly in JavaScript (`CoinStateMonitor`/`BlockchainPoller`):
//!
//! - It computes the created/deleted coin diff from raw per-coin chain state
//!   (`report_coin_states`) and emits ordered observations to the cradle.
//! - It captures outbound transactions the cradle wants submitted
//!   (`drain_submissions`) so the hosting layer becomes a thin RPC proxy.
//! - It tracks watched coins (`snapshot_watched_coins` exposes a durable snapshot).
//!
//! Reorg boundary: protocol handlers are deliberately written as if reorgs do
//! not happen. They register watched coins and hand this manager any
//! timeout/safety spends that should be submitted once mature. This manager owns
//! height tracking, maturity, retained submissions, rollback detection, and
//! replay. It should not surface repeated handler-level events merely because a
//! reorg made a transaction need resubmission.
//!
//! Current limitation: this replay model does not resolve cases where a
//! conflicting transaction successfully confirms or otherwise permanently
//! invalidates a retained spend plan. Those paths are future
//! protocol/error-handling work.

use std::collections::HashMap;

use serde::{Deserialize, Serialize};

use crate::common::types::{
    AllocEncoder, CoinCondition, CoinID, CoinString, Error, SpendBundle, Timeout,
};
use crate::game_session::{CoinObservation, DrainResult, GameSession};
use crate::session_phases::effects::{
    GameSessionEvent, GameSessionEventQueue, TimeoutClaimSemantic,
};

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
    /// Output coins this transaction should create, derived from its
    /// `CREATE_COIN` conditions.  These are replay/conflict metadata only:
    /// they do not become poll targets unless a protocol handler separately
    /// registers the coin as watched.
    #[serde(default)]
    expected_output_coins: Vec<CoinString>,
    /// Set once any expected output is observed on-chain.
    #[serde(default)]
    landed: bool,
    /// Absolute height at/after which the transaction can no longer be included
    /// (from an `ASSERT_BEFORE_HEIGHT_ABSOLUTE`).  `None` means no expiry.
    expiry: Option<u64>,
}

fn expected_output_coins(bundle: &SpendBundle) -> Result<Vec<CoinString>, Error> {
    let mut allocator = AllocEncoder::new();
    let mut out = Vec::new();
    for spend in &bundle.spends {
        let puzzle = spend.bundle.puzzle.to_program();
        let solution = spend.bundle.solution.p();
        let conditions =
            CoinCondition::from_puzzle_and_solution(&mut allocator, &puzzle, &solution).map_err(
                |e| {
                    Error::StrErr(format!(
                        "expected_output_coins: our submitted spend failed to parse: {e:?}"
                    ))
                },
            )?;
        let parent = spend.coin.to_coin_id();
        out.extend(conditions.into_iter().filter_map(|cond| {
            if let CoinCondition::CreateCoin(ph, amount) = cond {
                Some(CoinString::from_parts(&parent, &ph, &amount))
            } else {
                None
            }
        }));
    }
    Ok(out)
}

/// Combine two optional expiry heights, keeping the tightest (smallest)
/// constraint.  `None` means "no expiry" (effectively infinite), so it never
/// wins against a concrete `Some`.
fn min_expiry(a: Option<u64>, b: Option<u64>) -> Option<u64> {
    match (a, b) {
        (Some(a), Some(b)) => Some(a.min(b)),
        (Some(v), None) | (None, Some(v)) => Some(v),
        (None, None) => None,
    }
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
    /// UI context emitted when the manager submits this timeout spend.
    #[serde(default)]
    pub timeout_claim_semantic: Option<TimeoutClaimSemantic>,
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
            timeout_claim_semantic: None,
            creation_spend: None,
        }
    }
}

#[derive(Default)]
pub struct ManagerDrain {
    pub events: GameSessionEventQueue,
    pub watch_coins: Vec<CoinString>,
    pub unwatch_coins: Vec<CoinString>,
    pub resync: Option<(usize, bool)>,
}

/// The minimal interface the [`TransactionManager`] needs from the cradle it
/// wraps.  Implemented by [`GameSession`] in production and by
/// `MockGameSession` in unit tests.
pub trait ManagedGameSession {
    /// Receive a manager-ordered coin observation batch. `None` advances
    /// protocol clocks from a trusted height without treating an unavailable
    /// snapshot as an authoritative empty coin set.
    fn session_observe(
        &mut self,
        allocator: &mut AllocEncoder,
        height: u64,
        observations: Option<&[CoinObservation]>,
    ) -> Result<(), Error>;

    fn session_flush_and_collect(
        &mut self,
        allocator: &mut AllocEncoder,
    ) -> Result<DrainResult, Error>;

    /// Record a manager-confirmed timeout submission in the session's canonical
    /// status snapshot before the host drains the transaction buffer.
    fn session_timeout_claim_submitted(
        &mut self,
        _semantic: TimeoutClaimSemantic,
    ) -> Result<(), Error> {
        Ok(())
    }

    /// Clear canonical timeout-submission progress after a reorg or changed
    /// birthday has re-armed the relative timeout claim.
    fn session_timeout_claim_rearmed(
        &mut self,
        _semantic: TimeoutClaimSemantic,
    ) -> Result<(), Error> {
        Ok(())
    }

    fn is_abandoned(&self) -> bool {
        false
    }
}

impl ManagedGameSession for GameSession {
    fn session_observe(
        &mut self,
        allocator: &mut AllocEncoder,
        height: u64,
        observations: Option<&[CoinObservation]>,
    ) -> Result<(), Error> {
        use crate::game_session::GameSession;
        match observations {
            Some(observations) => GameSession::new_block(self, allocator, height, observations),
            None => GameSession::new_block_height_only(self, allocator, height),
        }
    }

    fn session_flush_and_collect(
        &mut self,
        allocator: &mut AllocEncoder,
    ) -> Result<DrainResult, Error> {
        GameSession::flush_and_collect(self, allocator)
    }

    fn session_timeout_claim_submitted(
        &mut self,
        semantic: TimeoutClaimSemantic,
    ) -> Result<(), Error> {
        GameSession::timeout_claim_submitted(self, semantic)
    }

    fn session_timeout_claim_rearmed(
        &mut self,
        semantic: TimeoutClaimSemantic,
    ) -> Result<(), Error> {
        GameSession::timeout_claim_rearmed(self, semantic)
    }

    fn is_abandoned(&self) -> bool {
        GameSession::is_abandoned(self)
    }
}

/// A coherent coin-lifecycle layer wrapping a cradle.
#[derive(Serialize, Deserialize)]
pub struct TransactionManager<C> {
    cradle: C,
    /// Coins we are tracking, keyed by their full `CoinString`.
    watched_coins: HashMap<CoinString, WatchedCoin>,
    /// Transactions the cradle asked to submit, awaiting the hosting layer.
    /// Each carries the optional absolute expiry height threaded from the
    /// handler (`ASSERT_BEFORE_HEIGHT_ABSOLUTE`), so it lands on the retained
    /// `SubmittedTx` when drained.
    pending_submissions: Vec<(SpendBundle, Option<u64>)>,
    /// Events for the hosting layer that were not intercepted by the manager.
    #[serde(skip)]
    pending_events: GameSessionEventQueue,
    /// Watch registrations intercepted during draining.  Runtime hosts consume
    /// these as deltas; restore still seeds from the durable watched set.
    #[serde(skip)]
    pending_watch_coins: Vec<CoinString>,
    /// Watch removals intercepted from semantic manager eviction. Runtime hosts
    /// consume these as deltas; the durable watched set remains authoritative.
    #[serde(skip)]
    pending_unwatch_coins: Vec<CoinString>,
    /// Resync signal observed during draining, surfaced to the hosting layer.
    #[serde(skip)]
    pending_resync: Option<(usize, bool)>,
    /// How many blocks a coin must remain confirmed-spent before eviction.
    confirmation_depth: u64,
    /// Most recent height reported via `report_coin_states`.
    last_height: u64,
    /// Most recent height accompanied by a complete, authoritative coin
    /// snapshot. Kept separately from `last_height`: a height-only observation
    /// must advance protocol clocks without masking a later reorg from the
    /// snapshot reconciliation path.
    #[serde(default)]
    last_snapshot_height: u64,
    /// Tip of the rollback epoch whose timeout claims have already been
    /// invalidated. A height-only report is normally followed by a same-height
    /// authoritative snapshot; both describe one rollback and must not re-arm
    /// claims twice.
    #[serde(default)]
    timeout_rollback_height: Option<u64>,
    /// Restore-only projection guard. `claim_submitted` is durable manager
    /// truth, while the session semantic phase may be absent from a legacy
    /// save; replay it once after deserialization without re-notifying the
    /// session on every ordinary poll.
    #[serde(skip)]
    timeout_claim_status_reconciled: bool,
    /// Watched coins that left the live set without a confirmed spend (e.g.
    /// reorged out before their creating transaction re-confirmed).  Surfaced to
    /// the resubmission layer so the creating transaction can be replayed.
    vanished_coins: std::collections::HashSet<CoinString>,
    /// Transactions handed out for submission, kept so a reorged-out watched
    /// protocol output can be replayed by resubmitting the transaction that
    /// created it.
    submitted: Vec<SubmittedTx>,
    /// Coins observed live on-chain in the previous report.  Used to compute
    /// the created/deleted set difference, exactly mirroring the previous
    /// `FullCoinSetAdapter`.  Includes coins not (yet) watched so that a coin
    /// which appears one block before the manager learns to watch it is still
    /// emitted as a creation at its true appearance height.
    present_coins: std::collections::HashSet<CoinString>,
}

/// Default confirmation depth.  Chosen to be far deeper than any plausible
/// Chia reorg.
pub const DEFAULT_CONFIRMATION_DEPTH: u64 = 32;

/// Extra blocks after an absolute transaction expiry before a reorg replay is
/// no longer viable.
pub const CHANNEL_EXPIRY_BUFFER: u64 = 6;

/// Upper bound on any height reported to the manager.  Real Chia heights are in
/// the single-digit millions and grow ~1.6M/year, so this is absurdly generous
/// while leaving ~7 orders of magnitude below `u64::MAX` -- enough that adding
/// the largest registered timeout (the channel coin's 1_000_000) to a bounded
/// height can never overflow.  A height above this can only come from a corrupt
/// or malicious source, so it is rejected at ingestion rather than silently
/// clamped (which would let the bad value poison reorg detection and the
/// created/deleted diff anyway).
pub const MAX_REPORTED_HEIGHT: u64 = 1_000_000_000_000;

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
            pending_events: GameSessionEventQueue::default(),
            pending_watch_coins: Vec::new(),
            pending_unwatch_coins: Vec::new(),
            pending_resync: None,
            confirmation_depth: DEFAULT_CONFIRMATION_DEPTH,
            last_height: 0,
            last_snapshot_height: 0,
            timeout_rollback_height: None,
            timeout_claim_status_reconciled: false,
            present_coins: std::collections::HashSet::new(),
            vanished_coins: std::collections::HashSet::new(),
            submitted: Vec::new(),
        }
    }

    pub fn cradle(&self) -> &C {
        &self.cradle
    }

    pub fn session_mut(&mut self) -> &mut C {
        &mut self.cradle
    }

    pub fn last_height(&self) -> u64 {
        self.last_height
    }

    pub fn confirmation_depth(&self) -> u64 {
        self.confirmation_depth
    }

    /// Durable watched-coin snapshot for seeding the host poller.
    pub fn snapshot_watched_coins(&self) -> Vec<CoinString> {
        self.watched_coins
            .keys()
            .cloned()
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    /// Coin string for a watched coin, if tracked.
    pub fn watched_coin(&self, coin: &CoinString) -> Option<&WatchedCoin> {
        self.watched_coins.get(coin)
    }

    /// Drain transactions queued for submission to the network.  Each drained
    /// transaction is retained (keyed by the coins it spends) so its outputs can
    /// be resubmitted if a reorg rolls them back.
    pub fn drain_submissions(&mut self) -> Result<Vec<SpendBundle>, Error> {
        // Parse before consuming the queue so a bad bundle does not drop peers.
        let mut new_outputs: Vec<Option<Vec<CoinString>>> =
            Vec::with_capacity(self.pending_submissions.len());
        for (bundle, _) in self.pending_submissions.iter() {
            let spent_coin_ids: Vec<CoinID> =
                bundle.spends.iter().map(|s| s.coin.to_coin_id()).collect();
            if self
                .submitted
                .iter()
                .any(|t| t.spent_coin_ids == spent_coin_ids)
            {
                new_outputs.push(None);
            } else {
                new_outputs.push(Some(expected_output_coins(bundle)?));
            }
        }
        let out = std::mem::take(&mut self.pending_submissions);
        for ((bundle, expiry), outputs) in out.iter().zip(new_outputs) {
            let spent_coin_ids: Vec<CoinID> =
                bundle.spends.iter().map(|s| s.coin.to_coin_id()).collect();
            // Don't double-track the same creating transaction across resubmits;
            // instead tighten the existing entry's expiry to the minimum of the
            // two (a `None` expiry means no constraint, so any `Some` wins).
            if let Some(existing) = self
                .submitted
                .iter_mut()
                .find(|t| t.spent_coin_ids == spent_coin_ids)
            {
                existing.expiry = min_expiry(existing.expiry, *expiry);
            } else if let Some(outputs) = outputs {
                self.submitted.push(SubmittedTx {
                    bundle: bundle.clone(),
                    spent_coin_ids,
                    expected_output_coins: outputs,
                    landed: false,
                    expiry: *expiry,
                });
            }
        }
        Ok(out.into_iter().map(|(bundle, _)| bundle).collect())
    }

    /// Re-queue retained, unexpired submissions after the host has supplied a
    /// fresh chain height. A transaction drained before reload may not have
    /// reached the network; an absolute-expiry transaction cannot become valid
    /// again and is discarded rather than repeatedly offered to the wallet.
    pub fn requeue_submitted(&mut self) {
        self.submitted
            .retain(|tx| !matches!(tx.expiry, Some(expiry) if self.last_height >= expiry));
        for tx in self.submitted.iter() {
            self.pending_submissions
                .push((tx.bundle.clone(), tx.expiry));
        }
    }

    /// Register (or refresh) a watched coin, its timeout, and the eager spend to
    /// submit when it matures.  A `None` spend on a refresh leaves any existing
    /// eager spend in place.
    fn register_watch(
        &mut self,
        coin: CoinString,
        timeout: Timeout,
        spend: Option<SpendBundle>,
        semantic: Option<TimeoutClaimSemantic>,
    ) {
        self.watched_coins
            .entry(coin.clone())
            .and_modify(|w| {
                w.timeout_blocks = timeout.clone();
                if spend.is_some() {
                    w.timeout_spend = spend.clone();
                    w.timeout_claim_semantic = semantic;
                }
            })
            .or_insert_with(|| {
                let mut w = WatchedCoin::new(coin, timeout, None);
                w.timeout_spend = spend;
                w.timeout_claim_semantic = semantic;
                w
            });
    }

    /// Partition cradle events: intercept outbound transactions and watch-coin
    /// registrations; buffer the rest for the hosting layer.
    fn absorb_events(&mut self, events: GameSessionEventQueue) {
        for event in events {
            match event {
                GameSessionEvent::OutboundTransaction(tx, expiry) => {
                    self.pending_submissions.push((tx, expiry));
                }
                GameSessionEvent::WatchCoin {
                    coin_string,
                    timeout,
                    spend,
                    semantic,
                    ..
                } => {
                    self.pending_watch_coins.push(coin_string.clone());
                    self.register_watch(coin_string, timeout, spend, semantic);
                }
                other => {
                    self.pending_events.push_back(other);
                }
            }
        }
    }
}

impl<C: ManagedGameSession> TransactionManager<C> {
    /// Report a trusted chain height when the watched-coin snapshot is not
    /// available or is known partial. This advances handshake protocol clocks
    /// through the manager without inventing coin creations/deletions or
    /// evaluating channel-creation expiry from absent coin data.
    pub fn report_height(
        &mut self,
        allocator: &mut AllocEncoder,
        height: u64,
    ) -> Result<(), Error> {
        if height > MAX_REPORTED_HEIGHT {
            return Err(Error::StrErr(format!(
                "report_height: height {height} exceeds MAX_REPORTED_HEIGHT {MAX_REPORTED_HEIGHT}"
            )));
        }
        let reorg = height < self.last_height;
        self.last_height = height;
        if let Some(rearmed) = self.invalidate_timeout_claims_for_rollback_epoch(height, reorg) {
            self.report_timeout_claim_rearms(rearmed)?;
        }
        self.reconcile_timeout_claim_status()?;
        self.evaluate_mature_timeout_claims(height)?;
        self.cradle.session_observe(allocator, height, None)
    }

    /// Consume a rollback epoch once. A height-only report commonly precedes a
    /// full snapshot at the same tip; that snapshot still performs its own
    /// coin-set reconciliation but must not re-arm timeout progress again.
    fn invalidate_timeout_claims_for_rollback_epoch(
        &mut self,
        height: u64,
        is_rollback: bool,
    ) -> Option<Vec<TimeoutClaimSemantic>> {
        if !is_rollback {
            if matches!(self.timeout_rollback_height, Some(rollback) if height > rollback) {
                self.timeout_rollback_height = None;
            }
            return None;
        }
        if self.timeout_rollback_height == Some(height) {
            return None;
        }
        self.timeout_rollback_height = Some(height);
        let mut rearmed = Vec::new();
        for watched in self.watched_coins.values_mut() {
            if matches!(watched.spent_confirmed_at, Some(spent) if spent > height) {
                watched.spent_confirmed_at = None;
            }
            if watched.claim_submitted {
                watched.claim_submitted = false;
                if let Some(semantic) = watched.timeout_claim_semantic {
                    rearmed.push(semantic);
                }
            }
        }
        Some(rearmed)
    }

    fn report_timeout_claim_rearms(
        &mut self,
        rearmed: Vec<TimeoutClaimSemantic>,
    ) -> Result<(), Error> {
        let mut reported = Vec::new();
        for semantic in rearmed {
            if !reported.contains(&semantic) {
                self.cradle.session_timeout_claim_rearmed(semantic)?;
                reported.push(semantic);
            }
        }
        Ok(())
    }

    /// Re-project durable manager truth after restore. The session's serialized
    /// phase metadata may be absent in legacy saves, while `claim_submitted`
    /// remains the authoritative record that this manager already queued the
    /// timeout spend.
    fn reconcile_timeout_claim_status(&mut self) -> Result<(), Error> {
        if self.timeout_claim_status_reconciled {
            return Ok(());
        }
        let semantics = self
            .watched_coins
            .values()
            .filter(|watched| watched.claim_submitted && watched.spent_confirmed_at.is_none())
            .filter_map(|watched| watched.timeout_claim_semantic)
            .collect::<Vec<_>>();
        for semantic in semantics {
            self.cradle.session_timeout_claim_submitted(semantic)?;
        }
        self.timeout_claim_status_reconciled = true;
        Ok(())
    }

    fn evaluate_mature_timeout_claims(&mut self, height: u64) -> Result<(), Error> {
        let mut to_submit: Vec<(SpendBundle, Option<TimeoutClaimSemantic>)> = Vec::new();
        for watched in self.watched_coins.values_mut() {
            let ripe = matches!(watched.birthday, Some(b) if b + watched.timeout_blocks.to_u64() <= height);
            if ripe && !watched.claim_submitted && watched.spent_confirmed_at.is_none() {
                if let Some(spend) = &watched.timeout_spend {
                    to_submit.push((spend.clone(), watched.timeout_claim_semantic));
                    watched.claim_submitted = true;
                }
            }
        }
        for (spend, semantic) in to_submit {
            if let Some(semantic) = semantic {
                self.cradle.session_timeout_claim_submitted(semantic)?;
            }
            self.pending_submissions.push((spend, None));
        }
        Ok(())
    }

    fn discard_local_artifacts(&mut self) {
        self.pending_submissions.clear();
        self.pending_events.clear();
        self.pending_watch_coins.clear();
        self.pending_unwatch_coins.clear();
        self.pending_resync = None;
        self.watched_coins.clear();
        self.submitted.clear();
        self.vanished_coins.clear();
    }

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
        // Reject out-of-range heights before touching any state: a height above
        // `MAX_REPORTED_HEIGHT` can only come from a corrupt/malicious source,
        // and letting it through would both poison our bookkeeping and risk
        // overflow in the ripeness/burial arithmetic.
        if height > MAX_REPORTED_HEIGHT {
            return Err(Error::StrErr(format!(
                "report_coin_states: height {height} exceeds MAX_REPORTED_HEIGHT {MAX_REPORTED_HEIGHT}"
            )));
        }
        for rec in records {
            for h in [rec.created_height, rec.spent_height].into_iter().flatten() {
                if h > MAX_REPORTED_HEIGHT {
                    return Err(Error::StrErr(format!(
                        "report_coin_states: coin height {h} exceeds MAX_REPORTED_HEIGHT {MAX_REPORTED_HEIGHT}"
                    )));
                }
            }
        }

        // A decrease in confirmed height means the chain rolled back.  Any
        // creation/spend we recorded above the new tip is no longer valid: it
        // may never reappear, or reappear at a different height.  Clear those
        // confirmations so this report re-derives them from the rolled-back
        // chain state.
        let reorg = height < self.last_snapshot_height;
        self.last_height = height;
        self.last_snapshot_height = height;
        let mut newly_vanished: Vec<CoinString> = Vec::new();
        let mut rearmed_timeout_claims: Vec<TimeoutClaimSemantic> = Vec::new();
        if let Some(rearmed) = self.invalidate_timeout_claims_for_rollback_epoch(height, reorg) {
            rearmed_timeout_claims = rearmed;
        }
        if reorg {
            for (coin, watched) in self.watched_coins.iter_mut() {
                if matches!(watched.birthday, Some(b) if b > height) {
                    // The block that created this coin was rolled back.  Drop
                    // the birthday (re-arming its timeout) and flag it so the
                    // transaction that created it can be resubmitted.
                    let was_claim_submitted = watched.claim_submitted;
                    watched.birthday = None;
                    watched.claim_submitted = false;
                    if was_claim_submitted {
                        if let Some(semantic) = watched.timeout_claim_semantic {
                            rearmed_timeout_claims.push(semantic);
                        }
                    }
                    if self.vanished_coins.insert(coin.clone()) {
                        newly_vanished.push(coin.clone());
                    }
                }
            }
        }

        // Build the live set and reconcile per-watched-coin bookkeeping.  A
        // coin's birthday can *shift* under a reorg (re-mined at a new height),
        // so we update it rather than only setting it once.
        let mut present_now = std::collections::HashSet::new();
        // Watched coins whose first observation already shows them spent (the
        // record carries both a creation and a spend height).  Such a coin was
        // never recorded as present, so the present->absent diff below cannot
        // produce it -- but the handler still needs the spend forwarded.  See
        // where these are merged into `deleted_watched`.
        let mut first_seen_spent: Vec<CoinString> = Vec::new();
        for rec in records {
            // A coin that reappears with a creation height during a reorg is live
            // again, so clear any vanished flag here rather than relying solely on
            // the `created_watched` set-diff below.  If the coin was re-mined at or
            // below the new tip in the same report that rolled back its creation,
            // it never left `present_coins` and so never shows up in that diff --
            // leaving it stuck in `vanished_coins`, which would later suppress
            // forwarding a genuine spend via `deleted_watched.retain`.
            if reorg && rec.created_height.is_some() {
                self.vanished_coins.remove(&rec.coin);
            }
            let live = rec.created_height.is_some() && rec.spent_height.is_none();
            if live {
                present_now.insert(rec.coin.clone());
            }
            let was_present = self.present_coins.contains(&rec.coin);
            if let Some(watched) = self.watched_coins.get_mut(&rec.coin) {
                if let Some(created_height) = rec.created_height {
                    if watched.birthday != Some(created_height) {
                        let was_claim_submitted = watched.claim_submitted;
                        watched.birthday = Some(created_height);
                        watched.claim_submitted = false;
                        if was_claim_submitted {
                            if let Some(semantic) = watched.timeout_claim_semantic {
                                rearmed_timeout_claims.push(semantic);
                            }
                        }
                    }
                }
                if let Some(spent_height) = rec.spent_height {
                    // First report that learns of this spend, for a coin we never
                    // saw live: capture it so the spend is still forwarded.
                    // `spent_confirmed_at.is_none()` keeps this one-shot.
                    if watched.spent_confirmed_at.is_none() && !was_present {
                        first_seen_spent.push(rec.coin.clone());
                    }
                    watched.spent_confirmed_at = Some(spent_height);
                }
            }
        }

        // Retained submissions are replay intents, not timeless wishes.  Once a
        // coin they spend is observed spent, keep only submissions that appear
        // to have won by creating one of their expected outputs.  The rest are
        // conflicting local intents and must not be resurrected on reload/reorg.
        let observed_created: std::collections::HashSet<CoinString> = records
            .iter()
            .filter(|rec| rec.created_height.is_some())
            .map(|rec| rec.coin.clone())
            .collect();
        let spent_inputs: std::collections::HashSet<CoinID> = records
            .iter()
            .filter(|rec| rec.spent_height.is_some())
            .map(|rec| rec.coin.to_coin_id())
            .collect();
        for tx in self.submitted.iter_mut() {
            if !tx.landed
                && tx
                    .expected_output_coins
                    .iter()
                    .any(|coin| observed_created.contains(coin))
            {
                tx.landed = true;
            }
        }
        if !spent_inputs.is_empty() {
            self.submitted.retain(|tx| {
                let spends_observed_input = tx
                    .spent_coin_ids
                    .iter()
                    .any(|coin_id| spent_inputs.contains(coin_id));
                !spends_observed_input || tx.landed || tx.expected_output_coins.is_empty()
            });
        }

        // Created/deleted are the symmetric difference against the previous
        // report. The resulting observations are ordered as every creation,
        // then every spend, before the cradle receives the height callback.
        let mut created_watched: std::collections::HashSet<CoinString> = present_now
            .difference(&self.present_coins)
            .cloned()
            .collect();
        let mut deleted_watched: std::collections::HashSet<CoinString> = self
            .present_coins
            .difference(&present_now)
            .cloned()
            .collect();
        self.present_coins = present_now;

        // A coin whose creation was rolled back by a reorg (flagged vanished by
        // the rollback branch above) left the live set without being spent.  It
        // must not be treated as deleted: the inner cradle maps deleted_watched
        // to coin_spent, which for a tracked game coin requests a puzzle and
        // solution that does not exist and drives a spurious EndedError.  Drop
        // such coins here so they are neither recorded as spent below nor
        // forwarded to the cradle; their re-creation is handled by resubmitting
        // the creating transaction.
        deleted_watched.retain(|coin| !self.vanished_coins.contains(coin));

        // Coins first observed already-spent never entered the live set, so the
        // present->absent diff above cannot surface them.  They carry a real
        // spend height (not a reorg rollback), so merge them in after the
        // vanished retain.  Without this, a handler waiting on such a coin -- an
        // opponent-published unroll coin spent before our first poll of it --
        // never receives coin_spent and stalls forever.
        //
        // We emit each such coin in BOTH created_watched and deleted_watched so
        // subscribers see a created-then-spent pair, processed sequentially.
        // Handlers that only do real work on creation (the handshake handlers,
        // which transition to OffChainPhase on coin_created) would otherwise
        // miss the channel coin entirely when it jumps straight to spent, never
        // transition, and never handle the spend.  They are deliberately NOT
        // added to present_coins: they are already spent and must not be tracked
        // as live.
        for coin in first_seen_spent {
            created_watched.insert(coin.clone());
            deleted_watched.insert(coin);
        }

        // A watched coin leaving the live set during forward progress is a
        // spend.  Some feeds (the full coin set) omit spent coins rather than
        // reporting a spend height, so fall back to the current height as a
        // lower bound.
        for coin in deleted_watched.iter() {
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

        self.report_timeout_claim_rearms(rearmed_timeout_claims)?;

        self.reconcile_timeout_claim_status()?;
        self.evaluate_mature_timeout_claims(height)?;

        let observations = created_watched
            .into_iter()
            .map(CoinObservation::Created)
            .chain(deleted_watched.into_iter().map(CoinObservation::Spent))
            .collect::<Vec<_>>();

        self.cradle
            .session_observe(allocator, height, Some(&observations))?;

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
            let mut resubmit: Option<(SpendBundle, Option<u64>)> = None;
            self.submitted.retain(|tx| {
                if !tx.spent_coin_ids.contains(&parent) {
                    return true;
                }
                if matches!(tx.expiry, Some(e) if height >= e + CHANNEL_EXPIRY_BUFFER) {
                    return false;
                }
                resubmit = Some((tx.bundle.clone(), tx.expiry));
                true
            });
            if let Some(submission) = resubmit {
                self.pending_submissions.push(submission);
            }
        }
    }

    /// Drop coins whose confirmed spend is buried at least `confirmation_depth`
    /// blocks deep, so a reorg can no longer revert it.  Stops the host from
    /// polling terminal coins, and prunes any retained submission that spends a
    /// now-irreversibly-spent coin: once a coin's spend is buried, every tracked
    /// transaction spending that coin is terminal -- either it is our own spend
    /// (it succeeded) or a conflicting spend won (ours can never be included) --
    /// so it never needs resubmission again.
    fn evict_confirmed_spends(&mut self, height: u64) {
        let depth = self.confirmation_depth;
        let mut evicted = Vec::new();
        self.watched_coins.retain(|coin, w| {
            // No overflow: `height` and `spent_confirmed_at` (`s`) are bounded by
            // MAX_REPORTED_HEIGHT at ingestion (see report_coin_states), and
            // `depth` is the small constant confirmation depth, so this sum stays
            // far below u64::MAX. checked_add is intentionally omitted.
            let buried = matches!(w.spent_confirmed_at, Some(s) if s + depth <= height);
            if buried {
                evicted.push(coin.clone());
            }
            !buried
        });
        for coin in evicted {
            self.present_coins.remove(&coin);
            self.vanished_coins.remove(&coin);
            let coin_id = coin.to_coin_id();
            self.submitted
                .retain(|tx| !tx.spent_coin_ids.contains(&coin_id));
            self.pending_unwatch_coins.push(coin);
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
        let result = self.cradle.session_flush_and_collect(allocator)?;
        if result.resync.is_some() {
            self.pending_resync = result.resync;
        }
        if self.cradle.is_abandoned() {
            self.discard_local_artifacts();
        }
        self.absorb_events(result.events);
        Ok(ManagerDrain {
            events: std::mem::take(&mut self.pending_events),
            watch_coins: std::mem::take(&mut self.pending_watch_coins),
            unwatch_coins: std::mem::take(&mut self.pending_unwatch_coins),
            resync: self.pending_resync.take(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::constants::CREATE_COIN;
    use crate::common::types::{
        Amount, CoinID, CoinSpend, Hash, Program, Puzzle, PuzzleHash, Spend, ToQuotedProgram,
    };
    use crate::session_phases::effects::{GameSessionEvent, TimeoutClaimSemantic};
    use clvm_traits::ToClvm;

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

    fn test_bundle_spending_creating(
        name: &str,
        input: &CoinString,
        output: &CoinString,
    ) -> SpendBundle {
        let mut allocator = AllocEncoder::new();
        let (_, output_ph, output_amount) = output.to_parts().expect("valid output coin");
        let conditions = [(CREATE_COIN, (output_ph, (output_amount, ())))];
        let conditions_node = conditions.to_clvm(&mut allocator).expect("conditions");
        let puzzle = conditions_node
            .to_quoted_program(&mut allocator)
            .expect("quoted puzzle");
        SpendBundle {
            name: Some(name.to_string()),
            spends: vec![CoinSpend {
                coin: input.clone(),
                bundle: Spend {
                    puzzle: Puzzle::from(puzzle),
                    solution: Program::from_bytes(&[0x80]).into(),
                    signature: Default::default(),
                },
            }],
        }
    }

    /// A scriptable cradle for exercising the manager in isolation.  Each call
    /// to `session_flush_and_collect` returns the next queued `DrainResult`.
    #[derive(Default)]
    struct MockGameSession {
        /// Reports seen via `session_new_block`, for assertions.
        seen_observations: Vec<(u64, Vec<CoinObservation>)>,
        /// Pre-scripted drains, returned in order.
        scripted_drains: std::collections::VecDeque<DrainResult>,
        submitted_timeout_claims: Vec<TimeoutClaimSemantic>,
        rearmed_timeout_claims: Vec<TimeoutClaimSemantic>,
        abandoned: bool,
    }

    impl MockGameSession {
        fn queue_drain(&mut self, events: Vec<GameSessionEvent>) {
            self.scripted_drains.push_back(DrainResult {
                events: events.into_iter().collect(),
                resync: None,
            });
        }

        fn queue_drain_with_resync(
            &mut self,
            events: Vec<GameSessionEvent>,
            resync: (usize, bool),
        ) {
            self.scripted_drains.push_back(DrainResult {
                events: events.into_iter().collect(),
                resync: Some(resync),
            });
        }
    }

    impl ManagedGameSession for MockGameSession {
        fn session_observe(
            &mut self,
            _allocator: &mut AllocEncoder,
            height: u64,
            observations: Option<&[CoinObservation]>,
        ) -> Result<(), Error> {
            self.seen_observations
                .push((height, observations.unwrap_or_default().to_vec()));
            Ok(())
        }

        fn session_flush_and_collect(
            &mut self,
            _allocator: &mut AllocEncoder,
        ) -> Result<DrainResult, Error> {
            Ok(self.scripted_drains.pop_front().unwrap_or_default())
        }

        fn session_timeout_claim_submitted(
            &mut self,
            semantic: TimeoutClaimSemantic,
        ) -> Result<(), Error> {
            self.submitted_timeout_claims.push(semantic);
            Ok(())
        }

        fn session_timeout_claim_rearmed(
            &mut self,
            semantic: TimeoutClaimSemantic,
        ) -> Result<(), Error> {
            self.rearmed_timeout_claims.push(semantic);
            Ok(())
        }

        fn is_abandoned(&self) -> bool {
            self.abandoned
        }
    }

    #[derive(Default, Serialize, Deserialize)]
    struct PersistableMockGameSession;

    impl ManagedGameSession for PersistableMockGameSession {
        fn session_observe(
            &mut self,
            _allocator: &mut AllocEncoder,
            _height: u64,
            _observations: Option<&[CoinObservation]>,
        ) -> Result<(), Error> {
            Ok(())
        }

        fn session_flush_and_collect(
            &mut self,
            _allocator: &mut AllocEncoder,
        ) -> Result<DrainResult, Error> {
            Ok(DrainResult::default())
        }
    }

    #[derive(Default, Serialize, Deserialize)]
    struct RestoreMockGameSession {
        submitted_timeout_claims: Vec<TimeoutClaimSemantic>,
    }

    impl ManagedGameSession for RestoreMockGameSession {
        fn session_observe(
            &mut self,
            _allocator: &mut AllocEncoder,
            _height: u64,
            _observations: Option<&[CoinObservation]>,
        ) -> Result<(), Error> {
            Ok(())
        }

        fn session_flush_and_collect(
            &mut self,
            _allocator: &mut AllocEncoder,
        ) -> Result<DrainResult, Error> {
            Ok(DrainResult::default())
        }

        fn session_timeout_claim_submitted(
            &mut self,
            semantic: TimeoutClaimSemantic,
        ) -> Result<(), Error> {
            self.submitted_timeout_claims.push(semantic);
            Ok(())
        }
    }

    fn watch_event(coin: &CoinString, timeout: u64) -> GameSessionEvent {
        GameSessionEvent::WatchCoin {
            coin_name: coin.to_coin_id(),
            coin_string: coin.clone(),
            timeout: Timeout::new(timeout),
            spend: None,
            semantic: None,
        }
    }

    /// A `WatchCoin` event that also registers an eager timeout spend.
    fn watch_event_with_spend(
        coin: &CoinString,
        timeout: u64,
        spend: SpendBundle,
    ) -> GameSessionEvent {
        GameSessionEvent::WatchCoin {
            coin_name: coin.to_coin_id(),
            coin_string: coin.clone(),
            timeout: Timeout::new(timeout),
            spend: Some(spend),
            semantic: None,
        }
    }

    fn watch_event_with_timeout_semantic(
        coin: &CoinString,
        timeout: u64,
        spend: SpendBundle,
        semantic: TimeoutClaimSemantic,
    ) -> GameSessionEvent {
        GameSessionEvent::WatchCoin {
            coin_name: coin.to_coin_id(),
            coin_string: coin.clone(),
            timeout: Timeout::new(timeout),
            spend: Some(spend),
            semantic: Some(semantic),
        }
    }

    #[test]
    fn intercepts_watch_coin_and_tracks_timeout() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(1);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![watch_event(&coin, 100)]);
        let mut mgr = TransactionManager::new(mock);

        let drain = mgr.flush_and_collect(&mut allocator).expect("drain");

        // WatchCoin is intercepted, not forwarded.
        assert!(drain.events.is_empty());
        assert_eq!(drain.watch_coins, vec![coin.clone()]);
        let watched = mgr.watched_coin(&coin).expect("tracked");
        assert_eq!(watched.timeout_blocks, Timeout::new(100));
        assert_eq!(watched.birthday, None);
        assert_eq!(mgr.snapshot_watched_coins(), vec![coin]);
    }

    #[test]
    fn intercepts_outbound_transaction_into_submissions() {
        let mut allocator = AllocEncoder::new();
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![
            GameSessionEvent::OutboundTransaction(test_bundle("tx-a"), None),
            GameSessionEvent::Log("kept".to_string()),
        ]);
        let mut mgr = TransactionManager::new(mock);

        let drain = mgr.flush_and_collect(&mut allocator).expect("drain");

        // The log is forwarded; the transaction is intercepted.
        assert_eq!(drain.events.len(), 1);
        assert!(matches!(drain.events[0], GameSessionEvent::Log(_)));
        let subs = mgr.drain_submissions().unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].name.as_deref(), Some("tx-a"));
        // Draining empties the buffer.
        assert!(mgr.drain_submissions().unwrap().is_empty());
    }

    #[test]
    fn serialization_prunes_transient_event_and_watch_delivery_queues() {
        let coin = test_coin(2);
        let mut mgr = TransactionManager::new(PersistableMockGameSession);
        mgr.pending_events
            .push_back(GameSessionEvent::Log("transient".to_string()));
        mgr.pending_watch_coins.push(coin);
        mgr.pending_unwatch_coins.push(test_coin(3));
        mgr.pending_resync = Some((7, true));

        let encoded = bencodex::to_vec(&mgr).expect("serialize manager");
        let decoded: TransactionManager<PersistableMockGameSession> =
            bencodex::from_slice(&encoded).expect("deserialize manager");

        assert!(decoded.pending_events.is_empty());
        assert!(decoded.pending_watch_coins.is_empty());
        assert!(decoded.pending_unwatch_coins.is_empty());
        assert_eq!(decoded.pending_resync, None);
    }

    #[test]
    fn records_birthday_and_spend_and_emits_diff() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(2);
        let mut mock = MockGameSession::default();
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

        let observations = &mgr.cradle().seen_observations;
        assert_eq!(observations.len(), 3);
        // Block 10: created only.
        assert_eq!(
            observations[0].1,
            vec![CoinObservation::Created(coin.clone())]
        );
        // Block 12: nothing new.
        assert!(observations[1].1.is_empty());
        // Block 20: deleted only.
        assert_eq!(
            observations[2].1,
            vec![CoinObservation::Spent(coin.clone())]
        );
        assert_eq!(mgr.last_height(), 20);
    }

    #[test]
    fn height_only_observation_preserves_snapshot_reorg_detection() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(13);
        let mut mock = MockGameSession::default();
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
        .expect("authoritative snapshot");
        assert_eq!(mgr.watched_coin(&coin).unwrap().birthday, Some(10));

        // A trusted peak can advance handler clocks while the coin snapshot is
        // unavailable. It must not become the baseline that hides a later
        // rollback in the next authoritative snapshot.
        mgr.report_height(&mut allocator, 15)
            .expect("height-only observation");
        assert_eq!(mgr.last_height(), 15);
        assert_eq!(mgr.watched_coin(&coin).unwrap().birthday, Some(10));

        mgr.report_coin_states(&mut allocator, 8, &[])
            .expect("rolled-back snapshot");
        assert_eq!(mgr.watched_coin(&coin).unwrap().birthday, None);
        assert!(mgr.vanished_coins().contains(&coin));
    }

    #[test]
    fn does_not_track_unwatched_coins_but_forwards_observation() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(3);
        let mut mgr = TransactionManager::new(MockGameSession::default());

        let records = vec![CoinStateRecord {
            coin: coin.clone(),
            created_height: Some(5),
            spent_height: None,
        }];
        mgr.report_coin_states(&mut allocator, 5, &records)
            .expect("report");

        // The manager does not add bookkeeping for coins it was not told to
        // watch, but still forwards the raw creation observation. The cradle
        // has no duplicate watch registry; its active phase decides relevance.
        assert!(mgr.watched_coin(&coin).is_none());
        let observations = &mgr.cradle().seen_observations;
        assert_eq!(observations, &[(5, vec![CoinObservation::Created(coin)])]);
    }

    #[test]
    fn eager_timeout_spend_submitted_once_at_maturity() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(10);
        let claim = test_bundle("timeout-claim");
        let mut mock = MockGameSession::default();
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
        assert!(mgr.drain_submissions().unwrap().is_empty());

        // At maturity (10 + 5 = 15): the eager claim is queued exactly once.
        mgr.report_coin_states(&mut allocator, 15, &live)
            .expect("report");
        let subs = mgr.drain_submissions().unwrap();
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].name.as_deref(), Some("timeout-claim"));

        // Still mature next block, but already submitted for this birthday.
        mgr.report_coin_states(&mut allocator, 16, &live)
            .expect("report");
        assert!(mgr.drain_submissions().unwrap().is_empty());
    }

    #[test]
    fn mature_semantic_timeout_claim_updates_canonical_session_state() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(11);
        let claim = test_bundle("channel-timeout-claim");
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::WatchCoin {
            coin_name: coin.to_coin_id(),
            coin_string: coin.clone(),
            timeout: Timeout::new(5),
            spend: Some(claim),
            semantic: Some(TimeoutClaimSemantic::ChannelTimeoutFinish),
        }]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");

        let live = vec![CoinStateRecord {
            coin: coin.clone(),
            created_height: Some(10),
            spent_height: None,
        }];
        mgr.report_coin_states(&mut allocator, 15, &live)
            .expect("mature claim");

        assert_eq!(
            mgr.cradle().submitted_timeout_claims,
            vec![TimeoutClaimSemantic::ChannelTimeoutFinish]
        );
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);
    }

    #[test]
    fn height_only_report_matures_known_timeout_claim() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(14);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::WatchCoin {
            coin_name: coin.to_coin_id(),
            coin_string: coin.clone(),
            timeout: Timeout::new(5),
            spend: Some(test_bundle("height-only-timeout")),
            semantic: Some(TimeoutClaimSemantic::ChannelTimeoutFinish),
        }]);
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
        .expect("observe birthday");

        mgr.report_height(&mut allocator, 15)
            .expect("height-only maturity");
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);
        assert_eq!(
            mgr.cradle().submitted_timeout_claims,
            vec![TimeoutClaimSemantic::ChannelTimeoutFinish]
        );
    }

    #[test]
    fn height_only_tip_rollback_rearms_submitted_timeout_claim() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(16);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::WatchCoin {
            coin_name: coin.to_coin_id(),
            coin_string: coin.clone(),
            timeout: Timeout::new(5),
            spend: Some(test_bundle("height-only-reorg")),
            semantic: Some(TimeoutClaimSemantic::ChannelTimeoutFinish),
        }]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");
        let live = [CoinStateRecord {
            coin: coin.clone(),
            created_height: Some(10),
            spent_height: None,
        }];
        mgr.report_coin_states(&mut allocator, 10, &live)
            .expect("observe birthday");
        mgr.report_height(&mut allocator, 15).expect("mature");
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);

        mgr.report_height(&mut allocator, 14)
            .expect("height-only rollback");
        assert_eq!(
            mgr.cradle().rearmed_timeout_claims,
            vec![TimeoutClaimSemantic::ChannelTimeoutFinish]
        );
        assert!(mgr.drain_submissions().unwrap().is_empty());

        mgr.report_height(&mut allocator, 15)
            .expect("recover maturity");
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);
    }

    #[test]
    fn height_then_same_tip_snapshot_consumes_one_timeout_rollback_epoch() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(18);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::WatchCoin {
            coin_name: coin.to_coin_id(),
            coin_string: coin.clone(),
            timeout: Timeout::new(4),
            spend: Some(test_bundle("single-rollback-epoch")),
            semantic: Some(TimeoutClaimSemantic::ChannelTimeoutFinish),
        }]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");
        let live = [CoinStateRecord {
            coin: coin.clone(),
            created_height: Some(10),
            spent_height: None,
        }];
        mgr.report_coin_states(&mut allocator, 15, &live)
            .expect("mature initial claim");
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);

        // Production first observes the lower trusted tip, then reconciles the
        // same tip from the complete coin snapshot. Height 14 is still mature,
        // so the first report re-arms and requeues exactly one claim.
        mgr.report_height(&mut allocator, 14)
            .expect("lowered height");
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);
        mgr.report_coin_states(&mut allocator, 14, &live)
            .expect("same-tip snapshot");
        assert!(mgr.drain_submissions().unwrap().is_empty());
        assert_eq!(
            mgr.cradle().rearmed_timeout_claims,
            vec![TimeoutClaimSemantic::ChannelTimeoutFinish]
        );
        assert_eq!(
            mgr.cradle().submitted_timeout_claims,
            vec![
                TimeoutClaimSemantic::ChannelTimeoutFinish,
                TimeoutClaimSemantic::ChannelTimeoutFinish,
            ]
        );
    }

    #[test]
    fn confirmed_timeout_spend_rollback_rearms_and_resubmits() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(17);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::WatchCoin {
            coin_name: coin.to_coin_id(),
            coin_string: coin.clone(),
            timeout: Timeout::new(5),
            spend: Some(test_bundle("confirmed-spend-reorg")),
            semantic: Some(TimeoutClaimSemantic::ChannelTimeoutFinish),
        }]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");
        let live = [CoinStateRecord {
            coin: coin.clone(),
            created_height: Some(10),
            spent_height: None,
        }];
        mgr.report_coin_states(&mut allocator, 15, &live)
            .expect("mature");
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);

        mgr.report_coin_states(
            &mut allocator,
            16,
            &[CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(10),
                spent_height: Some(16),
            }],
        )
        .expect("confirm timeout spend");
        assert_eq!(
            mgr.watched_coin(&coin).unwrap().spent_confirmed_at,
            Some(16)
        );

        mgr.report_coin_states(&mut allocator, 14, &live)
            .expect("rollback confirmed spend");
        assert_eq!(mgr.watched_coin(&coin).unwrap().spent_confirmed_at, None);
        assert_eq!(
            mgr.cradle().rearmed_timeout_claims,
            vec![TimeoutClaimSemantic::ChannelTimeoutFinish]
        );
        assert!(mgr.drain_submissions().unwrap().is_empty());

        mgr.report_coin_states(&mut allocator, 15, &live)
            .expect("recover maturity");
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);
    }

    #[test]
    fn restored_submitted_claim_reprojects_canonical_timeout_status() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(15);
        let mut mgr = TransactionManager::new(RestoreMockGameSession::default());
        mgr.watched_coins.insert(
            coin.clone(),
            WatchedCoin {
                coin,
                timeout_blocks: Timeout::new(5),
                name: None,
                birthday: Some(10),
                spent_confirmed_at: None,
                claim_submitted: true,
                timeout_spend: Some(test_bundle("restored-timeout")),
                timeout_claim_semantic: Some(TimeoutClaimSemantic::ChannelTimeoutFinish),
                creation_spend: None,
            },
        );

        let bytes = bencodex::to_vec(&mgr).expect("serialize restored manager");
        let mut restored: TransactionManager<RestoreMockGameSession> =
            bencodex::from_slice(&bytes).expect("restore manager");
        restored
            .report_height(&mut allocator, 15)
            .expect("reconcile restored timeout status");

        assert_eq!(
            restored.cradle().submitted_timeout_claims,
            vec![TimeoutClaimSemantic::ChannelTimeoutFinish]
        );
        assert!(restored.drain_submissions().unwrap().is_empty());
    }

    #[test]
    fn semantic_timeout_claim_rearms_after_reorg_and_resubmits() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(12);
        let claim = test_bundle("channel-timeout-claim");
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::WatchCoin {
            coin_name: coin.to_coin_id(),
            coin_string: coin.clone(),
            timeout: Timeout::new(5),
            spend: Some(claim),
            semantic: Some(TimeoutClaimSemantic::ChannelTimeoutFinish),
        }]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");

        let record = |created_height| {
            vec![CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(created_height),
                spent_height: None,
            }]
        };
        mgr.report_coin_states(&mut allocator, 10, &record(10))
            .expect("created");
        mgr.report_coin_states(&mut allocator, 15, &record(10))
            .expect("mature");
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);
        assert_eq!(
            mgr.cradle().submitted_timeout_claims,
            vec![TimeoutClaimSemantic::ChannelTimeoutFinish]
        );

        // The coin is re-mined later after a rollback: canonical progress must
        // return to waiting before it can be submitted again at its new age.
        mgr.report_coin_states(&mut allocator, 13, &record(13))
            .expect("reorged birthday");
        assert_eq!(
            mgr.cradle().rearmed_timeout_claims,
            vec![TimeoutClaimSemantic::ChannelTimeoutFinish]
        );
        mgr.report_coin_states(&mut allocator, 18, &record(13))
            .expect("re-mature");
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);
        assert_eq!(
            mgr.cradle().submitted_timeout_claims,
            vec![
                TimeoutClaimSemantic::ChannelTimeoutFinish,
                TimeoutClaimSemantic::ChannelTimeoutFinish,
            ]
        );
    }

    #[test]
    fn same_birthday_rollback_rearms_semantic_timeout_claim() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(13);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::WatchCoin {
            coin_name: coin.to_coin_id(),
            coin_string: coin.clone(),
            timeout: Timeout::new(5),
            spend: Some(test_bundle("channel-timeout-claim")),
            semantic: Some(TimeoutClaimSemantic::ChannelTimeoutFinish),
        }]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");
        let record = vec![CoinStateRecord {
            coin: coin.clone(),
            created_height: Some(10),
            spent_height: None,
        }];

        mgr.report_coin_states(&mut allocator, 15, &record)
            .expect("mature");
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);

        // The rollback report preserves birthday 10, but must still invalidate
        // the prior maturity observation and canonical submitting state.
        mgr.report_coin_states(&mut allocator, 14, &record)
            .expect("same-birthday rollback");
        assert_eq!(
            mgr.cradle().rearmed_timeout_claims,
            vec![TimeoutClaimSemantic::ChannelTimeoutFinish]
        );
        assert!(mgr.drain_submissions().unwrap().is_empty());

        mgr.report_coin_states(&mut allocator, 15, &record)
            .expect("re-mature");
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);
    }

    #[test]
    fn mature_game_timeout_claim_emits_semantic_notification() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(12);
        let game_id = crate::common::types::GameID(42);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![watch_event_with_timeout_semantic(
            &coin,
            5,
            test_bundle("timeout-claim"),
            TimeoutClaimSemantic::GameOpponentTurn { id: game_id },
        )]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");

        let live = vec![CoinStateRecord {
            coin,
            created_height: Some(10),
            spent_height: None,
        }];
        mgr.report_coin_states(&mut allocator, 15, &live)
            .expect("mature claim");

        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);
        let drain = mgr
            .flush_and_collect(&mut allocator)
            .expect("drain notification");
        assert!(matches!(
            drain.events.as_slices(),
            ([GameSessionEvent::Notification(
                GameNotification::TimeoutClaimSubmitted(
                    TimeoutClaimSemantic::GameOpponentTurn { id }
                )
            )], []) if *id == game_id
        ));
    }

    #[test]
    fn eager_timeout_spend_resubmitted_after_birthday_rollback() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(11);
        let claim = test_bundle("timeout-claim");
        let mut mock = MockGameSession::default();
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
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);

        // Reorg re-mines the coin at birthday 13: the claim re-arms and is
        // resubmitted once it matures again at 18.
        mgr.report_coin_states(&mut allocator, 12, &rec(13))
            .expect("report");
        assert!(mgr.drain_submissions().unwrap().is_empty());
        mgr.report_coin_states(&mut allocator, 18, &rec(13))
            .expect("report");
        let resub = mgr.drain_submissions().unwrap();
        assert_eq!(resub.len(), 1);
        assert_eq!(resub[0].name.as_deref(), Some("timeout-claim"));
    }

    #[test]
    fn eager_timeout_spend_not_submitted_if_coin_already_spent() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(12);
        let claim = test_bundle("timeout-claim");
        let mut mock = MockGameSession::default();
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
        assert!(mgr.drain_submissions().unwrap().is_empty());
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

        let mut mock = MockGameSession::default();
        // The cradle wants to watch the child and submits the creating tx.
        mock.queue_drain(vec![
            watch_event(&child, 50),
            GameSessionEvent::OutboundTransaction(creating_tx.clone(), None),
        ]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");

        // The host submits the creating tx; the manager remembers it.
        let submitted = mgr.drain_submissions().unwrap();
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
        assert!(mgr.drain_submissions().unwrap().is_empty());

        // Reorg to height 8 rolls back the child's creating block.  The manager
        // flags it vanished and re-queues the creating transaction.
        mgr.report_coin_states(&mut allocator, 8, &[])
            .expect("report");
        assert!(mgr.vanished_coins().contains(&child));
        let resubmitted = mgr.drain_submissions().unwrap();
        assert_eq!(resubmitted.len(), 1);
        assert_eq!(resubmitted[0].name.as_deref(), Some("create-child"));
    }

    #[test]
    fn submitted_outputs_are_not_poll_targets_unless_registered() {
        let mut allocator = AllocEncoder::new();
        let parent = test_coin(22);
        let protocol_child = CoinString::from_parts(
            &parent.to_coin_id(),
            &PuzzleHash::from_bytes([23; 32]),
            &Amount::new(1),
        );
        let untracked_child = CoinString::from_parts(
            &parent.to_coin_id(),
            &PuzzleHash::from_bytes([24; 32]),
            &Amount::new(1),
        );
        let creating_tx =
            test_bundle_spending_creating("create-untracked-child", &parent, &untracked_child);

        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![
            watch_event(&protocol_child, 50),
            GameSessionEvent::OutboundTransaction(creating_tx, None),
        ]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);

        // Retained transaction outputs are replay/conflict metadata. They do
        // not become host poll targets unless a protocol handler explicitly
        // registers them as watched coins.
        let poll_set = mgr.snapshot_watched_coins();
        assert!(poll_set.contains(&protocol_child));
        assert!(!poll_set.contains(&untracked_child));
    }

    #[test]
    fn out_of_range_height_is_rejected_without_touching_state() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(7);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![watch_event(&coin, 50)]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");

        // A tip height above the ceiling is rejected and leaves state untouched.
        assert!(mgr
            .report_coin_states(&mut allocator, MAX_REPORTED_HEIGHT + 1, &[])
            .is_err());
        assert_eq!(mgr.last_height(), 0);

        // A per-coin height above the ceiling is rejected too.
        assert!(mgr
            .report_coin_states(
                &mut allocator,
                100,
                &[CoinStateRecord {
                    coin: coin.clone(),
                    created_height: Some(MAX_REPORTED_HEIGHT + 1),
                    spent_height: None,
                }],
            )
            .is_err());
        assert_eq!(mgr.last_height(), 0);
        assert_eq!(mgr.watched_coin(&coin).unwrap().birthday, None);

        // The ceiling itself is accepted.
        mgr.report_coin_states(&mut allocator, MAX_REPORTED_HEIGHT, &[])
            .expect("boundary height accepted");
        assert_eq!(mgr.last_height(), MAX_REPORTED_HEIGHT);
    }

    #[test]
    fn reorg_resets_creation_and_spend_above_new_tip() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(4);
        let mut mock = MockGameSession::default();
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
        let mut mock = MockGameSession::default();
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
    fn reorg_vanished_coin_is_not_forwarded_as_deleted() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(8);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![watch_event(&coin, 50)]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");

        // Coin confirmed live at height 12.
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

        // Reorg below the creation height: the coin vanishes from the feed.  It
        // was un-created, not spent, so it must NOT be forwarded to the inner
        // cradle as a spend observation (which would drive a
        // spurious EndedError for a tracked game coin).
        mgr.report_coin_states(&mut allocator, 8, &[])
            .expect("report");
        assert!(mgr.vanished_coins().contains(&coin));

        let observations = &mgr.cradle().seen_observations;
        // Block 12: created.
        assert_eq!(
            observations[0].1,
            vec![CoinObservation::Created(coin.clone())]
        );
        // Block 8 (reorg): neither created nor deleted -- the vanish is
        // suppressed from the forwarded observations.
        assert_eq!(observations[1], (8, vec![]));
        // The coin's spend was not recorded either.
        assert_eq!(mgr.watched_coin(&coin).unwrap().spent_confirmed_at, None);
    }

    #[test]
    fn reorg_remine_in_same_report_clears_vanished_and_allows_later_spend() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(9);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![watch_event(&coin, 50)]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");

        // Confirmed live at height 12.
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

        // Reorg to height 8 (< last height 12), but the coin is re-mined at 8 in
        // the SAME report.  Its old birthday (12) is above the new tip, so the
        // rollback branch flags it vanished; yet because it is still live here it
        // never leaves `present_coins` and so never appears in the created
        // set-diff.  It must still be un-flagged, or a later genuine spend would
        // be suppressed.
        mgr.report_coin_states(
            &mut allocator,
            8,
            &[CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(8),
                spent_height: None,
            }],
        )
        .expect("report");
        assert_eq!(mgr.watched_coin(&coin).unwrap().birthday, Some(8));
        assert!(
            !mgr.vanished_coins().contains(&coin),
            "a coin re-mined in the same reorg report must not stay flagged vanished"
        );

        // Forward progress: the coin is now genuinely spent (drops off the
        // full-coin-set feed).  Since it is no longer flagged vanished, the spend
        // must be forwarded as a spend observation and recorded.
        mgr.report_coin_states(&mut allocator, 9, &[])
            .expect("report");
        assert_eq!(mgr.watched_coin(&coin).unwrap().spent_confirmed_at, Some(9));
        let spend_observations = mgr
            .cradle()
            .seen_observations
            .last()
            .expect("spend observations");
        assert_eq!(spend_observations, &(9, vec![CoinObservation::Spent(coin)]));
    }

    #[test]
    fn forward_progress_disappearance_is_a_spend_not_a_vanish() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(6);
        let mut mock = MockGameSession::default();
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
    fn coin_first_seen_already_spent_is_forwarded_as_spend() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(40);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![watch_event(&coin, 50)]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");

        // The coin's FIRST observation already shows it spent: the record carries
        // both a creation and a spend height.  This happens when the coin is
        // created and spent within a single inter-poll gap, or when we only learn
        // to watch it (e.g. an opponent-published unroll coin) after it was
        // already spent.  Because the coin was never recorded as present, a pure
        // present->absent set difference would miss it -- but the manager must
        // still forward it as a spend, or a handler waiting on the coin (e.g.
        // SpendChannelCoinPhase in UnrollSpend) never learns it resolved.
        mgr.report_coin_states(
            &mut allocator,
            12,
            &[CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(10),
                spent_height: Some(12),
            }],
        )
        .expect("report");

        let observations = mgr
            .cradle()
            .seen_observations
            .last()
            .expect("an observation batch");
        assert_eq!(observations.0, 12);
        assert_eq!(
            observations.1,
            vec![
                CoinObservation::Created(coin.clone()),
                CoinObservation::Spent(coin.clone()),
            ],
            "a coin first seen already-spent must be emitted created then spent"
        );
        assert_eq!(
            mgr.watched_coin(&coin).unwrap().spent_confirmed_at,
            Some(12)
        );
    }

    #[test]
    fn spent_coin_evicted_after_confirmation_depth() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(7);
        let mut mock = MockGameSession::default();
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
        assert!(mgr.snapshot_watched_coins().is_empty());
        let drain = mgr
            .flush_and_collect(&mut allocator)
            .expect("drain eviction");
        assert_eq!(drain.unwatch_coins, vec![coin]);
        assert!(mgr
            .flush_and_collect(&mut allocator)
            .expect("second drain")
            .unwatch_coins
            .is_empty());
    }

    #[test]
    fn surfaces_resync_signal() {
        let mut allocator = AllocEncoder::new();
        let mut mock = MockGameSession::default();
        mock.queue_drain_with_resync(vec![], (7, true));
        let mut mgr = TransactionManager::new(mock);

        let drain = mgr.flush_and_collect(&mut allocator).expect("drain");
        assert_eq!(drain.resync, Some((7, true)));
        // Subsequent drains do not repeat the resync.
        let drain = mgr.flush_and_collect(&mut allocator).expect("drain");
        assert_eq!(drain.resync, None);
    }

    #[test]
    fn requeue_submitted_replays_retained_transactions() {
        let mut allocator = AllocEncoder::new();
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::OutboundTransaction(
            test_bundle("tx-a"),
            None,
        )]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");

        // The host drains it once; the manager retains it for replay.
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);
        // A fresh drain is empty -- the pending buffer was emptied.
        assert!(mgr.drain_submissions().unwrap().is_empty());

        // On reload, requeue replays the retained set so any transaction that
        // was drained but may not have reached the network is submitted again.
        mgr.requeue_submitted();
        let replay = mgr.drain_submissions().unwrap();
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].name.as_deref(), Some("tx-a"));
    }

    #[test]
    fn requeue_submitted_discards_expired_transactions() {
        let mut allocator = AllocEncoder::new();
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::OutboundTransaction(
            test_bundle("expired"),
            Some(10),
        )]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);

        mgr.last_height = 10;
        mgr.requeue_submitted();
        assert!(mgr.drain_submissions().unwrap().is_empty());
        assert!(mgr.submitted.is_empty());
    }

    #[test]
    fn conflicting_spend_prunes_retained_submission_immediately() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(30);
        let child = CoinString::from_parts(
            &coin.to_coin_id(),
            &PuzzleHash::from_bytes([31; 32]),
            &Amount::new(1),
        );
        let spend_tx = test_bundle_spending_creating("spend-coin", &coin, &child);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![
            watch_event(&coin, 50),
            GameSessionEvent::OutboundTransaction(spend_tx.clone(), None),
        ]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");

        // Host submits the spend; the manager retains it.
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);
        assert!(!mgr.snapshot_watched_coins().contains(&child));

        // The input is spent, but the retained tx's expected child did not
        // appear.  A conflicting transaction won, so this local intent must be
        // forgotten immediately rather than replayed on reload/reorg.
        mgr.report_coin_states(
            &mut allocator,
            12,
            &[CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(10),
                spent_height: Some(12),
            }],
        )
        .expect("report");
        mgr.requeue_submitted();
        assert!(mgr.drain_submissions().unwrap().is_empty());
    }

    #[test]
    fn winning_spend_retains_submission_for_replay() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(32);
        let child = CoinString::from_parts(
            &coin.to_coin_id(),
            &PuzzleHash::from_bytes([33; 32]),
            &Amount::new(1),
        );
        let spend_tx = test_bundle_spending_creating("spend-coin", &coin, &child);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![
            watch_event(&coin, 50),
            GameSessionEvent::OutboundTransaction(spend_tx.clone(), None),
        ]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);

        // The input is spent and the retained tx's expected child appears.  That
        // means this transaction won, so it stays retained for replay if a later
        // reload or reorg needs it.
        mgr.report_coin_states(
            &mut allocator,
            12,
            &[
                CoinStateRecord {
                    coin: coin.clone(),
                    created_height: Some(10),
                    spent_height: Some(12),
                },
                CoinStateRecord {
                    coin: child.clone(),
                    created_height: Some(12),
                    spent_height: None,
                },
            ],
        )
        .expect("report");
        mgr.requeue_submitted();
        let replay = mgr.drain_submissions().unwrap();
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].name.as_deref(), Some("spend-coin"));

        // Once the spent input is buried deeply enough, the input coin is evicted
        // and the winning transaction no longer needs to be retained.
        let depth = mgr.confirmation_depth();
        mgr.report_coin_states(&mut allocator, 12 + depth, &[])
            .expect("report");
        assert!(mgr.watched_coin(&coin).is_none());
        mgr.requeue_submitted();
        assert!(mgr.drain_submissions().unwrap().is_empty());
    }

    #[test]
    fn no_per_block_resubmission_of_unlanded_transactions() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(40);
        let child = CoinString::from_parts(
            &coin.to_coin_id(),
            &PuzzleHash::from_bytes([41; 32]),
            &Amount::new(1),
        );
        let spend_tx = test_bundle_spending_creating("spend-coin", &coin, &child);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![
            watch_event(&coin, 50),
            GameSessionEvent::OutboundTransaction(spend_tx.clone(), None),
        ]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");
        assert_eq!(mgr.drain_submissions().unwrap().len(), 1);

        // Subsequent blocks must not rebroadcast the transaction; the host
        // retries only on wallet reconnect via requeue_submitted.
        for height in 10..=12 {
            mgr.report_coin_states(
                &mut allocator,
                height,
                &[CoinStateRecord {
                    coin: coin.clone(),
                    created_height: Some(10),
                    spent_height: None,
                }],
            )
            .expect("report");
            assert!(
                mgr.drain_submissions().unwrap().is_empty(),
                "should not rebroadcast at height {height}",
            );
        }
    }
}
