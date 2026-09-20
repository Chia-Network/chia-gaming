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

use std::collections::{HashMap, HashSet};

use serde::de::DeserializeOwned;
use serde::{Deserialize, Serialize};

use crate::common::types::{
    aggregate_wallet_fee_bundle, AllocEncoder, CoinCondition, CoinID, CoinString, Error, Hash,
    Program, Sha256Input, SpendBundle, Timeout,
};
use crate::game_session::{CoinObservation, DrainResult, GameSession};
use crate::session_phases::effects::{
    AttachmentFailurePolicy, FeeConfiguration, FeePolicy, GameSessionEvent, GameSessionEventQueue,
    SubmissionFeeIntent, TimeoutClaimSemantic, TransactionSubmission,
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
    id: u64,
    /// Canonical identity of the exact Rust-owned submission intent. Bundle
    /// diagnostic metadata (`SpendBundle::name`) is deliberately excluded.
    intent_fingerprint: Hash,
    /// Canonical protocol bundle before any optional wallet fee source.
    base_bundle: SpendBundle,
    /// Exact bytes currently authorized for broadcast.
    current_variant: SubmissionBroadcastVariant,
    /// Fee acquisition progresses independently from wallet delivery.
    fee_intent: DurableFeeIntent,
    /// Exact variant last acknowledged by the submission adapter.
    wallet_acknowledged_variant: Option<Hash>,
    /// Chain evidence is independent from fee and wallet delivery state.
    chain_terminality: SubmissionChainTerminality,
    /// Coin ids this transaction spends.  An output coin's parent is one of
    /// these, which is how a vanished output is matched back to its creator.
    spent_coin_ids: Vec<CoinID>,
    /// Output coins this transaction should create, derived from its
    /// `CREATE_COIN` conditions.  These are replay/conflict metadata only:
    /// they do not become poll targets unless a protocol handler separately
    /// registers the coin as watched.
    expected_output_coins: Vec<CoinString>,
    /// Absolute height at/after which the transaction can no longer be included
    /// (from an `ASSERT_BEFORE_HEIGHT_ABSOLUTE`).  `None` means no expiry.
    expiry: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum SubmissionBroadcastVariant {
    Base,
    FeeBearing {
        bundle: SpendBundle,
        applied_fee: u64,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
enum DurableFeeIntent {
    Unresolved(SubmissionFeeIntent),
    Resolved {
        intent: SubmissionFeeIntent,
        resolution: FeeResolution,
    },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum FeeResolution {
    NotRequested,
    Attached,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
enum SubmissionChainTerminality {
    Active,
    Landed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct PendingSubmission {
    id: Option<u64>,
    submission: TransactionSubmission,
    fee_intent: SubmissionFeeIntent,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DrainedSubmission {
    pub id: u64,
    pub bundle: SpendBundle,
    pub expiry: Option<u64>,
    pub fee_intent: SubmissionFeeIntent,
    pub goal: SubmissionDeliveryGoal,
    pub intent_fingerprint: Hash,
    pub variant_fingerprint: Hash,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SubmissionDeliveryGoal {
    EnsureBroadcast,
    FeeUpgrade,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmissionDrainFailureStage {
    Fingerprint,
    RetainedState,
    ExpectedOutputs,
    SubmissionId,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SubmissionDrainFailure {
    pub candidate_index: u64,
    pub retained_submission_id: Option<u64>,
    pub candidate_submission_id: Option<u64>,
    pub intent_fingerprint: Option<Hash>,
    pub stage: SubmissionDrainFailureStage,
    pub message: String,
    pub rust_context: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SubmissionDrainResult {
    pub submissions: Vec<DrainedSubmission>,
    pub failures: Vec<SubmissionDrainFailure>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FinalizedSubmission {
    pub bundle: SpendBundle,
    pub applied_fee: u64,
    pub warning: Option<String>,
    pub fee_source_disposition: FeeSourceDisposition,
    pub variant_fingerprint: Hash,
    pub should_broadcast: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum FeeSourceDisposition {
    Attached,
    Unused,
    NotRequested,
}

pub enum SubmissionFeeSource {
    NotRequested,
    Available(SpendBundle),
    Failed(String),
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

fn submission_intent_fingerprint(
    submission: &TransactionSubmission,
    fee_intent: &SubmissionFeeIntent,
) -> Result<Hash, Error> {
    let canonical_bytes =
        bencodex::to_vec(&(&submission.bundle.spends, submission.expiry, fee_intent))
            .map_err(|e| Error::StrErr(format!("failed to encode transaction intent: {e}")))?;
    Ok(Sha256Input::Bytes(&canonical_bytes).hash())
}

fn submission_variant_fingerprint(bundle: &SpendBundle) -> Result<Hash, Error> {
    let canonical_bytes = bencodex::to_vec(&bundle.spends)
        .map_err(|e| Error::StrErr(format!("failed to encode transaction variant: {e}")))?;
    Ok(Sha256Input::Bytes(&canonical_bytes).hash())
}

impl SubmittedTx {
    fn current_bundle(&self) -> &SpendBundle {
        match &self.current_variant {
            SubmissionBroadcastVariant::Base => &self.base_bundle,
            SubmissionBroadcastVariant::FeeBearing { bundle, .. } => bundle,
        }
    }

    fn current_applied_fee(&self) -> u64 {
        match &self.current_variant {
            SubmissionBroadcastVariant::Base => 0,
            SubmissionBroadcastVariant::FeeBearing { applied_fee, .. } => *applied_fee,
        }
    }

    fn current_variant_fingerprint(&self) -> Result<Hash, Error> {
        submission_variant_fingerprint(self.current_bundle())
    }

    fn current_variant_acknowledged(&self) -> Result<bool, Error> {
        Ok(self.wallet_acknowledged_variant.as_ref() == Some(&self.current_variant_fingerprint()?))
    }

    fn unresolved_fee_intent(&self) -> Option<&SubmissionFeeIntent> {
        match &self.fee_intent {
            DurableFeeIntent::Unresolved(intent) => Some(intent),
            DurableFeeIntent::Resolved { .. } => None,
        }
    }

    fn canonical_fee_intent(&self) -> &SubmissionFeeIntent {
        match &self.fee_intent {
            DurableFeeIntent::Unresolved(intent) | DurableFeeIntent::Resolved { intent, .. } => {
                intent
            }
        }
    }

    fn validate(&self) -> Result<(), Error> {
        match (&self.fee_intent, &self.current_variant) {
            (
                DurableFeeIntent::Unresolved(SubmissionFeeIntent::Attach { .. }),
                SubmissionBroadcastVariant::Base,
            )
            | (
                DurableFeeIntent::Resolved {
                    resolution: FeeResolution::NotRequested,
                    ..
                },
                SubmissionBroadcastVariant::Base,
            )
            | (
                DurableFeeIntent::Resolved {
                    resolution: FeeResolution::Attached,
                    ..
                },
                SubmissionBroadcastVariant::FeeBearing { .. },
            ) => {}
            _ => {
                return Err(Error::StrErr(format!(
                    "submission {} has inconsistent fee intent and broadcast variant",
                    self.id
                )))
            }
        }
        if let Some(acknowledged) = &self.wallet_acknowledged_variant {
            if acknowledged != &submission_variant_fingerprint(&self.base_bundle)?
                && acknowledged != &self.current_variant_fingerprint()?
            {
                return Err(Error::StrErr(format!(
                    "submission {} acknowledges an unknown variant",
                    self.id
                )));
            }
        }
        Ok(())
    }
}

const SUBMISSION_DRAIN_MESSAGE_LIMIT: usize = 512;
const SUBMISSION_DRAIN_RUST_CONTEXT_LIMIT: usize = 4096;

fn bounded_text(value: String, limit: usize) -> String {
    if value.len() <= limit {
        return value;
    }
    let mut end = limit;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

struct SubmissionPlanError {
    stage: SubmissionDrainFailureStage,
    retained_submission_id: Option<u64>,
    candidate_submission_id: Option<u64>,
    intent_fingerprint: Option<Hash>,
    message: String,
    rust_context: String,
}

struct SubmissionPlanDelta {
    retained_expiry_update: Option<(u64, Option<u64>)>,
    retained_insert: Option<SubmittedTx>,
    next_submission_id: u64,
    emitted_id: Option<u64>,
    drained: Option<DrainedSubmission>,
}

fn plan_pending_submission(
    pending: &PendingSubmission,
    goal: SubmissionDeliveryGoal,
    submitted: &[SubmittedTx],
    next_submission_id: u64,
    emitted_ids: &HashSet<u64>,
) -> Result<SubmissionPlanDelta, SubmissionPlanError> {
    let fingerprint = submission_intent_fingerprint(&pending.submission, &pending.fee_intent)
        .map_err(|error| SubmissionPlanError {
            stage: SubmissionDrainFailureStage::Fingerprint,
            retained_submission_id: None,
            candidate_submission_id: pending.id,
            intent_fingerprint: None,
            message: "Failed to derive the canonical submission fingerprint".to_string(),
            rust_context: format!("{error:?}"),
        })?;

    let existing_index = match pending.id {
        Some(id) => Some(submitted.iter().position(|tx| tx.id == id).ok_or_else(|| {
            SubmissionPlanError {
                stage: SubmissionDrainFailureStage::RetainedState,
                retained_submission_id: None,
                candidate_submission_id: Some(id),
                intent_fingerprint: Some(fingerprint.clone()),
                message: format!("Queued submission {id} no longer has retained state"),
                rust_context: format!(
                    "pending.id={id}; retained_count={}; fingerprint={fingerprint:?}",
                    submitted.len()
                ),
            }
        })?),
        None => submitted
            .iter()
            .position(|tx| tx.intent_fingerprint == fingerprint),
    };

    let (id, retained_expiry_update, retained_insert, planned_next_submission_id) = if let Some(
        index,
    ) =
        existing_index
    {
        let retained = &submitted[index];
        if &pending.fee_intent != retained.canonical_fee_intent() {
            return Err(SubmissionPlanError {
                stage: SubmissionDrainFailureStage::RetainedState,
                retained_submission_id: Some(retained.id),
                candidate_submission_id: Some(retained.id),
                intent_fingerprint: Some(fingerprint.clone()),
                message: format!(
                    "Queued submission {} has a fee intent that does not match retained state",
                    retained.id
                ),
                rust_context: format!(
                    "retained.id={}; retained.fingerprint={:?}; candidate.fingerprint={fingerprint:?}",
                    retained.id, retained.intent_fingerprint
                ),
            });
        }
        if let Err(error) = retained.validate() {
            return Err(SubmissionPlanError {
                stage: SubmissionDrainFailureStage::RetainedState,
                retained_submission_id: Some(retained.id),
                candidate_submission_id: Some(retained.id),
                intent_fingerprint: Some(fingerprint.clone()),
                message: format!(
                    "Queued submission {} has invalid retained state",
                    retained.id
                ),
                rust_context: format!("{error:?}"),
            });
        }
        if retained.intent_fingerprint != fingerprint {
            return Err(SubmissionPlanError {
                stage: SubmissionDrainFailureStage::RetainedState,
                retained_submission_id: Some(retained.id),
                candidate_submission_id: Some(retained.id),
                intent_fingerprint: Some(fingerprint.clone()),
                message: format!(
                    "Queued submission id {} does not match its retained intent",
                    retained.id
                ),
                rust_context: format!(
                    "retained.id={}; retained.fingerprint={:?}; candidate.fingerprint={fingerprint:?}",
                    retained.id, retained.intent_fingerprint
                ),
            });
        }
        let should_emit = match goal {
            SubmissionDeliveryGoal::EnsureBroadcast => !retained
                .current_variant_acknowledged()
                .map_err(|error| SubmissionPlanError {
                    stage: SubmissionDrainFailureStage::RetainedState,
                    retained_submission_id: Some(retained.id),
                    candidate_submission_id: Some(retained.id),
                    intent_fingerprint: Some(fingerprint.clone()),
                    message: format!(
                        "Queued submission {} has an invalid current variant",
                        retained.id
                    ),
                    rust_context: format!("{error:?}"),
                })?,
            SubmissionDeliveryGoal::FeeUpgrade => {
                retained.chain_terminality == SubmissionChainTerminality::Active
                    && retained.unresolved_fee_intent().is_some()
            }
        };
        (
            should_emit.then_some(retained.id),
            Some((
                retained.id,
                min_expiry(retained.expiry, pending.submission.expiry),
            )),
            None,
            next_submission_id,
        )
    } else {
        let candidate_id = next_submission_id;
        if submitted.iter().any(|tx| tx.id == candidate_id) {
            return Err(SubmissionPlanError {
                stage: SubmissionDrainFailureStage::SubmissionId,
                retained_submission_id: None,
                candidate_submission_id: Some(candidate_id),
                intent_fingerprint: Some(fingerprint.clone()),
                message: format!(
                    "Submission identifier {candidate_id} collides with retained state"
                ),
                rust_context: format!(
                    "next_submission_id={candidate_id}; retained_count={}",
                    submitted.len()
                ),
            });
        }
        let outputs = expected_output_coins(&pending.submission.bundle).map_err(|error| {
            SubmissionPlanError {
                stage: SubmissionDrainFailureStage::ExpectedOutputs,
                retained_submission_id: None,
                candidate_submission_id: Some(candidate_id),
                intent_fingerprint: Some(fingerprint.clone()),
                message: "Failed to derive expected outputs for queued submission".to_string(),
                rust_context: format!("{error:?}"),
            }
        })?;
        let planned_next_submission_id =
            next_submission_id
                .checked_add(1)
                .ok_or_else(|| SubmissionPlanError {
                    stage: SubmissionDrainFailureStage::SubmissionId,
                    retained_submission_id: None,
                    candidate_submission_id: Some(candidate_id),
                    intent_fingerprint: Some(fingerprint.clone()),
                    message: "Submission identifier source is exhausted".to_string(),
                    rust_context: format!("next_submission_id={candidate_id}"),
                })?;
        let spent_coin_ids = pending
            .submission
            .bundle
            .spends
            .iter()
            .map(|spend| spend.coin.to_coin_id())
            .collect();
        let retained = SubmittedTx {
            id: candidate_id,
            intent_fingerprint: fingerprint.clone(),
            base_bundle: pending.submission.bundle.clone(),
            current_variant: SubmissionBroadcastVariant::Base,
            fee_intent: match &pending.fee_intent {
                SubmissionFeeIntent::Attach { .. } => {
                    DurableFeeIntent::Unresolved(pending.fee_intent.clone())
                }
                SubmissionFeeIntent::AlreadyPaid | SubmissionFeeIntent::NoFeeConfigured => {
                    DurableFeeIntent::Resolved {
                        intent: pending.fee_intent.clone(),
                        resolution: FeeResolution::NotRequested,
                    }
                }
            },
            wallet_acknowledged_variant: None,
            chain_terminality: SubmissionChainTerminality::Active,
            spent_coin_ids,
            expected_output_coins: outputs,
            expiry: pending.submission.expiry,
        };
        (
            Some(candidate_id),
            None,
            Some(retained),
            planned_next_submission_id,
        )
    };

    let emitted_id = id.filter(|id| !emitted_ids.contains(id));
    let drained = emitted_id.map(|id| {
        let retained = retained_insert.as_ref().unwrap_or_else(|| {
            submitted
                .iter()
                .find(|tx| tx.id == id)
                .expect("planned submission must be retained")
        });
        DrainedSubmission {
            id,
            bundle: retained.current_bundle().clone(),
            expiry: retained_expiry_update
                .map(|(_, expiry)| expiry)
                .unwrap_or(retained.expiry),
            fee_intent: retained
                .unresolved_fee_intent()
                .cloned()
                .unwrap_or(SubmissionFeeIntent::AlreadyPaid),
            goal,
            intent_fingerprint: retained.intent_fingerprint.clone(),
            variant_fingerprint: retained
                .current_variant_fingerprint()
                .expect("validated retained variant must be fingerprintable"),
        }
    });
    Ok(SubmissionPlanDelta {
        retained_expiry_update,
        retained_insert,
        next_submission_id: planned_next_submission_id,
        emitted_id,
        drained,
    })
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
    /// cleared, or when a complete snapshot shows a confirmed spend reverted to
    /// live, so a reorg causes the claim to be resubmitted.
    pub claim_submitted: bool,
    /// The eagerly-built spend to submit once this coin reaches its relative
    /// timeout age.  Set by the handler at registration time; held here so the
    /// manager is the sole submitter and can resubmit across reorgs.
    pub timeout_spend: Option<TransactionSubmission>,
    /// UI context emitted when the manager submits this timeout spend.
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
}

/// The minimal interface the [`TransactionManager`] needs from the cradle it
/// wraps.  Implemented by [`GameSession`] in production and by
/// `MockGameSession` in unit tests.
pub trait ManagedGameSession {
    /// Detach transient session output before creating an observation working
    /// copy. `None` distinguishes no output slot from an existing empty slot.
    fn session_detach_observation_output(&mut self) -> Option<DrainResult> {
        None
    }

    /// Restore detached output ahead of anything produced by the observation.
    fn session_prepend_observation_output(&mut self, output: Option<DrainResult>) {
        debug_assert!(
            output.as_ref().is_none_or(|drain| drain.events.is_empty()),
            "no-output ManagedGameSession produced transient observation output"
        );
    }

    /// Receive a manager-ordered coin observation batch. `None` advances
    /// protocol clocks from a trusted height without treating an unavailable
    /// snapshot as an authoritative empty coin set.
    fn session_observe(
        &mut self,
        allocator: &mut AllocEncoder,
        height: u64,
        observations: Option<&[CoinObservation]>,
    ) -> Result<(), Error>;

    /// Handle one host-delivered puzzle/solution result inside the manager's
    /// durable working-copy transaction.
    fn session_report_puzzle_and_solution(
        &mut self,
        _allocator: &mut AllocEncoder,
        _coin_id: &CoinString,
        _puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(), Error> {
        Err(Error::StrErr(
            "puzzle-and-solution callbacks are not supported by this session".to_string(),
        ))
    }

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
    fn session_detach_observation_output(&mut self) -> Option<DrainResult> {
        Some(self.detach_observation_output())
    }

    fn session_prepend_observation_output(&mut self, output: Option<DrainResult>) {
        if let Some(output) = output {
            self.prepend_observation_output(output);
        }
    }

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

    fn session_report_puzzle_and_solution(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(), Error> {
        GameSession::report_puzzle_and_solution_in_place(
            self,
            allocator,
            coin_id,
            puzzle_and_solution,
        )
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
    /// Current host-selected fee input. Rust captures it into each newly
    /// emitted submission intent; retained retries never consult this value.
    fee_configuration: FeeConfiguration,
    /// Coins we are tracking, keyed by their full `CoinString`.
    watched_coins: HashMap<CoinString, WatchedCoin>,
    /// Transactions the cradle asked to submit, awaiting the hosting layer.
    /// Each carries the optional absolute expiry height threaded from the
    /// handler (`ASSERT_BEFORE_HEIGHT_ABSOLUTE`), so it lands on the retained
    /// `SubmittedTx` when drained.
    pending_submissions: Vec<PendingSubmission>,
    /// Retained IDs whose queued delivery exists only to seek a fee upgrade.
    fee_upgrade_delivery_ids: HashSet<u64>,
    /// Provider readiness consumes only fee-upgrade deliveries; unrelated
    /// protocol broadcasts remain queued for their normal drain boundary.
    #[serde(skip)]
    fee_upgrade_only_next_drain: bool,
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
    /// How many blocks a coin must remain confirmed-spent before eviction.
    confirmation_depth: u64,
    /// Most recent height reported via `report_coin_states`.
    last_height: u64,
    /// Most recent height accompanied by a complete, authoritative coin
    /// snapshot. Kept separately from `last_height`: a height-only observation
    /// must advance protocol clocks without masking a later reorg from the
    /// snapshot reconciliation path.
    last_snapshot_height: u64,
    /// Tip of the rollback epoch whose timeout claims have already been
    /// invalidated. A height-only report is normally followed by a same-height
    /// authoritative snapshot; both describe one rollback and must not re-arm
    /// claims or replay retained submissions twice.
    timeout_rollback_height: Option<u64>,
    /// Exact retained intent ids already queued during the current rollback
    /// epoch. This survives an intervening drain/ack so the authoritative
    /// snapshot following a height-only rollback cannot emit the same intent
    /// again.
    rollback_replayed_ids: HashSet<u64>,
    /// Watched coins that left the live set without a confirmed spend (e.g.
    /// reorged out before their creating transaction re-confirmed).  Surfaced to
    /// the resubmission layer so the creating transaction can be replayed.
    vanished_coins: std::collections::HashSet<CoinString>,
    /// Transactions handed out for submission, kept so a reorged-out watched
    /// protocol output can be replayed by resubmitting the transaction that
    /// created it.
    submitted: Vec<SubmittedTx>,
    /// Stable IDs retired by Rust since the host last drained lifecycle output.
    retired_submission_ids: Vec<u64>,
    /// Monotonic durable identifier source for retained submissions.
    next_submission_id: u64,
    /// Coins observed live on-chain in the previous report.  Used to compute
    /// the created/deleted set difference, exactly mirroring the previous
    /// `FullCoinSetAdapter`.  Includes coins not (yet) watched so that a coin
    /// which appears one block before the manager learns to watch it is still
    /// emitted as a creation at its true appearance height.
    present_coins: std::collections::HashSet<CoinString>,
}

impl TransactionManager<GameSession> {
    pub fn restore_runtime(&mut self) {
        self.cradle.restore_runtime();
    }

    pub fn snapshot_pending_coin_solution_requests(&self) -> Vec<CoinString> {
        self.cradle.pending_coin_solution_requests()
    }
}

/// State intentionally excluded from the serialized observation working copy.
///
/// An observation either restores this journal unchanged on failure or prepends
/// it to the output produced by the successfully committed working copy.
struct ObservationTransients {
    pending_events: GameSessionEventQueue,
    pending_watch_coins: Vec<CoinString>,
    pending_unwatch_coins: Vec<CoinString>,
    session_output: Option<DrainResult>,
}

impl ObservationTransients {
    fn detach<C: ManagedGameSession>(manager: &mut TransactionManager<C>) -> Self {
        Self {
            pending_events: std::mem::take(&mut manager.pending_events),
            pending_watch_coins: std::mem::take(&mut manager.pending_watch_coins),
            pending_unwatch_coins: std::mem::take(&mut manager.pending_unwatch_coins),
            session_output: manager.cradle.session_detach_observation_output(),
        }
    }

    fn restore<C: ManagedGameSession>(&mut self, manager: &mut TransactionManager<C>) {
        manager.pending_events = std::mem::take(&mut self.pending_events);
        manager.pending_watch_coins = std::mem::take(&mut self.pending_watch_coins);
        manager.pending_unwatch_coins = std::mem::take(&mut self.pending_unwatch_coins);
        manager
            .cradle
            .session_prepend_observation_output(self.session_output.take());
    }

    fn merge<C: ManagedGameSession>(&mut self, working: &mut TransactionManager<C>) {
        self.pending_events.append(&mut working.pending_events);
        self.pending_watch_coins
            .append(&mut working.pending_watch_coins);
        self.pending_unwatch_coins
            .append(&mut working.pending_unwatch_coins);
        working.pending_events = std::mem::take(&mut self.pending_events);
        working.pending_watch_coins = std::mem::take(&mut self.pending_watch_coins);
        working.pending_unwatch_coins = std::mem::take(&mut self.pending_unwatch_coins);
        working
            .cradle
            .session_prepend_observation_output(self.session_output.take());
    }
}

/// Default confirmation depth.  Chosen to be far deeper than any plausible
/// Chia reorg.
pub const DEFAULT_CONFIRMATION_DEPTH: u64 = 32;

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
            fee_configuration: FeeConfiguration::default(),
            watched_coins: HashMap::new(),
            pending_submissions: Vec::new(),
            fee_upgrade_delivery_ids: HashSet::new(),
            fee_upgrade_only_next_drain: false,
            pending_events: GameSessionEventQueue::default(),
            pending_watch_coins: Vec::new(),
            pending_unwatch_coins: Vec::new(),
            confirmation_depth: DEFAULT_CONFIRMATION_DEPTH,
            last_height: 0,
            last_snapshot_height: 0,
            timeout_rollback_height: None,
            rollback_replayed_ids: HashSet::new(),
            present_coins: std::collections::HashSet::new(),
            vanished_coins: std::collections::HashSet::new(),
            submitted: Vec::new(),
            retired_submission_ids: Vec::new(),
            next_submission_id: 0,
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

    pub fn configure_fee(&mut self, configuration: FeeConfiguration) {
        self.fee_configuration = configuration;
    }

    pub fn fee_configuration(&self) -> &FeeConfiguration {
        &self.fee_configuration
    }

    pub fn submission_fee_intent(&self, id: u64) -> Result<SubmissionFeeIntent, Error> {
        self.submitted
            .iter()
            .find(|tx| tx.id == id)
            .map(|tx| {
                tx.unresolved_fee_intent()
                    .cloned()
                    .unwrap_or(SubmissionFeeIntent::AlreadyPaid)
            })
            .ok_or_else(|| Error::StrErr(format!("unknown submission id {id}")))
    }

    fn capture_fee_intent(&self, policy: &FeePolicy) -> SubmissionFeeIntent {
        match policy {
            FeePolicy::AlreadyPaid => SubmissionFeeIntent::AlreadyPaid,
            FeePolicy::AttachTo(_) if self.fee_configuration.amount.to_u64() == 0 => {
                SubmissionFeeIntent::NoFeeConfigured
            }
            FeePolicy::AttachTo(target) => SubmissionFeeIntent::Attach {
                target: target.clone(),
                amount: self.fee_configuration.amount.clone(),
                attachment_failure_policy: self.fee_configuration.attachment_failure_policy.clone(),
            },
        }
    }

    fn reconciliation_input_coins(&self) -> std::collections::BTreeSet<CoinString> {
        self.submitted
            .iter()
            .filter(|tx| {
                if tx.chain_terminality == SubmissionChainTerminality::Active {
                    return true;
                }
                tx.expected_output_coins.iter().any(|coin| {
                    self.watched_coins
                        .get(coin)
                        .and_then(|watched| watched.birthday)
                        .is_some_and(|birthday| {
                            birthday.saturating_add(self.confirmation_depth) > self.last_height
                        })
                })
            })
            .flat_map(|tx| tx.base_bundle.spends.iter().map(|spend| spend.coin.clone()))
            .collect()
    }

    /// Durable poll-interest snapshot for seeding the host poller. In addition
    /// to protocol-watched coins, retained transaction inputs are queried while
    /// their outcome is unresolved or a watched landed output remains inside
    /// the confirmation-depth rollback window.
    pub fn snapshot_watched_coins(&self) -> Vec<CoinString> {
        self.watched_coins
            .keys()
            .cloned()
            .chain(self.reconciliation_input_coins())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect()
    }

    /// Coin string for a watched coin, if tracked.
    pub fn watched_coin(&self, coin: &CoinString) -> Option<&WatchedCoin> {
        self.watched_coins.get(coin)
    }

    /// Drain transactions queued for submission to the network.  Each drained
    /// transaction is retained under its monotonic public id and exact canonical
    /// intent fingerprint so its outputs can be resubmitted if a reorg rolls
    /// them back.
    pub fn drain_submissions(&mut self) -> Result<SubmissionDrainResult, Error> {
        let pending_all = std::mem::take(&mut self.pending_submissions);
        let (pending_for_drain, mut deferred) =
            if std::mem::take(&mut self.fee_upgrade_only_next_drain) {
                pending_all.into_iter().partition(|pending| {
                    pending
                        .id
                        .is_some_and(|id| self.fee_upgrade_delivery_ids.contains(&id))
                })
            } else {
                (pending_all, Vec::new())
            };
        let mut pending = pending_for_drain
            .into_iter()
            .enumerate()
            .map(|(index, pending)| (index as u64, pending))
            .collect::<std::collections::VecDeque<_>>();
        let mut result = SubmissionDrainResult {
            submissions: Vec::with_capacity(pending.len()),
            failures: Vec::new(),
        };
        let mut emitted_ids = HashSet::new();
        while let Some((candidate_index, candidate)) = pending.pop_front() {
            let goal = if candidate
                .id
                .is_some_and(|id| self.fee_upgrade_delivery_ids.remove(&id))
            {
                SubmissionDeliveryGoal::FeeUpgrade
            } else {
                SubmissionDeliveryGoal::EnsureBroadcast
            };
            match plan_pending_submission(
                &candidate,
                goal,
                &self.submitted,
                self.next_submission_id,
                &emitted_ids,
            ) {
                Ok(delta) => {
                    if let Some((id, expiry)) = delta.retained_expiry_update {
                        self.submitted
                            .iter_mut()
                            .find(|tx| tx.id == id)
                            .expect("validated retained submission must still exist")
                            .expiry = expiry;
                    }
                    if let Some(retained) = delta.retained_insert {
                        self.submitted.push(retained);
                    }
                    self.next_submission_id = delta.next_submission_id;
                    if let Some(id) = delta.emitted_id {
                        emitted_ids.insert(id);
                    }
                    if let Some(drained) = delta.drained {
                        result.submissions.push(drained);
                    }
                }
                Err(error) => {
                    if let Some(id) = error.retained_submission_id {
                        self.retain_submitted(|tx| tx.id != id);
                        pending.retain(|(_, pending)| pending.id != Some(id));
                    }
                    result.failures.push(SubmissionDrainFailure {
                        candidate_index,
                        retained_submission_id: error.retained_submission_id,
                        candidate_submission_id: error.candidate_submission_id,
                        intent_fingerprint: error.intent_fingerprint,
                        stage: error.stage,
                        message: bounded_text(error.message, SUBMISSION_DRAIN_MESSAGE_LIMIT),
                        rust_context: bounded_text(
                            error.rust_context,
                            SUBMISSION_DRAIN_RUST_CONTEXT_LIMIT,
                        ),
                    });
                }
            }
        }
        deferred.append(&mut self.pending_submissions);
        self.pending_submissions = deferred;
        Ok(result)
    }

    /// Finalize the exact retained protocol submission. Provider fee material
    /// is untrusted: attachment failures follow the captured Rust policy, while
    /// an unknown id or retained-state invariant remains a hard error.
    pub fn finalize_submission(
        &mut self,
        id: u64,
        fee_source: SubmissionFeeSource,
        agg_sig_me_additional_data: &Hash,
        height: u64,
    ) -> Result<FinalizedSubmission, Error> {
        let fingerprint = self
            .submitted
            .iter()
            .find(|tx| tx.id == id)
            .ok_or_else(|| Error::StrErr(format!("unknown submission id {id}")))?
            .current_variant_fingerprint()?;
        self.finalize_submission_delivery(
            id,
            SubmissionDeliveryGoal::EnsureBroadcast,
            &fingerprint,
            fee_source,
            agg_sig_me_additional_data,
            height,
        )
    }

    pub fn finalize_submission_delivery(
        &mut self,
        id: u64,
        goal: SubmissionDeliveryGoal,
        drained_variant_fingerprint: &Hash,
        fee_source: SubmissionFeeSource,
        agg_sig_me_additional_data: &Hash,
        height: u64,
    ) -> Result<FinalizedSubmission, Error> {
        let submission = self
            .submitted
            .iter_mut()
            .find(|tx| tx.id == id)
            .ok_or_else(|| Error::StrErr(format!("unknown submission id {id}")))?;
        submission.validate()?;
        let current_fingerprint = submission.current_variant_fingerprint()?;
        if &current_fingerprint != drained_variant_fingerprint {
            return Err(Error::StrErr(format!(
                "submission {id} delivery refers to a stale broadcast variant"
            )));
        }
        let unresolved_fee_intent = submission.unresolved_fee_intent().cloned();
        let mut finalized = match unresolved_fee_intent {
            None => {
                if !matches!(fee_source, SubmissionFeeSource::NotRequested) {
                    return Err(Error::StrErr(format!(
                        "submission {id} received a fee source without requesting one"
                    )));
                }
                Ok(FinalizedSubmission {
                    bundle: submission.current_bundle().clone(),
                    applied_fee: submission.current_applied_fee(),
                    warning: None,
                    fee_source_disposition: FeeSourceDisposition::NotRequested,
                    variant_fingerprint: current_fingerprint.clone(),
                    should_broadcast: goal == SubmissionDeliveryGoal::EnsureBroadcast,
                })
            }
            Some(SubmissionFeeIntent::Attach {
                target,
                amount,
                attachment_failure_policy,
            }) => {
                let attached = match fee_source {
                    SubmissionFeeSource::Available(fee_bundle) => aggregate_wallet_fee_bundle(
                        submission.base_bundle.clone(),
                        fee_bundle,
                        amount.to_u64(),
                        &target,
                        agg_sig_me_additional_data,
                        height,
                    )
                    .map_err(|error| format!("{error:?}")),
                    SubmissionFeeSource::Failed(reason) => Err(reason),
                    SubmissionFeeSource::NotRequested => {
                        Err("the wallet did not provide a fee source".to_string())
                    }
                };
                match attached {
                    Ok(bundle) => {
                        let variant_fingerprint = submission_variant_fingerprint(&bundle)?;
                        submission.current_variant = SubmissionBroadcastVariant::FeeBearing {
                            bundle: bundle.clone(),
                            applied_fee: amount.to_u64(),
                        };
                        submission.fee_intent = DurableFeeIntent::Resolved {
                            intent: SubmissionFeeIntent::Attach {
                                target,
                                amount: amount.clone(),
                                attachment_failure_policy,
                            },
                            resolution: FeeResolution::Attached,
                        };
                        Ok(FinalizedSubmission {
                        bundle,
                        applied_fee: amount.to_u64(),
                        warning: None,
                        fee_source_disposition: FeeSourceDisposition::Attached,
                        variant_fingerprint,
                        should_broadcast: true,
                    })
                    }
                    Err(reason) => match attachment_failure_policy {
                        AttachmentFailurePolicy::SubmitWithoutFee => Ok(FinalizedSubmission {
                            bundle: submission.base_bundle.clone(),
                            applied_fee: 0,
                            warning: Some(format!(
                                "Configured fee was not applied: {reason}. The transaction will be attempted without a fee."
                            )),
                            fee_source_disposition: FeeSourceDisposition::Unused,
                            variant_fingerprint: current_fingerprint.clone(),
                            should_broadcast: goal == SubmissionDeliveryGoal::EnsureBroadcast,
                        }),
                    },
                }
            }
            Some(SubmissionFeeIntent::AlreadyPaid | SubmissionFeeIntent::NoFeeConfigured) => {
                return Err(Error::StrErr(format!(
                    "submission {id} retained an invalid unresolved fee intent"
                )));
            }
        }?;
        if finalized.should_broadcast && submission.current_variant_acknowledged()? {
            finalized.should_broadcast = false;
        }
        submission.validate()?;
        Ok(finalized)
    }

    pub fn acknowledge_submission(&mut self, id: u64) -> Result<(), Error> {
        let fingerprint = self
            .submitted
            .iter()
            .find(|tx| tx.id == id)
            .ok_or_else(|| Error::StrErr(format!("unknown submission id {id}")))?
            .current_variant_fingerprint()?;
        self.acknowledge_submission_variant(id, &fingerprint)
    }

    pub fn acknowledge_submission_variant(
        &mut self,
        id: u64,
        variant_fingerprint: &Hash,
    ) -> Result<(), Error> {
        let Some(submission) = self.submitted.iter_mut().find(|tx| tx.id == id) else {
            return Err(Error::StrErr(format!("unknown submission id {id}")));
        };
        if &submission.current_variant_fingerprint()? != variant_fingerprint {
            return Err(Error::StrErr(format!(
                "submission {id} acknowledgement refers to a stale broadcast variant"
            )));
        }
        submission.wallet_acknowledged_variant = Some(variant_fingerprint.clone());
        self.pending_submissions
            .retain(|pending| pending.id != Some(id));
        self.fee_upgrade_delivery_ids.remove(&id);
        Ok(())
    }

    pub fn reject_submission(&mut self, id: u64) -> Result<(), Error>
    where
        C: ManagedGameSession,
    {
        if !self.submitted.iter().any(|tx| tx.id == id) {
            return Err(Error::StrErr(format!("unknown submission id {id}")));
        }
        self.pending_submissions
            .retain(|pending| pending.id != Some(id));
        self.fee_upgrade_delivery_ids.remove(&id);
        Ok(())
    }

    fn retain_submitted(&mut self, mut keep: impl FnMut(&SubmittedTx) -> bool) {
        let removed_ids = self
            .submitted
            .iter()
            .filter(|tx| !keep(tx))
            .map(|tx| tx.id)
            .collect::<HashSet<_>>();
        if removed_ids.is_empty() {
            return;
        }
        let mut removed_ids_sorted = removed_ids.iter().copied().collect::<Vec<_>>();
        removed_ids_sorted.sort_unstable();
        for id in removed_ids_sorted {
            self.emit_submission_retirement(id);
        }
        self.submitted.retain(|tx| !removed_ids.contains(&tx.id));
        self.pending_submissions
            .retain(|pending| !pending.id.is_some_and(|id| removed_ids.contains(&id)));
        self.fee_upgrade_delivery_ids
            .retain(|id| !removed_ids.contains(id));
        self.rollback_replayed_ids
            .retain(|id| !removed_ids.contains(id));
    }

    fn emit_submission_retirement(&mut self, id: u64) {
        if !self.retired_submission_ids.contains(&id) {
            self.retired_submission_ids.push(id);
        }
    }

    pub fn drain_retired_submission_ids(&mut self) -> Vec<u64> {
        std::mem::take(&mut self.retired_submission_ids)
    }

    /// Re-queue retained, unexpired submissions after the host has supplied a
    /// fresh chain height. A transaction drained before reload may not have
    /// reached the network; an absolute-expiry transaction cannot become valid
    /// again and is discarded rather than repeatedly offered to the wallet.
    pub fn requeue_submitted(&mut self) {
        let height = self.last_height;
        self.retain_submitted(|tx| !matches!(tx.expiry, Some(expiry) if height >= expiry));
        let ids = self
            .submitted
            .iter()
            .filter(|tx| tx.chain_terminality == SubmissionChainTerminality::Active)
            .map(|tx| tx.id)
            .collect::<Vec<_>>();
        self.queue_rebroadcast_epoch(&ids);
    }

    /// A matching provider attach/readiness edge may request fee acquisition
    /// without rebroadcasting an already-acknowledged base variant.
    pub fn request_fee_upgrades(&mut self) {
        let height = self.last_height;
        self.retain_submitted(|tx| !matches!(tx.expiry, Some(expiry) if height >= expiry));
        let ids = self
            .submitted
            .iter()
            .filter(|tx| {
                tx.chain_terminality == SubmissionChainTerminality::Active
                    && tx.unresolved_fee_intent().is_some()
            })
            .map(|tx| tx.id)
            .collect::<Vec<_>>();
        for id in ids {
            self.queue_retained_delivery(id, SubmissionDeliveryGoal::FeeUpgrade);
        }
        self.fee_upgrade_only_next_drain = true;
    }

    fn queue_rebroadcast_epoch(&mut self, ids: &[u64]) {
        for id in ids {
            let Some(tx) = self.submitted.iter().find(|tx| tx.id == *id) else {
                continue;
            };
            let goal = if tx
                .current_variant_acknowledged()
                .expect("retained broadcast variant must remain fingerprintable")
            {
                SubmissionDeliveryGoal::FeeUpgrade
            } else {
                SubmissionDeliveryGoal::EnsureBroadcast
            };
            self.queue_retained_delivery(*id, goal);
        }
    }

    fn queue_retained_delivery(&mut self, id: u64, goal: SubmissionDeliveryGoal) {
        if self
            .pending_submissions
            .iter()
            .any(|pending| pending.id == Some(id))
        {
            return;
        }
        let Some(tx) = self.submitted.iter().find(|tx| tx.id == id) else {
            return;
        };
        if goal == SubmissionDeliveryGoal::FeeUpgrade && tx.unresolved_fee_intent().is_none() {
            return;
        }
        self.pending_submissions.push(PendingSubmission {
            id: Some(tx.id),
            submission: TransactionSubmission::already_paid(tx.base_bundle.clone(), tx.expiry),
            fee_intent: tx.canonical_fee_intent().clone(),
        });
        if goal == SubmissionDeliveryGoal::FeeUpgrade {
            self.fee_upgrade_delivery_ids.insert(id);
        }
    }

    /// Queue each surviving retained intent once during the current rollback
    /// epoch. The replayed-id set deliberately outlives drain and wallet
    /// acknowledgement until forward progress ends the epoch.
    fn collect_rollback_epoch_replay(&mut self) {
        let ids = self.submitted.iter().map(|tx| tx.id).collect();
        self.collect_rollback_replay_ids(&ids);
    }

    fn collect_rollback_replay_ids(&mut self, ids: &HashSet<u64>) {
        for tx in &mut self.submitted {
            if !ids.contains(&tx.id) {
                continue;
            }
            if !self.rollback_replayed_ids.insert(tx.id) {
                continue;
            }
            // A rollback invalidates prior chain-landing evidence even when the
            // height report arrives before the authoritative coin snapshot.
            // Keeping `landed` set here would make a drained-but-unresolved
            // replay disappear across a reload in that interval.
            tx.chain_terminality = SubmissionChainTerminality::Active;
            tx.wallet_acknowledged_variant = None;
        }
        let replay_ids = self
            .submitted
            .iter()
            .filter(|tx| ids.contains(&tx.id))
            .map(|tx| tx.id)
            .collect::<Vec<_>>();
        for id in replay_ids {
            self.queue_retained_delivery(id, SubmissionDeliveryGoal::EnsureBroadcast);
        }
    }

    /// Register (or refresh) a watched coin, its timeout, and the eager spend to
    /// submit when it matures.  A `None` spend on a refresh leaves any existing
    /// eager spend in place.
    fn register_watch(
        &mut self,
        coin: CoinString,
        timeout: Timeout,
        spend: Option<TransactionSubmission>,
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
                GameSessionEvent::OutboundTransaction(submission) => {
                    let fee_intent = self.capture_fee_intent(&submission.fee_policy);
                    self.pending_submissions.push(PendingSubmission {
                        id: None,
                        submission,
                        fee_intent,
                    });
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
    pub fn apply_working_copy_transaction<T, F>(
        &mut self,
        _allocator: &mut AllocEncoder,
        apply: F,
    ) -> Result<T, Error>
    where
        C: Serialize + DeserializeOwned,
        F: FnOnce(&mut Self, &mut AllocEncoder) -> Result<T, Error>,
    {
        let mut transients = ObservationTransients::detach(self);
        let result = (|| {
            let checkpoint = bencodex::to_vec(&self).map_err(|e| {
                Error::StrErr(format!(
                    "failed to encode transaction-manager working copy: {e}"
                ))
            })?;
            let mut working: Self = bencodex::from_slice(&checkpoint).map_err(|e| {
                Error::StrErr(format!(
                    "failed to decode transaction-manager working copy: {e}"
                ))
            })?;
            // Callbacks may allocate aggressively and can still fail after doing
            // so. Programs retained by durable state serialize their trees, so
            // no NodePtr needs to escape this scratch allocator.
            let mut scratch_allocator = AllocEncoder::new();
            let value = apply(&mut working, &mut scratch_allocator)?;

            transients.merge(&mut working);
            Ok((working, value))
        })();

        match result {
            Ok((working, value)) => {
                *self = working;
                Ok(value)
            }
            Err(error) => {
                transients.restore(self);
                Err(error)
            }
        }
    }

    /// Deliver one puzzle/solution lookup result atomically with every phase
    /// mutation, emitted effect, and pending-request retirement it causes.
    pub fn report_puzzle_and_solution(
        &mut self,
        allocator: &mut AllocEncoder,
        coin_id: &CoinString,
        puzzle_and_solution: Option<(&Program, &Program)>,
    ) -> Result<(), Error>
    where
        C: Serialize + DeserializeOwned,
    {
        self.apply_working_copy_transaction(allocator, |working, allocator| {
            working.cradle.session_report_puzzle_and_solution(
                allocator,
                coin_id,
                puzzle_and_solution,
            )
        })
    }

    /// Report a trusted chain height when the watched-coin snapshot is not
    /// available or is known partial. This advances handshake protocol clocks
    /// through the manager without inventing coin creations/deletions or
    /// evaluating channel-creation expiry from absent coin data. Timeout claims
    /// wait for `report_coin_states`: a height-only observation cannot tell
    /// whether the coin is still unspent.
    pub fn report_height(&mut self, allocator: &mut AllocEncoder, height: u64) -> Result<(), Error>
    where
        C: Serialize + DeserializeOwned,
    {
        if height > MAX_REPORTED_HEIGHT {
            return Err(Error::StrErr(format!(
                "report_height: height {height} exceeds MAX_REPORTED_HEIGHT {MAX_REPORTED_HEIGHT}"
            )));
        }
        self.apply_working_copy_transaction(allocator, |working, allocator| {
            working.report_height_in_place(allocator, height)
        })
    }

    fn report_height_in_place(
        &mut self,
        allocator: &mut AllocEncoder,
        height: u64,
    ) -> Result<(), Error> {
        let reorg = height < self.last_height;
        self.last_height = height;
        self.retain_submitted(|tx| !matches!(tx.expiry, Some(expiry) if height >= expiry));
        let rollback_rearms = self.invalidate_timeout_claims_for_rollback_epoch(height, reorg);
        if reorg {
            self.collect_rollback_epoch_replay();
        }
        if let Some(rearmed) = rollback_rearms {
            self.report_timeout_claim_rearms(rearmed)?;
        }
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
                self.rollback_replayed_ids.clear();
            }
            return None;
        }
        if self.timeout_rollback_height == Some(height) {
            return None;
        }
        self.timeout_rollback_height = Some(height);
        self.rollback_replayed_ids.clear();
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

    /// Queue eager timeout spends whose relative lock is ripe. Called only from
    /// `report_coin_states`, after spend reconciliation, so a coin that was
    /// spent at or before this height is not claimed. Fee intent is captured
    /// here, when the registered spend first becomes outbound, rather than on
    /// watch registration or refresh while it is still immature.
    fn evaluate_mature_timeout_claims(&mut self, height: u64) -> Result<(), Error> {
        let mut to_submit: Vec<(TransactionSubmission, Option<TimeoutClaimSemantic>)> = Vec::new();
        for (coin, watched) in self.watched_coins.iter_mut() {
            let ripe = match watched.birthday {
                Some(birthday) => birthday
                    .checked_add(watched.timeout_blocks.to_u64())
                    .is_some_and(|maturity_height| maturity_height <= height),
                None => false,
            };
            if ripe
                && !watched.claim_submitted
                && watched.spent_confirmed_at.is_none()
                && self.present_coins.contains(coin)
            {
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
            let fee_intent = self.capture_fee_intent(&spend.fee_policy);
            self.pending_submissions.push(PendingSubmission {
                id: None,
                submission: spend,
                fee_intent,
            });
        }
        Ok(())
    }

    fn discard_local_artifacts(&mut self) {
        self.retain_submitted(|_| false);
        self.pending_submissions.clear();
        self.fee_upgrade_delivery_ids.clear();
        self.pending_events.clear();
        self.pending_watch_coins.clear();
        self.pending_unwatch_coins.clear();
        self.watched_coins.clear();
        self.vanished_coins.clear();
        self.rollback_replayed_ids.clear();
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
    ) -> Result<(), Error>
    where
        C: Serialize + DeserializeOwned,
    {
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
                if h > height {
                    return Err(Error::StrErr(format!(
                        "report_coin_states: coin height {h} exceeds supplied peak {height}"
                    )));
                }
            }
        }
        self.apply_working_copy_transaction(allocator, |working, allocator| {
            working.report_coin_states_in_place(allocator, height, records)
        })
    }

    fn report_coin_states_in_place(
        &mut self,
        allocator: &mut AllocEncoder,
        height: u64,
        records: &[CoinStateRecord],
    ) -> Result<(), Error> {
        let reconciliation_inputs_before = self.reconciliation_input_coins();
        let reconciliation_only_inputs = reconciliation_inputs_before
            .iter()
            .filter(|coin| !self.watched_coins.contains_key(*coin))
            .cloned()
            .collect::<HashSet<_>>();

        // A decrease in confirmed height means the chain rolled back.  Any
        // creation/spend we recorded above the new tip is no longer valid: it
        // may never reappear, or reappear at a different height.  Clear those
        // confirmations so this report re-derives them from the rolled-back
        // chain state.
        let reorg = height < self.last_snapshot_height;
        self.last_height = height;
        self.last_snapshot_height = height;
        let mut rearmed_timeout_claims: Vec<TimeoutClaimSemantic> = Vec::new();
        let mut spend_reversal = false;
        let rollback_rearms = self.invalidate_timeout_claims_for_rollback_epoch(height, reorg);
        if let Some(rearmed) = rollback_rearms.as_ref() {
            rearmed_timeout_claims.extend(rearmed.iter().copied());
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
                    self.vanished_coins.insert(coin.clone());
                }
            }
        }

        let explicitly_absent = records
            .iter()
            .filter(|rec| rec.created_height.is_none() && rec.spent_height.is_none())
            .map(|rec| rec.coin.clone())
            .collect::<HashSet<_>>();
        let explicitly_live_input_ids = records
            .iter()
            .filter(|rec| rec.created_height.is_some() && rec.spent_height.is_none())
            .map(|rec| rec.coin.to_coin_id())
            .collect::<HashSet<_>>();
        let causally_rolled_back_ids = self
            .submitted
            .iter()
            .filter(|tx| {
                tx.chain_terminality == SubmissionChainTerminality::Landed
                    && tx
                        .expected_output_coins
                        .iter()
                        .any(|coin| explicitly_absent.contains(coin))
                    && tx
                        .spent_coin_ids
                        .iter()
                        .any(|coin_id| explicitly_live_input_ids.contains(coin_id))
            })
            .map(|tx| tx.id)
            .collect::<HashSet<_>>();
        for tx in self
            .submitted
            .iter()
            .filter(|tx| causally_rolled_back_ids.contains(&tx.id))
        {
            for coin in tx
                .expected_output_coins
                .iter()
                .filter(|coin| explicitly_absent.contains(*coin))
            {
                self.vanished_coins.insert(coin.clone());
                if let Some(watched) = self.watched_coins.get_mut(coin) {
                    let was_claim_submitted = watched.claim_submitted;
                    watched.birthday = None;
                    watched.spent_confirmed_at = None;
                    watched.claim_submitted = false;
                    if was_claim_submitted {
                        if let Some(semantic) = watched.timeout_claim_semantic {
                            rearmed_timeout_claims.push(semantic);
                        }
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
        let mut reappeared_vanished = HashSet::new();
        for rec in records {
            // A coin that reappears with a creation height during a reorg is live
            // again, so clear any vanished flag here rather than relying solely on
            // the `created_watched` set-diff below.  If the coin was re-mined at or
            // below the new tip in the same report that rolled back its creation,
            // it never left `present_coins` and so never shows up in that diff --
            // leaving it stuck in `vanished_coins`, which would later suppress
            // forwarding a genuine spend via `deleted_watched.retain`.
            if rec.created_height.is_some() && self.vanished_coins.remove(&rec.coin) {
                reappeared_vanished.insert(rec.coin.clone());
            }
            let live = rec.created_height.is_some() && rec.spent_height.is_none();
            // Retained transaction inputs are queried for landing/reorg
            // reconciliation, but they are not protocol watches. Keep their raw
            // records available to the manager without forwarding their lifecycle
            // to the inner cradle.
            if live && !reconciliation_only_inputs.contains(&rec.coin) {
                present_now.insert(rec.coin.clone());
            }
            let was_present = self.present_coins.contains(&rec.coin);
            if let Some(watched) = self.watched_coins.get_mut(&rec.coin) {
                // A complete snapshot that explicitly shows a previously-spent
                // coin live again proves that its spend was reorged out. Chia
                // chooses peaks by weight, so the replacement tip may be equal
                // or higher and cannot be detected from height alone.
                if live && watched.spent_confirmed_at.take().is_some() {
                    spend_reversal = true;
                    let was_claim_submitted = watched.claim_submitted;
                    watched.claim_submitted = false;
                    if was_claim_submitted {
                        if let Some(semantic) = watched.timeout_claim_semantic {
                            rearmed_timeout_claims.push(semantic);
                        }
                    }
                }
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
        if spend_reversal && !reorg {
            self.timeout_rollback_height = Some(height);
            self.rollback_replayed_ids.clear();
        }

        // Retained submissions are replay intents, not timeless wishes. Once a
        // coin they spend is observed spent, an absent expected output proves a
        // conflict only when that output was already part of this manager's
        // watched scope. A handler may register the output in reaction to this
        // same input-spent report, but the host necessarily queried the older
        // scope; treating that first report as evidence would prematurely drop
        // our own transaction before its wallet acknowledgement arrives.
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
        let mut newly_landed_ids = Vec::new();
        for tx in self.submitted.iter_mut() {
            if !tx.expected_output_coins.is_empty() {
                let output_observed = tx
                    .expected_output_coins
                    .iter()
                    .any(|coin| observed_created.contains(coin));
                if output_observed {
                    tx.chain_terminality = SubmissionChainTerminality::Landed;
                    newly_landed_ids.push(tx.id);
                } else if reorg || spend_reversal || causally_rolled_back_ids.contains(&tx.id) {
                    tx.chain_terminality = SubmissionChainTerminality::Active;
                }
            }
        }
        for id in newly_landed_ids {
            self.rollback_replayed_ids.remove(&id);
            self.pending_submissions
                .retain(|pending| pending.id != Some(id));
            self.emit_submission_retirement(id);
        }
        let current_height = height;
        let watched_outputs = self
            .watched_coins
            .keys()
            .cloned()
            .collect::<std::collections::HashSet<_>>();
        self.retain_submitted(|tx| {
            if matches!(tx.expiry, Some(expiry) if current_height >= expiry) {
                return false;
            }
            if !spent_inputs.is_empty() {
                let spends_observed_input = tx
                    .spent_coin_ids
                    .iter()
                    .any(|coin_id| spent_inputs.contains(coin_id));
                let expected_output_watched = tx
                    .expected_output_coins
                    .iter()
                    .any(|coin| watched_outputs.contains(coin));
                return !spends_observed_input
                    || tx.chain_terminality == SubmissionChainTerminality::Landed
                    || tx.expected_output_coins.is_empty()
                    || !expected_output_watched;
            }
            true
        });

        if reorg {
            self.collect_rollback_epoch_replay();
        } else if !causally_rolled_back_ids.is_empty() {
            self.collect_rollback_replay_ids(&causally_rolled_back_ids);
        }
        let reconciliation_inputs_after = self.reconciliation_input_coins();
        for coin in reconciliation_inputs_before.difference(&reconciliation_inputs_after) {
            if !self.watched_coins.contains_key(coin) {
                self.pending_unwatch_coins.push(coin.clone());
            }
        }

        // Created/deleted are the symmetric difference against the previous
        // report. The resulting observations are ordered as every creation,
        // then every spend, before the cradle receives the height callback.
        let mut created_watched: std::collections::HashSet<CoinString> = present_now
            .difference(&self.present_coins)
            .cloned()
            .collect();
        created_watched.retain(|coin| !reappeared_vanished.contains(coin));
        let mut deleted_watched: std::collections::HashSet<CoinString> = self
            .present_coins
            .difference(&present_now)
            .cloned()
            .collect();
        deleted_watched.retain(|coin| !reconciliation_only_inputs.contains(coin));
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

        self.report_timeout_claim_rearms(rearmed_timeout_claims)?;

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
            self.retain_submitted(|tx| !tx.spent_coin_ids.contains(&coin_id));
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
        if self.cradle.is_abandoned() {
            self.discard_local_artifacts();
        }
        self.absorb_events(result.events);
        Ok(ManagerDrain {
            events: std::mem::take(&mut self.pending_events),
            watch_coins: std::mem::take(&mut self.pending_watch_coins),
            unwatch_coins: std::mem::take(&mut self.pending_unwatch_coins),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::common::constants::{AGG_SIG_ME_ADDITIONAL_DATA, CREATE_COIN};
    use crate::common::types::{
        Amount, CoinID, CoinSpend, Hash, Program, Puzzle, PuzzleHash, Sha256tree, Spend,
        ToQuotedProgram,
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

    fn test_submission(name: &str, expiry: Option<u64>) -> TransactionSubmission {
        TransactionSubmission::already_paid(test_bundle(name), expiry)
    }

    fn timeout_submission(coin: &CoinString, bundle: SpendBundle) -> TransactionSubmission {
        TransactionSubmission::attach_to(bundle, None, coin)
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
                    solution: Program::nil().into(),
                    signature: Default::default(),
                },
            }],
        }
    }

    fn test_protocol_and_fee_bundles(fee: u64) -> (SpendBundle, SpendBundle, CoinString, CoinID) {
        let mut allocator = AllocEncoder::new();
        let output_ph = PuzzleHash::from_bytes([0x7b; 32]);
        let protocol_conditions = vec![(CREATE_COIN, (output_ph.clone(), (Amount::new(100), ())))
            .to_clvm(&mut allocator)
            .expect("protocol CREATE_COIN")];
        let protocol_condition_list = protocol_conditions
            .to_clvm(&mut allocator)
            .expect("protocol condition list");
        let protocol_puzzle: Puzzle = protocol_condition_list
            .to_quoted_program(&mut allocator)
            .expect("protocol puzzle")
            .into();
        let protocol_coin = CoinString::from_parts(
            &CoinID::new(Hash::from_bytes([0x7c; 32])),
            &protocol_puzzle.sha256tree(&mut allocator),
            &Amount::new(100),
        );
        let target = protocol_coin.to_coin_id();
        let fee_conditions = vec![
            (
                CREATE_COIN,
                (output_ph, (Amount::new(100_u64.saturating_sub(fee)), ())),
            )
                .to_clvm(&mut allocator)
                .expect("fee CREATE_COIN"),
            (52_u8, (Amount::new(fee), ()))
                .to_clvm(&mut allocator)
                .expect("RESERVE_FEE"),
            (64_u8, (target.clone(), ()))
                .to_clvm(&mut allocator)
                .expect("ASSERT_CONCURRENT_SPEND"),
        ];
        let fee_condition_list = fee_conditions
            .to_clvm(&mut allocator)
            .expect("fee condition list");
        let fee_puzzle: Puzzle = fee_condition_list
            .to_quoted_program(&mut allocator)
            .expect("fee puzzle")
            .into();
        let fee_coin = CoinString::from_parts(
            &CoinID::new(Hash::from_bytes([0x7d; 32])),
            &fee_puzzle.sha256tree(&mut allocator),
            &Amount::new(100),
        );
        (
            SpendBundle {
                name: Some("transactional-finalization".to_string()),
                spends: vec![CoinSpend {
                    coin: protocol_coin.clone(),
                    bundle: Spend {
                        puzzle: protocol_puzzle,
                        solution: Program::nil().into(),
                        signature: Default::default(),
                    },
                }],
            },
            SpendBundle {
                name: None,
                spends: vec![CoinSpend {
                    coin: fee_coin,
                    bundle: Spend {
                        puzzle: fee_puzzle,
                        solution: Program::nil().into(),
                        signature: Default::default(),
                    },
                }],
            },
            protocol_coin,
            target,
        )
    }

    fn test_bundle_with_invalid_conditions(name: &str, input: &CoinString) -> SpendBundle {
        SpendBundle {
            name: Some(name.to_string()),
            spends: vec![CoinSpend {
                coin: input.clone(),
                bundle: Spend {
                    puzzle: Puzzle::from(
                        Program::from_bytes(&[0x02]).expect("serialized apply atom"),
                    ),
                    solution: Program::nil().into(),
                    signature: Default::default(),
                },
            }],
        }
    }

    /// A scriptable cradle for exercising the manager in isolation.  Each call
    /// to `session_flush_and_collect` returns the next queued `DrainResult`.
    #[derive(Default, Serialize, Deserialize)]
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
            });
        }
    }

    impl ManagedGameSession for MockGameSession {
        fn session_detach_observation_output(&mut self) -> Option<DrainResult> {
            self.scripted_drains.pop_front()
        }

        fn session_prepend_observation_output(&mut self, output: Option<DrainResult>) {
            if let Some(output) = output {
                self.scripted_drains.push_front(output);
            }
        }

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

    #[derive(Serialize, Deserialize)]
    struct LateFailingObservationSession {
        callback_mutations: Vec<(u64, Option<Vec<CoinObservation>>)>,
        callback_programs: Vec<Program>,
        fail: bool,
        #[serde(skip)]
        output: GameSessionEventQueue,
    }

    impl Default for LateFailingObservationSession {
        fn default() -> Self {
            Self {
                callback_mutations: Vec::new(),
                callback_programs: Vec::new(),
                fail: true,
                output: GameSessionEventQueue::default(),
            }
        }
    }

    impl ManagedGameSession for LateFailingObservationSession {
        fn session_detach_observation_output(&mut self) -> Option<DrainResult> {
            Some(DrainResult {
                events: std::mem::take(&mut self.output),
            })
        }

        fn session_prepend_observation_output(&mut self, output: Option<DrainResult>) {
            if let Some(mut old_output) = output {
                old_output.events.append(&mut self.output);
                self.output = old_output.events;
            }
        }

        fn session_observe(
            &mut self,
            allocator: &mut AllocEncoder,
            height: u64,
            observations: Option<&[CoinObservation]>,
        ) -> Result<(), Error> {
            let allocated = allocator
                .allocator()
                .new_atom(&[0x5a; 8 * 1024])
                .expect("late callback allocation");
            self.callback_programs.push(
                Program::from_nodeptr(allocator, allocated)
                    .expect("callback allocation serializes into owned Program"),
            );
            self.callback_mutations
                .push((height, observations.map(<[CoinObservation]>::to_vec)));
            self.output.push_back(GameSessionEvent::Log(
                "observation callback output".to_string(),
            ));
            if self.fail {
                Err(Error::StrErr(
                    "forced late observation callback failure".to_string(),
                ))
            } else {
                Ok(())
            }
        }

        fn session_flush_and_collect(
            &mut self,
            _allocator: &mut AllocEncoder,
        ) -> Result<DrainResult, Error> {
            Ok(DrainResult {
                events: std::mem::take(&mut self.output),
            })
        }
    }

    #[derive(Serialize, Deserialize)]
    struct TransactionalCallbackSession {
        pending: std::collections::BTreeSet<CoinString>,
        durable_mutations: Vec<CoinString>,
        fail_after_mutation: bool,
        #[serde(skip)]
        output: GameSessionEventQueue,
    }

    impl ManagedGameSession for TransactionalCallbackSession {
        fn session_detach_observation_output(&mut self) -> Option<DrainResult> {
            Some(DrainResult {
                events: std::mem::take(&mut self.output),
            })
        }

        fn session_prepend_observation_output(&mut self, output: Option<DrainResult>) {
            if let Some(mut old_output) = output {
                old_output.events.append(&mut self.output);
                self.output = old_output.events;
            }
        }

        fn session_observe(
            &mut self,
            _allocator: &mut AllocEncoder,
            _height: u64,
            _observations: Option<&[CoinObservation]>,
        ) -> Result<(), Error> {
            Ok(())
        }

        fn session_report_puzzle_and_solution(
            &mut self,
            _allocator: &mut AllocEncoder,
            coin_id: &CoinString,
            _puzzle_and_solution: Option<(&Program, &Program)>,
        ) -> Result<(), Error> {
            if !self.pending.contains(coin_id) {
                return Err(Error::StrErr("no pending callback".to_string()));
            }
            self.durable_mutations.push(coin_id.clone());
            self.output
                .push_back(GameSessionEvent::Log("callback output".to_string()));
            self.output.push_back(watch_event(coin_id, 9));
            self.output
                .push_back(GameSessionEvent::OutboundTransaction(test_submission(
                    "callback submission",
                    None,
                )));
            if self.fail_after_mutation {
                return Err(Error::StrErr(
                    "forced puzzle callback failure after mutation".to_string(),
                ));
            }
            self.pending.remove(coin_id);
            Ok(())
        }

        fn session_flush_and_collect(
            &mut self,
            _allocator: &mut AllocEncoder,
        ) -> Result<DrainResult, Error> {
            Ok(DrainResult {
                events: std::mem::take(&mut self.output),
            })
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
            spend: Some(timeout_submission(coin, spend)),
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
            spend: Some(timeout_submission(coin, spend)),
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
            GameSessionEvent::OutboundTransaction(test_submission("tx-a", None)),
            GameSessionEvent::Log("kept".to_string()),
        ]);
        let mut mgr = TransactionManager::new(mock);

        let drain = mgr.flush_and_collect(&mut allocator).expect("drain");

        // The log is forwarded; the transaction is intercepted.
        assert_eq!(drain.events.len(), 1);
        assert!(matches!(drain.events[0], GameSessionEvent::Log(_)));
        let subs = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].bundle.name.as_deref(), Some("tx-a"));
        // Draining empties the buffer.
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
    }

    #[test]
    fn failed_drain_conversion_keeps_canonical_bytes_and_next_drain_succeeds_once() {
        let mut allocator = AllocEncoder::new();
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::OutboundTransaction(
            test_submission("transactional-drain", None),
        )]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator)
            .expect("capture submission");
        let before = bencodex::to_vec(&mgr).expect("serialize before failed conversion");

        let error = mgr
            .apply_working_copy_transaction(&mut allocator, |working, _allocator| {
                let drained = working.drain_submissions()?;
                assert_eq!(drained.submissions.len(), 1);
                Err::<(), _>(Error::StrErr(
                    "forced JS-facing conversion failure".to_string(),
                ))
            })
            .expect_err("conversion failure must abort the working copy");

        assert!(format!("{error:?}").contains("forced JS-facing conversion failure"));
        assert_eq!(
            bencodex::to_vec(&mgr).expect("serialize after failed conversion"),
            before
        );
        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
    }

    #[test]
    fn failed_finalization_conversion_keeps_canonical_bytes_and_retry_succeeds_once() {
        let (base_bundle, fee_source, target_coin, target) = test_protocol_and_fee_bundles(15);
        let mut mgr = TransactionManager::new(PersistableMockGameSession);
        mgr.pending_submissions.push(PendingSubmission {
            id: None,
            submission: TransactionSubmission::attach_to(base_bundle.clone(), None, &target_coin),
            fee_intent: SubmissionFeeIntent::Attach {
                target,
                amount: Amount::new(15),
                attachment_failure_policy: AttachmentFailurePolicy::SubmitWithoutFee,
            },
        });
        let drained = mgr.drain_submissions().unwrap().submissions.remove(0);
        let before = bencodex::to_vec(&mgr).expect("serialize before failed conversion");
        let mut expected: TransactionManager<PersistableMockGameSession> =
            bencodex::from_slice(&before).expect("clone pre-finalization state");
        let expected_finalized = expected
            .finalize_submission_delivery(
                drained.id,
                drained.goal,
                &drained.variant_fingerprint,
                SubmissionFeeSource::Available(fee_source.clone()),
                &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
                1,
            )
            .expect("valid fee source must upgrade the working state");
        assert_eq!(
            expected_finalized.fee_source_disposition,
            FeeSourceDisposition::Attached
        );
        assert_ne!(expected_finalized.bundle, base_bundle);
        let expected_after = bencodex::to_vec(&expected).expect("serialize upgraded state");
        let mut allocator = AllocEncoder::new();

        let error = mgr
            .apply_working_copy_transaction(&mut allocator, |working, _allocator| {
                let finalized = working.finalize_submission_delivery(
                    drained.id,
                    drained.goal,
                    &drained.variant_fingerprint,
                    SubmissionFeeSource::Available(fee_source.clone()),
                    &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
                    1,
                )?;
                assert_eq!(finalized.bundle, expected_finalized.bundle);
                assert!(matches!(
                    &working.submitted[0].current_variant,
                    SubmissionBroadcastVariant::FeeBearing { .. }
                ));
                assert!(matches!(
                    &working.submitted[0].fee_intent,
                    DurableFeeIntent::Resolved {
                        resolution: FeeResolution::Attached,
                        ..
                    }
                ));
                assert!(finalized.should_broadcast);
                Err::<(), _>(Error::StrErr(
                    "forced finalized JS conversion failure".to_string(),
                ))
            })
            .expect_err("conversion failure must abort finalization");

        assert!(format!("{error:?}").contains("forced finalized JS conversion failure"));
        assert_eq!(
            bencodex::to_vec(&mgr).expect("serialize after failed conversion"),
            before
        );
        let retried = mgr
            .finalize_submission_delivery(
                drained.id,
                drained.goal,
                &drained.variant_fingerprint,
                SubmissionFeeSource::Available(fee_source),
                &Hash::from_bytes(AGG_SIG_ME_ADDITIONAL_DATA),
                1,
            )
            .expect("retry finalization");
        assert_eq!(
            retried.fee_source_disposition,
            FeeSourceDisposition::Attached
        );
        assert_eq!(retried.bundle, expected_finalized.bundle);
        assert_eq!(
            retried.variant_fingerprint,
            expected_finalized.variant_fingerprint
        );
        assert!(retried.should_broadcast);
        assert_eq!(mgr.submitted.len(), 1);
        assert_eq!(mgr.submitted[0].current_bundle(), &retried.bundle);
        assert_eq!(
            bencodex::to_vec(&mgr).expect("serialize retried upgrade"),
            expected_after
        );
    }

    #[test]
    fn serialization_prunes_transient_event_and_watch_delivery_queues() {
        let coin = test_coin(2);
        let mut mgr = TransactionManager::new(PersistableMockGameSession);
        mgr.pending_events
            .push_back(GameSessionEvent::Log("transient".to_string()));
        mgr.pending_watch_coins.push(coin);
        mgr.pending_unwatch_coins.push(test_coin(3));

        let encoded = bencodex::to_vec(&mgr).expect("serialize manager");
        let decoded: TransactionManager<PersistableMockGameSession> =
            bencodex::from_slice(&encoded).expect("deserialize manager");

        assert!(decoded.pending_events.is_empty());
        assert!(decoded.pending_watch_coins.is_empty());
        assert!(decoded.pending_unwatch_coins.is_empty());
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
        mgr.configure_fee(FeeConfiguration {
            amount: Amount::new(10),
            attachment_failure_policy: AttachmentFailurePolicy::SubmitWithoutFee,
        });
        mgr.flush_and_collect(&mut allocator).expect("register");

        let live = vec![CoinStateRecord {
            coin: coin.clone(),
            created_height: Some(10),
            spent_height: None,
        }];

        // Before maturity: nothing submitted.
        mgr.report_coin_states(&mut allocator, 14, &live)
            .expect("report");
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());

        mgr.configure_fee(FeeConfiguration {
            amount: Amount::new(20),
            attachment_failure_policy: AttachmentFailurePolicy::SubmitWithoutFee,
        });
        // Registration only stores a future spend. It first becomes outbound at
        // maturity, so it captures the fee configuration active at height 15.
        mgr.report_coin_states(&mut allocator, 15, &live)
            .expect("report");
        let subs = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(subs.len(), 1);
        assert_eq!(subs[0].bundle.name.as_deref(), Some("timeout-claim"));
        assert!(matches!(
            &subs[0].fee_intent,
            SubmissionFeeIntent::Attach { amount, .. } if amount == &Amount::new(20)
        ));

        // Still mature next block, but already submitted for this birthday.
        mgr.report_coin_states(&mut allocator, 16, &live)
            .expect("report");
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
    }

    #[test]
    fn rejected_timeout_submission_retains_same_intent_without_immediate_retry() {
        let mut allocator = AllocEncoder::new();
        let rejected_coin = test_coin(20);
        let other_coin = test_coin(21);
        let rejected_output = test_coin(22);
        let other_output = test_coin(23);
        let rejected_semantic = TimeoutClaimSemantic::ChannelTimeoutFinish;
        let other_semantic = TimeoutClaimSemantic::GameOpponentTurn {
            id: crate::common::types::GameID(42),
        };
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![
            watch_event_with_timeout_semantic(
                &rejected_coin,
                5,
                test_bundle_spending_creating("rejected-timeout", &rejected_coin, &rejected_output),
                rejected_semantic,
            ),
            watch_event_with_timeout_semantic(
                &other_coin,
                5,
                test_bundle_spending_creating("other-timeout", &other_coin, &other_output),
                other_semantic,
            ),
        ]);
        let mut mgr = TransactionManager::new(mock);
        mgr.configure_fee(FeeConfiguration {
            amount: Amount::new(10),
            attachment_failure_policy: AttachmentFailurePolicy::SubmitWithoutFee,
        });
        mgr.flush_and_collect(&mut allocator).expect("register");

        let live = vec![
            CoinStateRecord {
                coin: rejected_coin.clone(),
                created_height: Some(10),
                spent_height: None,
            },
            CoinStateRecord {
                coin: other_coin.clone(),
                created_height: Some(10),
                spent_height: None,
            },
        ];
        mgr.report_coin_states(&mut allocator, 15, &live)
            .expect("mature claims");
        let first = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(first.len(), 2);
        let rejected = first
            .iter()
            .find(|submission| submission.bundle.name.as_deref() == Some("rejected-timeout"))
            .expect("rejected timeout submission");

        mgr.pending_submissions.push(PendingSubmission {
            id: None,
            submission: test_submission("unrelated", None),
            fee_intent: SubmissionFeeIntent::AlreadyPaid,
        });
        let unrelated = mgr.drain_submissions().unwrap().submissions.remove(0);
        mgr.reject_submission(unrelated.id).unwrap();
        assert!(mgr.cradle().rearmed_timeout_claims.is_empty());
        assert!(mgr.watched_coin(&rejected_coin).unwrap().claim_submitted);
        assert!(mgr.watched_coin(&other_coin).unwrap().claim_submitted);

        // Matching must use the fee intent captured at maturity, not the
        // manager's current configuration.
        mgr.configure_fee(FeeConfiguration {
            amount: Amount::new(20),
            attachment_failure_policy: AttachmentFailurePolicy::SubmitWithoutFee,
        });
        mgr.reject_submission(rejected.id).unwrap();

        assert!(mgr.watched_coin(&rejected_coin).unwrap().claim_submitted);
        assert!(mgr.watched_coin(&other_coin).unwrap().claim_submitted);
        assert!(mgr.cradle().rearmed_timeout_claims.is_empty());

        mgr.report_coin_states(&mut allocator, 15, &live)
            .expect("same mature snapshot");
        let retry = mgr.drain_submissions().unwrap().submissions;
        assert!(retry.is_empty());
        let submitted = &mgr.cradle().submitted_timeout_claims;
        assert_eq!(submitted.len(), 2);
        assert_eq!(
            submitted
                .iter()
                .filter(|semantic| **semantic == rejected_semantic)
                .count(),
            1
        );
        assert_eq!(
            submitted
                .iter()
                .filter(|semantic| **semantic == other_semantic)
                .count(),
            1
        );
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
            spend: Some(timeout_submission(&coin, claim)),
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
        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);
    }

    #[test]
    fn height_only_report_does_not_submit_timeout_before_snapshot() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(14);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::WatchCoin {
            coin_name: coin.to_coin_id(),
            coin_string: coin.clone(),
            timeout: Timeout::new(5),
            spend: Some(timeout_submission(
                &coin,
                test_bundle("height-only-timeout"),
            )),
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

        mgr.report_height(&mut allocator, 15)
            .expect("height-only at maturity");
        assert!(
            mgr.drain_submissions().unwrap().submissions.is_empty(),
            "height-only cannot know the coin is still unspent"
        );
        assert!(mgr.cradle().submitted_timeout_claims.is_empty());

        mgr.report_coin_states(&mut allocator, 15, &live)
            .expect("live snapshot at maturity");
        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);
        assert_eq!(
            mgr.cradle().submitted_timeout_claims,
            vec![TimeoutClaimSemantic::ChannelTimeoutFinish]
        );
    }

    #[test]
    fn timeout_claim_skipped_when_coin_spent_at_maturity() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(19);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::WatchCoin {
            coin_name: coin.to_coin_id(),
            coin_string: coin.clone(),
            timeout: Timeout::new(5),
            spend: Some(timeout_submission(&coin, test_bundle("spent-at-maturity"))),
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
            .expect("height-only at maturity");
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());

        mgr.report_coin_states(
            &mut allocator,
            15,
            &[CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(10),
                spent_height: Some(15),
            }],
        )
        .expect("spent at maturity");
        assert!(
            mgr.drain_submissions().unwrap().submissions.is_empty(),
            "do not timeout-spend a coin already spent when the claim matures"
        );
        assert!(mgr.cradle().submitted_timeout_claims.is_empty());
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
            spend: Some(timeout_submission(&coin, test_bundle("height-only-reorg"))),
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
        mgr.report_coin_states(&mut allocator, 15, &live)
            .expect("mature");
        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);

        mgr.report_height(&mut allocator, 14)
            .expect("height-only rollback");
        assert_eq!(
            mgr.cradle().rearmed_timeout_claims,
            vec![TimeoutClaimSemantic::ChannelTimeoutFinish]
        );
        let replay = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(replay.len(), 1);
        mgr.acknowledge_submission(replay[0].id).unwrap();

        mgr.report_coin_states(&mut allocator, 15, &live)
            .expect("recover maturity");
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
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
            spend: Some(timeout_submission(
                &coin,
                test_bundle("single-rollback-epoch"),
            )),
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
        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);

        // Production first observes the lower trusted tip, then reconciles the
        // same tip from the complete coin snapshot. Height-only re-arms; the
        // snapshot is what requeues the still-live claim.
        mgr.report_height(&mut allocator, 14)
            .expect("lowered height");
        let replay = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(replay.len(), 1);
        mgr.acknowledge_submission(replay[0].id).unwrap();
        mgr.report_coin_states(&mut allocator, 14, &live)
            .expect("same-tip snapshot");
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
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
            spend: Some(timeout_submission(
                &coin,
                test_bundle("confirmed-spend-reorg"),
            )),
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
        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);

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
        let replay = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(replay.len(), 1);
        mgr.acknowledge_submission(replay[0].id).unwrap();

        mgr.report_coin_states(&mut allocator, 15, &live)
            .expect("recover maturity");
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
    }

    #[test]
    fn confirmed_timeout_spend_non_decreasing_reorg_rearms_and_resubmits() {
        for replacement_height in [16, 17] {
            let mut allocator = AllocEncoder::new();
            let coin = test_coin(replacement_height as u8);
            let mut mock = MockGameSession::default();
            mock.queue_drain(vec![GameSessionEvent::WatchCoin {
                coin_name: coin.to_coin_id(),
                coin_string: coin.clone(),
                timeout: Timeout::new(5),
                spend: Some(timeout_submission(
                    &coin,
                    test_bundle("non-decreasing-reorg"),
                )),
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
            assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);
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

            // A heavier replacement chain can restore the coin at the same or
            // a greater height. The explicit spent-to-live transition re-arms
            // the still-mature claim without relying on a height decrease.
            mgr.report_coin_states(&mut allocator, replacement_height, &live)
                .expect("replacement chain restores live coin");
            assert_eq!(mgr.watched_coin(&coin).unwrap().spent_confirmed_at, None);
            assert_eq!(
                mgr.cradle().rearmed_timeout_claims,
                vec![TimeoutClaimSemantic::ChannelTimeoutFinish]
            );
            assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);

            mgr.report_coin_states(&mut allocator, replacement_height + 1, &live)
                .expect("ordinary next snapshot");
            assert!(
                mgr.drain_submissions().unwrap().submissions.is_empty(),
                "re-armed claim must still submit only once"
            );
        }
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
            spend: Some(timeout_submission(&coin, claim)),
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
        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);
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
        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);
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
            spend: Some(timeout_submission(
                &coin,
                test_bundle("channel-timeout-claim"),
            )),
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
        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);

        // The rollback report preserves birthday 10, but must still invalidate
        // the prior maturity observation and canonical submitting state.
        mgr.report_coin_states(&mut allocator, 14, &record)
            .expect("same-birthday rollback");
        assert_eq!(
            mgr.cradle().rearmed_timeout_claims,
            vec![TimeoutClaimSemantic::ChannelTimeoutFinish]
        );
        let replay = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(replay.len(), 1);
        mgr.acknowledge_submission(replay[0].id).unwrap();

        mgr.report_coin_states(&mut allocator, 15, &record)
            .expect("re-mature");
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
    }

    #[test]
    fn mature_game_timeout_claim_records_game_submission_semantic() {
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

        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);
        assert_eq!(
            mgr.cradle().submitted_timeout_claims,
            vec![TimeoutClaimSemantic::GameOpponentTurn { id: game_id }]
        );
    }

    #[test]
    fn timeout_maturity_overflow_stays_unripe_without_blocking_other_claims() {
        let mut allocator = AllocEncoder::new();
        let overflow_coin = test_coin(12);
        let valid_coin = test_coin(13);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![
            watch_event_with_spend(
                &overflow_coin,
                u64::MAX,
                test_bundle("overflowing-timeout-claim"),
            ),
            watch_event_with_spend(&valid_coin, 5, test_bundle("valid-timeout-claim")),
        ]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");

        mgr.report_coin_states(
            &mut allocator,
            15,
            &[
                CoinStateRecord {
                    coin: overflow_coin,
                    created_height: Some(10),
                    spent_height: None,
                },
                CoinStateRecord {
                    coin: valid_coin,
                    created_height: Some(10),
                    spent_height: None,
                },
            ],
        )
        .expect("overflowing maturity must not poison observation");

        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);
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
        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);

        // Reorg re-mines the coin at birthday 13: the claim re-arms and is
        // resubmitted once it matures again at 18.
        mgr.report_coin_states(&mut allocator, 13, &rec(13))
            .expect("report");
        let replay = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(replay.len(), 1);
        mgr.acknowledge_submission(replay[0].id).unwrap();
        mgr.report_coin_states(&mut allocator, 18, &rec(13))
            .expect("report");
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
    }

    #[test]
    fn acknowledged_timeout_spend_is_replayed_once_after_birthday_rollback() {
        let mut allocator = AllocEncoder::new();
        let coin = test_coin(13);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![watch_event_with_spend(
            &coin,
            5,
            test_bundle("acknowledged-timeout-claim"),
        )]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("register");
        let rec = |created: u64| {
            vec![CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(created),
                spent_height: None,
            }]
        };

        mgr.report_coin_states(&mut allocator, 15, &rec(10))
            .expect("mature claim");
        let first = mgr.drain_submissions().unwrap().submissions.remove(0);
        mgr.acknowledge_submission(first.id).unwrap();

        mgr.report_coin_states(&mut allocator, 13, &rec(13))
            .expect("rollback");
        let replay = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].id, first.id);
        mgr.acknowledge_submission(replay[0].id).unwrap();

        mgr.report_coin_states(&mut allocator, 18, &rec(13))
            .expect("re-mature claim");

        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
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
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
    }

    #[test]
    fn reorged_out_output_resubmits_creating_transaction() {
        let mut allocator = AllocEncoder::new();
        // Parent coin spent by the creating transaction; its output is `child`.
        let parent = test_coin(20);
        let child = CoinString::from_parts(
            &parent.to_coin_id(),
            &PuzzleHash::from_bytes([21; 32]),
            &Amount::new(1),
        );
        let creating_tx = test_bundle_spending_creating("create-child", &parent, &child);

        let mut mock = MockGameSession::default();
        // The cradle wants to watch the child and submits the creating tx.
        mock.queue_drain(vec![
            watch_event(&child, 50),
            GameSessionEvent::OutboundTransaction(TransactionSubmission::attach_to(
                creating_tx.clone(),
                None,
                &parent,
            )),
        ]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");

        // The host submits the creating tx; the manager remembers it.
        let submitted = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(submitted.len(), 1);
        mgr.acknowledge_submission(submitted[0].id).unwrap();

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
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());

        // Reorg to height 8 rolls back the child's creating block.  The manager
        // flags it vanished and re-queues the creating transaction.
        mgr.report_coin_states(&mut allocator, 8, &[])
            .expect("report");
        assert!(mgr.vanished_coins().contains(&child));
        let resubmitted = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(resubmitted.len(), 1);
        assert_eq!(resubmitted[0].bundle.name.as_deref(), Some("create-child"));
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
            GameSessionEvent::OutboundTransaction(TransactionSubmission::attach_to(
                creating_tx,
                None,
                &parent,
            )),
        ]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");
        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);

        // Retained transaction outputs are replay/conflict metadata. They do
        // not become host poll targets unless a protocol handler explicitly
        // registers them as watched coins.
        let poll_set = mgr.snapshot_watched_coins();
        assert!(poll_set.contains(&protocol_child));
        assert!(poll_set.contains(&parent));
        assert!(!poll_set.contains(&untracked_child));
    }

    #[test]
    fn reconciliation_only_inputs_are_not_forwarded_to_the_cradle() {
        let mut allocator = AllocEncoder::new();
        let input = test_coin(36);
        let watched_child = CoinString::from_parts(
            &input.to_coin_id(),
            &PuzzleHash::from_bytes([37; 32]),
            &Amount::new(1),
        );
        let spend_tx =
            test_bundle_spending_creating("create-watched-child", &input, &watched_child);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![
            watch_event(&watched_child, 50),
            GameSessionEvent::OutboundTransaction(TransactionSubmission::already_paid(
                spend_tx, None,
            )),
        ]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");
        let submission = mgr.drain_submissions().unwrap().submissions.remove(0);
        mgr.acknowledge_submission(submission.id).unwrap();

        mgr.report_coin_states(
            &mut allocator,
            10,
            &[
                CoinStateRecord {
                    coin: input.clone(),
                    created_height: Some(5),
                    spent_height: None,
                },
                CoinStateRecord {
                    coin: watched_child.clone(),
                    created_height: None,
                    spent_height: None,
                },
            ],
        )
        .expect("unlanded report");
        assert!(mgr.cradle().seen_observations[0].1.is_empty());

        mgr.report_coin_states(
            &mut allocator,
            11,
            &[
                CoinStateRecord {
                    coin: input,
                    created_height: Some(5),
                    spent_height: Some(11),
                },
                CoinStateRecord {
                    coin: watched_child.clone(),
                    created_height: Some(11),
                    spent_height: None,
                },
            ],
        )
        .expect("landed report");
        assert_eq!(
            mgr.cradle().seen_observations[1].1,
            vec![CoinObservation::Created(watched_child)]
        );
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
    fn coin_height_above_peak_is_rejected_without_touching_state() {
        let mut allocator = AllocEncoder::new();
        for (created_height, spent_height) in [(Some(11), None), (Some(5), Some(11))] {
            let mut mgr = TransactionManager::new(PersistableMockGameSession);
            let before = bencodex::to_vec(&mgr).expect("serialize before rejection");
            let error = mgr
                .report_coin_states(
                    &mut allocator,
                    10,
                    &[CoinStateRecord {
                        coin: test_coin(17),
                        created_height,
                        spent_height,
                    }],
                )
                .expect_err("height above peak must fail");
            assert!(format!("{error:?}").contains("exceeds supplied peak"));
            assert_eq!(
                bencodex::to_vec(&mgr).expect("serialize after rejection"),
                before
            );
        }
    }

    #[test]
    fn failed_coin_observation_is_byte_identical_and_repeatable() {
        let mut allocator = AllocEncoder::new();
        allocator
            .allocator()
            .new_atom(b"caller-owned allocation")
            .expect("caller allocation");
        let caller_live_bytes = allocator.allocator_ref().heap_size();
        let coin = test_coin(18);
        let mut mgr = TransactionManager::new(LateFailingObservationSession::default());
        mgr.register_watch(coin.clone(), Timeout::new(50), None, None);
        let records = [CoinStateRecord {
            coin,
            created_height: Some(10),
            spent_height: None,
        }];
        let before = bencodex::to_vec(&mgr).expect("serialize before observation");

        for _ in 0..2 {
            let error = mgr
                .report_coin_states(&mut allocator, 10, &records)
                .expect_err("late callback failure");
            assert!(format!("{error:?}").contains("forced late observation callback failure"));
            assert_eq!(
                bencodex::to_vec(&mgr).expect("serialize after observation"),
                before
            );
            assert_eq!(
                allocator.allocator_ref().heap_size(),
                caller_live_bytes,
                "failed callback allocations must stay in the scratch allocator"
            );
        }
    }

    #[test]
    fn failed_height_only_observation_is_byte_identical_and_repeatable() {
        let mut allocator = AllocEncoder::new();
        let mut mgr = TransactionManager::new(LateFailingObservationSession::default());
        let before = bencodex::to_vec(&mgr).expect("serialize before observation");

        for _ in 0..2 {
            let error = mgr
                .report_height(&mut allocator, 10)
                .expect_err("late callback failure");
            assert!(format!("{error:?}").contains("forced late observation callback failure"));
            assert_eq!(
                bencodex::to_vec(&mgr).expect("serialize after observation"),
                before
            );
        }
    }

    #[test]
    fn observation_success_prepends_existing_transient_output() {
        let mut allocator = AllocEncoder::new();
        let old_watch = test_coin(19);
        let old_unwatch = test_coin(20);
        let mut session = LateFailingObservationSession {
            fail: false,
            ..Default::default()
        };
        session
            .output
            .push_back(GameSessionEvent::Log("session output before".to_string()));
        let mut mgr = TransactionManager::new(session);
        mgr.pending_events
            .push_back(GameSessionEvent::Log("manager output before".to_string()));
        mgr.pending_watch_coins.push(old_watch.clone());
        mgr.pending_unwatch_coins.push(old_unwatch.clone());

        mgr.report_height(&mut allocator, 10)
            .expect("successful observation");
        assert_eq!(mgr.cradle().callback_mutations.len(), 1);
        assert_eq!(mgr.cradle().callback_programs.len(), 1);
        assert!(mgr.cradle().callback_programs[0].bytes().len() > 8 * 1024);
        let drain = mgr
            .flush_and_collect(&mut allocator)
            .expect("collect ordered output");
        let logs = drain
            .events
            .into_iter()
            .map(|event| match event {
                GameSessionEvent::Log(message) => message,
                other => panic!("unexpected event {other:?}"),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            logs,
            [
                "manager output before",
                "session output before",
                "observation callback output"
            ]
        );
        assert_eq!(drain.watch_coins, [old_watch]);
        assert_eq!(drain.unwatch_coins, [old_unwatch]);
    }

    #[test]
    fn observation_failure_restores_existing_transient_output_unchanged() {
        let mut allocator = AllocEncoder::new();
        let old_watch = test_coin(21);
        let old_unwatch = test_coin(22);
        let mut session = LateFailingObservationSession::default();
        session
            .output
            .push_back(GameSessionEvent::Log("session output before".to_string()));
        let mut mgr = TransactionManager::new(session);
        mgr.pending_events
            .push_back(GameSessionEvent::Log("manager output before".to_string()));
        mgr.pending_watch_coins.push(old_watch.clone());
        mgr.pending_unwatch_coins.push(old_unwatch.clone());
        let before = bencodex::to_vec(&mgr).expect("serialize before observation");

        mgr.report_height(&mut allocator, 10)
            .expect_err("late callback failure");
        assert_eq!(
            bencodex::to_vec(&mgr).expect("serialize after observation"),
            before
        );
        let drain = mgr
            .flush_and_collect(&mut allocator)
            .expect("collect restored output");
        let logs = drain
            .events
            .into_iter()
            .map(|event| match event {
                GameSessionEvent::Log(message) => message,
                other => panic!("unexpected event {other:?}"),
            })
            .collect::<Vec<_>>();
        assert_eq!(logs, ["manager output before", "session output before"]);
        assert_eq!(drain.watch_coins, [old_watch]);
        assert_eq!(drain.unwatch_coins, [old_unwatch]);
    }

    #[test]
    fn puzzle_callback_failure_restores_durable_and_transient_manager_state_exactly() {
        let mut allocator = AllocEncoder::new();
        let requested = test_coin(23);
        let old_watch = test_coin(24);
        let old_unwatch = test_coin(25);
        let mut session = TransactionalCallbackSession {
            pending: std::collections::BTreeSet::from([requested.clone()]),
            durable_mutations: Vec::new(),
            fail_after_mutation: true,
            output: GameSessionEventQueue::from([GameSessionEvent::Log(
                "session output before".to_string(),
            )]),
        };
        session
            .output
            .push_back(GameSessionEvent::Log("session output second".to_string()));
        let mut mgr = TransactionManager::new(session);
        mgr.pending_events
            .push_back(GameSessionEvent::Log("manager output before".to_string()));
        mgr.pending_watch_coins.push(old_watch.clone());
        mgr.pending_unwatch_coins.push(old_unwatch.clone());
        mgr.pending_submissions.push(PendingSubmission {
            id: None,
            submission: test_submission("existing submission", None),
            fee_intent: SubmissionFeeIntent::AlreadyPaid,
        });
        let before = bencodex::to_vec(&mgr).expect("serialize callback checkpoint");

        let error = mgr
            .report_puzzle_and_solution(&mut allocator, &requested, None)
            .expect_err("late callback failure");
        assert!(format!("{error:?}").contains("forced puzzle callback failure after mutation"));
        assert_eq!(
            bencodex::to_vec(&mgr).expect("serialize after callback"),
            before,
            "durable manager and nested phase state must roll back byte-for-byte"
        );
        assert_eq!(
            mgr.cradle.pending,
            std::collections::BTreeSet::from([requested])
        );
        assert!(mgr.cradle.durable_mutations.is_empty());

        let drain = mgr
            .flush_and_collect(&mut allocator)
            .expect("collect restored transient output");
        let logs = drain
            .events
            .into_iter()
            .map(|event| match event {
                GameSessionEvent::Log(message) => message,
                other => panic!("unexpected event {other:?}"),
            })
            .collect::<Vec<_>>();
        assert_eq!(
            logs,
            [
                "manager output before",
                "session output before",
                "session output second"
            ]
        );
        assert_eq!(drain.watch_coins, [old_watch]);
        assert_eq!(drain.unwatch_coins, [old_unwatch]);
        assert_eq!(
            mgr.drain_submissions()
                .expect("pre-existing submission remains")
                .submissions
                .len(),
            1
        );
    }

    #[test]
    fn puzzle_callback_success_commits_and_retires_pending_request_once() {
        let mut allocator = AllocEncoder::new();
        let requested = test_coin(26);
        let session = TransactionalCallbackSession {
            pending: std::collections::BTreeSet::from([requested.clone()]),
            durable_mutations: Vec::new(),
            fail_after_mutation: false,
            output: GameSessionEventQueue::default(),
        };
        let mut mgr = TransactionManager::new(session);

        mgr.report_puzzle_and_solution(&mut allocator, &requested, None)
            .expect("successful callback");
        assert!(mgr.cradle.pending.is_empty());
        assert_eq!(mgr.cradle.durable_mutations, [requested.clone()]);
        let drain = mgr
            .flush_and_collect(&mut allocator)
            .expect("collect committed callback output");
        assert_eq!(drain.watch_coins, [requested.clone()]);
        assert!(drain.events.iter().any(
            |event| matches!(event, GameSessionEvent::Log(message) if message == "callback output")
        ));
        assert_eq!(
            mgr.drain_submissions()
                .expect("callback submission")
                .submissions
                .len(),
            1
        );

        mgr.report_puzzle_and_solution(&mut allocator, &requested, None)
            .expect_err("retired request cannot complete twice");
        assert_eq!(mgr.cradle.durable_mutations, [requested]);
    }

    #[test]
    fn mock_observation_transaction_preserves_scripted_drain_sequence() {
        let mut allocator = AllocEncoder::new();
        let mut session = MockGameSession::default();
        session.queue_drain(vec![GameSessionEvent::Log("first".to_string())]);
        session.queue_drain(vec![GameSessionEvent::Log("second".to_string())]);
        let mut mgr = TransactionManager::new(session);

        mgr.report_height(&mut allocator, 10)
            .expect("successful observation");
        for expected in ["first", "second"] {
            let drain = mgr
                .flush_and_collect(&mut allocator)
                .expect("scripted drain");
            assert!(matches!(
                drain.events.front(),
                Some(GameSessionEvent::Log(message)) if message == expected
            ));
        }
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
    fn requeue_submitted_replays_retained_transactions() {
        let mut allocator = AllocEncoder::new();
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::OutboundTransaction(
            test_submission("tx-a", None),
        )]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");

        // The host drains it once; the manager retains it for replay.
        let first = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(first.len(), 1);
        // A fresh drain is empty -- the pending buffer was emptied.
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());

        // On reload, requeue replays the retained set so any transaction that
        // was drained but may not have reached the network is submitted again.
        mgr.requeue_submitted();
        mgr.requeue_submitted();
        let replay = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].id, first[0].id);
        assert_eq!(replay[0].bundle.name.as_deref(), Some("tx-a"));
    }

    #[test]
    fn same_input_different_content_gets_distinct_ids_and_both_drain() {
        let input = test_coin(50);
        let output_a = CoinString::from_parts(
            &input.to_coin_id(),
            &PuzzleHash::from_bytes([51; 32]),
            &Amount::new(1),
        );
        let output_b = CoinString::from_parts(
            &input.to_coin_id(),
            &PuzzleHash::from_bytes([52; 32]),
            &Amount::new(1),
        );
        let mut mgr = TransactionManager::new(PersistableMockGameSession);
        mgr.pending_submissions.extend([
            PendingSubmission {
                id: None,
                submission: TransactionSubmission::already_paid(
                    test_bundle_spending_creating("first", &input, &output_a),
                    None,
                ),
                fee_intent: SubmissionFeeIntent::AlreadyPaid,
            },
            PendingSubmission {
                id: None,
                submission: TransactionSubmission::already_paid(
                    test_bundle_spending_creating("second", &input, &output_b),
                    None,
                ),
                fee_intent: SubmissionFeeIntent::AlreadyPaid,
            },
        ]);

        let drained = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(drained.len(), 2);
        assert_ne!(drained[0].id, drained[1].id);
        assert_eq!(mgr.submitted.len(), 2);
    }

    #[test]
    fn drain_submissions_quarantines_one_invalid_candidate_and_commits_later_work() {
        let input_a = test_coin(170);
        let input_b = test_coin(171);
        let input_c = test_coin(172);
        let output_a = test_coin(173);
        let output_c = test_coin(174);
        let mut mgr = TransactionManager::new(PersistableMockGameSession);
        mgr.pending_submissions.extend([
            PendingSubmission {
                id: None,
                submission: TransactionSubmission::already_paid(
                    test_bundle_spending_creating("candidate-a", &input_a, &output_a),
                    None,
                ),
                fee_intent: SubmissionFeeIntent::AlreadyPaid,
            },
            PendingSubmission {
                id: None,
                submission: TransactionSubmission::already_paid(
                    test_bundle_with_invalid_conditions("candidate-b", &input_b),
                    None,
                ),
                fee_intent: SubmissionFeeIntent::AlreadyPaid,
            },
            PendingSubmission {
                id: None,
                submission: TransactionSubmission::already_paid(
                    test_bundle_spending_creating("candidate-c", &input_c, &output_c),
                    None,
                ),
                fee_intent: SubmissionFeeIntent::AlreadyPaid,
            },
        ]);

        let drained = mgr.drain_submissions().expect("item-local drain");

        assert_eq!(
            drained
                .submissions
                .iter()
                .map(|submission| submission.bundle.name.as_deref())
                .collect::<Vec<_>>(),
            vec![Some("candidate-a"), Some("candidate-c")]
        );
        assert_eq!(
            drained
                .submissions
                .iter()
                .map(|submission| submission.id)
                .collect::<Vec<_>>(),
            vec![0, 1],
            "the failed candidate must not consume or collide with a durable id"
        );
        assert_eq!(drained.failures.len(), 1);
        assert_eq!(drained.failures[0].candidate_index, 1);
        assert_eq!(
            drained.failures[0].stage,
            SubmissionDrainFailureStage::ExpectedOutputs
        );
        assert_eq!(drained.failures[0].candidate_submission_id, Some(1));
        assert!(drained.failures[0].intent_fingerprint.is_some());
        assert_eq!(mgr.submitted.len(), 2);
        assert_eq!(mgr.next_submission_id, 2);
        assert!(mgr
            .submitted
            .iter()
            .all(|submission| submission.base_bundle.name.as_deref() != Some("candidate-b")));

        let next = mgr
            .drain_submissions()
            .expect("quarantined candidate stays consumed");
        assert!(next.submissions.is_empty());
        assert!(next.failures.is_empty());
    }

    #[test]
    fn abandoning_fee_bearing_unavailable_submission_emits_retirement() {
        let input = test_coin(175);
        let output = test_coin(176);
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::OutboundTransaction(
            TransactionSubmission::attach_to(
                test_bundle_spending_creating("fee-bearing", &input, &output),
                None,
                &input,
            ),
        )]);
        let mut mgr = TransactionManager::new(mock);
        let mut allocator = AllocEncoder::new();
        mgr.configure_fee(FeeConfiguration {
            amount: Amount::new(10),
            attachment_failure_policy: AttachmentFailurePolicy::SubmitWithoutFee,
        });
        mgr.flush_and_collect(&mut allocator)
            .expect("capture submission");
        let submission = mgr
            .drain_submissions()
            .expect("drain submission")
            .submissions
            .remove(0);
        mgr.submitted[0].current_variant = SubmissionBroadcastVariant::FeeBearing {
            bundle: mgr.submitted[0].base_bundle.clone(),
            applied_fee: 10,
        };
        let intent = mgr.submitted[0].canonical_fee_intent().clone();
        mgr.submitted[0].fee_intent = DurableFeeIntent::Resolved {
            intent,
            resolution: FeeResolution::Attached,
        };
        assert!(mgr.drain_retired_submission_ids().is_empty());

        mgr.cradle.abandoned = true;
        mgr.flush_and_collect(&mut allocator)
            .expect("abandon local artifacts");

        assert!(mgr.submitted.is_empty());
        assert_eq!(mgr.drain_retired_submission_ids(), vec![submission.id]);
        assert!(mgr.drain_retired_submission_ids().is_empty());
    }

    #[test]
    fn exact_duplicate_uses_same_id_without_duplicate_retained_intent() {
        let input = test_coin(53);
        let output = CoinString::from_parts(
            &input.to_coin_id(),
            &PuzzleHash::from_bytes([54; 32]),
            &Amount::new(1),
        );
        let first_bundle = test_bundle_spending_creating("diagnostic-name-a", &input, &output);
        let mut renamed_bundle = first_bundle.clone();
        renamed_bundle.name = Some("diagnostic-name-b".to_string());
        let mut mgr = TransactionManager::new(PersistableMockGameSession);
        for bundle in [first_bundle, renamed_bundle] {
            mgr.pending_submissions.push(PendingSubmission {
                id: None,
                submission: TransactionSubmission::already_paid(bundle, Some(100)),
                fee_intent: SubmissionFeeIntent::AlreadyPaid,
            });
        }

        let first = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(first.len(), 1);
        assert_eq!(mgr.submitted.len(), 1);

        mgr.pending_submissions.push(PendingSubmission {
            id: None,
            submission: TransactionSubmission::already_paid(
                test_bundle_spending_creating("third-name", &input, &output),
                Some(100),
            ),
            fee_intent: SubmissionFeeIntent::AlreadyPaid,
        });
        let duplicate = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(duplicate.len(), 1);
        assert_eq!(duplicate[0].id, first[0].id);
        assert_eq!(mgr.submitted.len(), 1);

        mgr.acknowledge_submission(first[0].id).unwrap();
        mgr.pending_submissions.push(PendingSubmission {
            id: None,
            submission: TransactionSubmission::already_paid(
                test_bundle_spending_creating("fourth-name", &input, &output),
                Some(100),
            ),
            fee_intent: SubmissionFeeIntent::AlreadyPaid,
        });
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
        assert_eq!(mgr.submitted.len(), 1);
    }

    #[test]
    fn rejecting_one_id_does_not_suppress_new_same_input_intent() {
        let input = test_coin(55);
        let output_a = CoinString::from_parts(
            &input.to_coin_id(),
            &PuzzleHash::from_bytes([56; 32]),
            &Amount::new(1),
        );
        let output_b = CoinString::from_parts(
            &input.to_coin_id(),
            &PuzzleHash::from_bytes([57; 32]),
            &Amount::new(1),
        );
        let mut mgr = TransactionManager::new(PersistableMockGameSession);
        mgr.pending_submissions.push(PendingSubmission {
            id: None,
            submission: TransactionSubmission::already_paid(
                test_bundle_spending_creating("rejected", &input, &output_a),
                None,
            ),
            fee_intent: SubmissionFeeIntent::AlreadyPaid,
        });
        let rejected = mgr.drain_submissions().unwrap().submissions.remove(0);
        mgr.reject_submission(rejected.id).unwrap();

        mgr.pending_submissions.push(PendingSubmission {
            id: None,
            submission: TransactionSubmission::already_paid(
                test_bundle_spending_creating("new-intent", &input, &output_b),
                None,
            ),
            fee_intent: SubmissionFeeIntent::AlreadyPaid,
        });
        let replacement = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(replacement.len(), 1);
        assert_ne!(replacement[0].id, rejected.id);
    }

    #[test]
    fn acknowledged_submission_is_retained_but_not_requeued() {
        let mut allocator = AllocEncoder::new();
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::OutboundTransaction(
            test_submission("acknowledged", None),
        )]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");
        let submission = mgr.drain_submissions().unwrap().submissions.remove(0);

        mgr.acknowledge_submission(submission.id).unwrap();
        mgr.requeue_submitted();

        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
        assert_eq!(mgr.submitted.len(), 1);
        assert_eq!(
            mgr.submitted[0].wallet_acknowledged_variant,
            Some(submission.variant_fingerprint)
        );
    }

    #[test]
    fn rejected_submission_waits_for_explicit_rebroadcast_epoch() {
        let mut allocator = AllocEncoder::new();
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::OutboundTransaction(
            test_submission("rejected", None),
        )]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");
        let submission = mgr.drain_submissions().unwrap().submissions.remove(0);

        mgr.reject_submission(submission.id).unwrap();
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
        mgr.requeue_submitted();

        let replay = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].id, submission.id);
        assert_eq!(mgr.submitted.len(), 1);
        assert!(mgr.drain_retired_submission_ids().is_empty());
    }

    #[test]
    fn height_rollback_replays_all_acknowledged_retained_intents_once() {
        let input_a = test_coin(58);
        let input_b = test_coin(59);
        let output_a = CoinString::from_parts(
            &input_a.to_coin_id(),
            &PuzzleHash::from_bytes([60; 32]),
            &Amount::new(1),
        );
        let output_b = CoinString::from_parts(
            &input_b.to_coin_id(),
            &PuzzleHash::from_bytes([61; 32]),
            &Amount::new(1),
        );
        let mut mgr = TransactionManager::new(PersistableMockGameSession);
        for (name, input, output) in [
            ("rollback-a", &input_a, &output_a),
            ("rollback-b", &input_b, &output_b),
        ] {
            mgr.pending_submissions.push(PendingSubmission {
                id: None,
                submission: TransactionSubmission::already_paid(
                    test_bundle_spending_creating(name, input, output),
                    None,
                ),
                fee_intent: SubmissionFeeIntent::AlreadyPaid,
            });
        }
        let first = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(first.len(), 2);
        for submission in &first {
            mgr.acknowledge_submission(submission.id).unwrap();
        }

        let mut allocator = AllocEncoder::new();
        mgr.report_height(&mut allocator, 20).unwrap();
        mgr.requeue_submitted();
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());

        mgr.report_height(&mut allocator, 19).unwrap();
        mgr.report_height(&mut allocator, 19).unwrap();
        let replay = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(replay.len(), 2);
        assert_eq!(
            replay
                .iter()
                .map(|submission| submission.id)
                .collect::<HashSet<_>>(),
            first.iter().map(|submission| submission.id).collect()
        );
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());

        for submission in replay {
            mgr.acknowledge_submission(submission.id).unwrap();
        }
        mgr.report_height(&mut allocator, 20).unwrap();
        mgr.report_height(&mut allocator, 19).unwrap();
        assert_eq!(
            mgr.drain_submissions().unwrap().submissions.len(),
            2,
            "a later rollback must begin a new replay epoch"
        );
    }

    #[test]
    fn height_then_same_tip_vanished_snapshot_replays_creator_once() {
        let input = test_coin(62);
        let output = CoinString::from_parts(
            &input.to_coin_id(),
            &PuzzleHash::from_bytes([63; 32]),
            &Amount::new(1),
        );
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![
            watch_event(&output, 50),
            GameSessionEvent::OutboundTransaction(TransactionSubmission::already_paid(
                test_bundle_spending_creating("creator", &input, &output),
                None,
            )),
        ]);
        let mut mgr = TransactionManager::new(mock);
        let mut allocator = AllocEncoder::new();
        mgr.flush_and_collect(&mut allocator).unwrap();
        let first = mgr.drain_submissions().unwrap().submissions.remove(0);
        mgr.acknowledge_submission(first.id).unwrap();
        mgr.report_coin_states(
            &mut allocator,
            15,
            &[CoinStateRecord {
                coin: output,
                created_height: Some(15),
                spent_height: None,
            }],
        )
        .unwrap();

        mgr.report_height(&mut allocator, 14).unwrap();
        let replay = mgr.drain_submissions().unwrap().submissions.remove(0);
        assert_eq!(replay.id, first.id);
        mgr.acknowledge_submission(replay.id).unwrap();

        mgr.report_coin_states(&mut allocator, 14, &[]).unwrap();
        assert!(
            mgr.drain_submissions().unwrap().submissions.is_empty(),
            "the same-tip vanished-output snapshot belongs to the height rollback epoch"
        );
    }

    #[test]
    fn height_only_rollback_replay_survives_drain_failure_and_restore() {
        let input = test_coin(64);
        let output = CoinString::from_parts(
            &input.to_coin_id(),
            &PuzzleHash::from_bytes([65; 32]),
            &Amount::new(1),
        );
        let protocol_bundle = test_bundle_spending_creating("rollback-protocol", &input, &output);
        let fee_bearing_bundle =
            test_bundle_spending_creating("rollback-fee-bearing", &input, &output);
        let mut mgr = TransactionManager::new(PersistableMockGameSession);
        mgr.register_watch(output.clone(), Timeout::new(50), None, None);
        mgr.pending_submissions.push(PendingSubmission {
            id: None,
            submission: TransactionSubmission::already_paid(protocol_bundle, None),
            fee_intent: SubmissionFeeIntent::AlreadyPaid,
        });
        let first = mgr.drain_submissions().unwrap().submissions.remove(0);
        let retained = mgr
            .submitted
            .iter_mut()
            .find(|tx| tx.id == first.id)
            .expect("retained submission");
        retained.current_variant = SubmissionBroadcastVariant::FeeBearing {
            bundle: fee_bearing_bundle.clone(),
            applied_fee: 42,
        };
        retained.fee_intent = DurableFeeIntent::Resolved {
            intent: SubmissionFeeIntent::AlreadyPaid,
            resolution: FeeResolution::Attached,
        };
        mgr.acknowledge_submission(first.id).unwrap();

        let mut allocator = AllocEncoder::new();
        mgr.report_coin_states(
            &mut allocator,
            20,
            &[
                CoinStateRecord {
                    coin: input.clone(),
                    created_height: Some(10),
                    spent_height: Some(20),
                },
                CoinStateRecord {
                    coin: output.clone(),
                    created_height: Some(20),
                    spent_height: None,
                },
            ],
        )
        .unwrap();
        assert_eq!(
            mgr.submitted[0].chain_terminality,
            SubmissionChainTerminality::Landed
        );

        mgr.report_height(&mut allocator, 19).unwrap();
        let rollback_replay = mgr.drain_submissions().unwrap().submissions.remove(0);
        assert_eq!(rollback_replay.id, first.id);
        assert_eq!(rollback_replay.bundle, fee_bearing_bundle);
        assert_eq!(rollback_replay.fee_intent, SubmissionFeeIntent::AlreadyPaid);
        assert_eq!(
            mgr.submitted[0].chain_terminality,
            SubmissionChainTerminality::Active
        );

        // The host failed to complete submission and reloads before the
        // authoritative same-tip coin snapshot arrives.
        let encoded = bencodex::to_vec(&mgr).expect("serialize manager");
        let mut restored: TransactionManager<PersistableMockGameSession> =
            bencodex::from_slice(&encoded).expect("restore manager");
        assert!(restored.snapshot_watched_coins().contains(&input));

        restored
            .report_coin_states(
                &mut allocator,
                19,
                &[CoinStateRecord {
                    coin: input,
                    created_height: Some(10),
                    spent_height: None,
                }],
            )
            .unwrap();
        restored.requeue_submitted();
        let replay_after_restore = restored.drain_submissions().unwrap().submissions;
        assert_eq!(replay_after_restore.len(), 1);
        assert_eq!(replay_after_restore[0].id, first.id);
        assert_eq!(replay_after_restore[0].bundle, fee_bearing_bundle);
        assert_eq!(
            replay_after_restore[0].fee_intent,
            SubmissionFeeIntent::AlreadyPaid
        );
        restored
            .acknowledge_submission(replay_after_restore[0].id)
            .unwrap();
        restored.requeue_submitted();
        assert!(restored.drain_submissions().unwrap().submissions.is_empty());

        let encoded = bencodex::to_vec(&restored).expect("serialize acknowledged replay");
        let mut restored_again: TransactionManager<PersistableMockGameSession> =
            bencodex::from_slice(&encoded).expect("restore acknowledged replay");
        restored_again.requeue_submitted();
        assert!(restored_again
            .drain_submissions()
            .unwrap()
            .submissions
            .is_empty());
    }

    #[test]
    fn equal_or_higher_tip_spend_reversal_replays_acknowledged_intent() {
        for replacement_height in [11, 12] {
            let input = test_coin(replacement_height as u8 + 70);
            let output = CoinString::from_parts(
                &input.to_coin_id(),
                &PuzzleHash::from_bytes([replacement_height as u8 + 80; 32]),
                &Amount::new(1),
            );
            let mut mock = MockGameSession::default();
            mock.queue_drain(vec![
                watch_event(&input, 50),
                watch_event(&output, 50),
                GameSessionEvent::OutboundTransaction(TransactionSubmission::already_paid(
                    test_bundle_spending_creating("spend-reversal", &input, &output),
                    None,
                )),
            ]);
            let mut mgr = TransactionManager::new(mock);
            let mut allocator = AllocEncoder::new();
            mgr.flush_and_collect(&mut allocator).unwrap();
            let first = mgr.drain_submissions().unwrap().submissions.remove(0);
            mgr.acknowledge_submission(first.id).unwrap();

            mgr.report_coin_states(
                &mut allocator,
                11,
                &[
                    CoinStateRecord {
                        coin: input.clone(),
                        created_height: Some(10),
                        spent_height: Some(11),
                    },
                    CoinStateRecord {
                        coin: output.clone(),
                        created_height: Some(11),
                        spent_height: None,
                    },
                ],
            )
            .unwrap();
            assert!(mgr.drain_submissions().unwrap().submissions.is_empty());

            mgr.report_coin_states(
                &mut allocator,
                replacement_height,
                &[
                    CoinStateRecord {
                        coin: input.clone(),
                        created_height: Some(10),
                        spent_height: None,
                    },
                    CoinStateRecord {
                        coin: output.clone(),
                        created_height: None,
                        spent_height: None,
                    },
                ],
            )
            .unwrap();
            let replay = mgr.drain_submissions().unwrap().submissions;
            assert_eq!(replay.len(), 1);
            assert_eq!(replay[0].id, first.id);
            assert_eq!(
                mgr.cradle().seen_observations.last().unwrap().1,
                vec![CoinObservation::Created(input.clone())]
            );

            mgr.report_coin_states(
                &mut allocator,
                replacement_height,
                &[
                    CoinStateRecord {
                        coin: input,
                        created_height: Some(10),
                        spent_height: None,
                    },
                    CoinStateRecord {
                        coin: output,
                        created_height: None,
                        spent_height: None,
                    },
                ],
            )
            .unwrap();
            assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
        }
    }

    #[test]
    fn restored_equal_or_higher_tip_reorg_replays_exact_current_variant_per_epoch() {
        for replacement_height in [21, 22] {
            let input = test_coin(replacement_height as u8 + 70);
            let output = CoinString::from_parts(
                &input.to_coin_id(),
                &PuzzleHash::from_bytes([replacement_height as u8 + 80; 32]),
                &Amount::new(1),
            );
            let protocol_bundle =
                test_bundle_spending_creating("offline-protocol", &input, &output);
            let fee_bearing_bundle =
                test_bundle_spending_creating("offline-fee-bearing", &input, &output);
            let mut mgr = TransactionManager::new(PersistableMockGameSession);
            mgr.register_watch(input.clone(), Timeout::new(50), None, None);
            mgr.register_watch(output.clone(), Timeout::new(50), None, None);
            mgr.pending_submissions.push(PendingSubmission {
                id: None,
                submission: TransactionSubmission::already_paid(protocol_bundle, None),
                fee_intent: SubmissionFeeIntent::AlreadyPaid,
            });
            let first = mgr.drain_submissions().unwrap().submissions.remove(0);
            let retained = mgr
                .submitted
                .iter_mut()
                .find(|tx| tx.id == first.id)
                .unwrap();
            retained.current_variant = SubmissionBroadcastVariant::FeeBearing {
                bundle: fee_bearing_bundle.clone(),
                applied_fee: 42,
            };
            retained.fee_intent = DurableFeeIntent::Resolved {
                intent: SubmissionFeeIntent::AlreadyPaid,
                resolution: FeeResolution::Attached,
            };
            mgr.acknowledge_submission(first.id).unwrap();

            let mut allocator = AllocEncoder::new();
            mgr.report_coin_states(
                &mut allocator,
                21,
                &[
                    CoinStateRecord {
                        coin: input.clone(),
                        created_height: Some(20),
                        spent_height: Some(21),
                    },
                    CoinStateRecord {
                        coin: output.clone(),
                        created_height: Some(21),
                        spent_height: None,
                    },
                ],
            )
            .unwrap();

            let encoded = bencodex::to_vec(&mgr).unwrap();
            let mut restored: TransactionManager<PersistableMockGameSession> =
                bencodex::from_slice(&encoded).unwrap();
            assert!(restored.snapshot_watched_coins().contains(&input));

            let replacement = [
                CoinStateRecord {
                    coin: input.clone(),
                    created_height: Some(20),
                    spent_height: None,
                },
                CoinStateRecord {
                    coin: output.clone(),
                    created_height: None,
                    spent_height: None,
                },
            ];
            restored
                .report_coin_states(&mut allocator, replacement_height, &replacement)
                .unwrap();
            let first_epoch = restored.drain_submissions().unwrap().submissions;
            assert_eq!(first_epoch.len(), 1);
            assert_eq!(first_epoch[0].id, first.id);
            assert_eq!(first_epoch[0].bundle, fee_bearing_bundle);
            assert_eq!(first_epoch[0].fee_intent, SubmissionFeeIntent::AlreadyPaid);
            restored.acknowledge_submission(first.id).unwrap();

            restored
                .report_coin_states(&mut allocator, replacement_height, &replacement)
                .unwrap();
            assert!(restored.drain_submissions().unwrap().submissions.is_empty());

            let remine_height = replacement_height + 1;
            restored
                .report_coin_states(
                    &mut allocator,
                    remine_height,
                    &[
                        CoinStateRecord {
                            coin: input.clone(),
                            created_height: Some(20),
                            spent_height: Some(remine_height),
                        },
                        CoinStateRecord {
                            coin: output.clone(),
                            created_height: Some(remine_height),
                            spent_height: None,
                        },
                    ],
                )
                .unwrap();
            assert_eq!(
                restored.submitted[0].chain_terminality,
                SubmissionChainTerminality::Landed
            );

            restored
                .report_coin_states(&mut allocator, remine_height, &replacement)
                .unwrap();
            let second_epoch = restored.drain_submissions().unwrap().submissions;
            assert_eq!(second_epoch.len(), 1);
            assert_eq!(second_epoch[0].id, first.id);
            assert_eq!(second_epoch[0].bundle, fee_bearing_bundle);
        }
    }

    #[test]
    fn restored_manager_requeues_retained_on_chain_submission() {
        let mut manager = TransactionManager::new(PersistableMockGameSession);
        manager.configure_fee(FeeConfiguration {
            amount: Amount::new(42),
            attachment_failure_policy: AttachmentFailurePolicy::SubmitWithoutFee,
        });
        let fee_target = CoinID::new(Hash::from_bytes([0x55; 32]));
        manager.pending_submissions.push(PendingSubmission {
            id: None,
            submission: TransactionSubmission {
                bundle: test_bundle("restored-on-chain-move"),
                expiry: None,
                fee_policy: FeePolicy::AttachTo(fee_target.clone()),
            },
            fee_intent: SubmissionFeeIntent::Attach {
                target: fee_target.clone(),
                amount: Amount::new(42),
                attachment_failure_policy: AttachmentFailurePolicy::SubmitWithoutFee,
            },
        });
        let first = manager.drain_submissions().unwrap().submissions;
        assert_eq!(first.len(), 1);

        let encoded = bencodex::to_vec(&manager).expect("serialize manager");
        let mut restored: TransactionManager<PersistableMockGameSession> =
            bencodex::from_slice(&encoded).expect("restore manager");
        restored.requeue_submitted();

        let replay = restored
            .drain_submissions()
            .expect("requeue retained spend")
            .submissions;
        assert_eq!(replay.len(), 1);
        assert_eq!(replay[0].id, first[0].id);
        assert_eq!(
            replay[0].bundle.name.as_deref(),
            Some("restored-on-chain-move")
        );
        assert_eq!(
            replay[0].fee_intent,
            SubmissionFeeIntent::Attach {
                target: fee_target,
                amount: Amount::new(42),
                attachment_failure_policy: AttachmentFailurePolicy::SubmitWithoutFee,
            }
        );
    }

    #[test]
    fn captured_fee_intent_is_stable_across_retry_and_changes_on_reemission() {
        let target_coin = test_coin(0x71);
        let submission = TransactionSubmission::attach_to(
            test_bundle("fee-sensitive-intent"),
            None,
            &target_coin,
        );
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::OutboundTransaction(
            submission.clone(),
        )]);
        mock.queue_drain(vec![GameSessionEvent::OutboundTransaction(submission)]);
        let mut manager = TransactionManager::new(mock);
        let mut allocator = AllocEncoder::new();
        manager.configure_fee(FeeConfiguration {
            amount: Amount::new(10),
            attachment_failure_policy: AttachmentFailurePolicy::SubmitWithoutFee,
        });
        manager
            .flush_and_collect(&mut allocator)
            .expect("absorb first emission");

        // Draining is intentionally later than absorption and must not observe B.
        manager.configure_fee(FeeConfiguration {
            amount: Amount::new(20),
            attachment_failure_policy: AttachmentFailurePolicy::SubmitWithoutFee,
        });
        let first = manager.drain_submissions().unwrap().submissions.remove(0);
        assert!(matches!(
            &first.fee_intent,
            SubmissionFeeIntent::Attach { amount, .. } if amount == &Amount::new(10)
        ));

        manager.requeue_submitted();
        let retry = manager.drain_submissions().unwrap().submissions.remove(0);
        assert_eq!(retry.id, first.id);
        assert_eq!(retry.fee_intent, first.fee_intent);

        manager
            .flush_and_collect(&mut allocator)
            .expect("absorb later emission");
        let reemitted = manager.drain_submissions().unwrap().submissions.remove(0);
        assert_ne!(reemitted.id, first.id);
        assert!(matches!(
            reemitted.fee_intent,
            SubmissionFeeIntent::Attach { amount, .. } if amount == Amount::new(20)
        ));
    }

    #[test]
    fn fee_attachment_failure_uses_captured_liveness_policy() {
        let target_coin = test_coin(0x72);
        let protocol_bundle = test_bundle("fallback-protocol");
        let mut manager = TransactionManager::new(PersistableMockGameSession);
        manager.configure_fee(FeeConfiguration {
            amount: Amount::new(15),
            attachment_failure_policy: AttachmentFailurePolicy::SubmitWithoutFee,
        });
        manager.pending_submissions.push(PendingSubmission {
            id: None,
            submission: TransactionSubmission::attach_to(
                protocol_bundle.clone(),
                None,
                &target_coin,
            ),
            fee_intent: SubmissionFeeIntent::Attach {
                target: target_coin.to_coin_id(),
                amount: Amount::new(15),
                attachment_failure_policy: AttachmentFailurePolicy::SubmitWithoutFee,
            },
        });
        let drained = manager.drain_submissions().unwrap().submissions.remove(0);
        let finalized = manager
            .finalize_submission(
                drained.id,
                SubmissionFeeSource::Failed("malformed provider source".to_string()),
                &Hash::default(),
                1,
            )
            .unwrap();
        assert_eq!(finalized.bundle, protocol_bundle);
        assert_eq!(finalized.applied_fee, 0);
        assert_eq!(
            finalized.fee_source_disposition,
            FeeSourceDisposition::Unused
        );
        assert_eq!(
            finalized.warning.as_deref(),
            Some(
                "Configured fee was not applied: malformed provider source. The transaction will be attempted without a fee."
            )
        );
        manager.last_height = 2;
        let mut allocator = AllocEncoder::new();
        manager
            .report_height(&mut allocator, 1)
            .expect("reorg replay");
        let replay = manager.drain_submissions().unwrap().submissions.remove(0);
        assert_eq!(replay.id, drained.id);
        assert_eq!(replay.bundle, finalized.bundle);
        assert!(matches!(
            replay.fee_intent,
            SubmissionFeeIntent::Attach { .. }
        ));
        let replay_finalized = manager
            .finalize_submission(
                replay.id,
                SubmissionFeeSource::Failed("still unavailable".to_string()),
                &Hash::default(),
                1,
            )
            .unwrap();
        assert_eq!(replay_finalized.bundle, finalized.bundle);
        assert_eq!(replay_finalized.applied_fee, finalized.applied_fee);
        assert_eq!(
            replay_finalized.fee_source_disposition,
            finalized.fee_source_disposition
        );
        assert!(manager
            .finalize_submission(
                drained.id + 1,
                SubmissionFeeSource::Failed("missing".to_string()),
                &Hash::default(),
                1,
            )
            .is_err());
    }

    #[test]
    fn base_ack_keeps_fee_intent_until_explicit_trigger_or_chain_terminal() {
        let input = test_coin(0x73);
        let output = CoinString::from_parts(
            &input.to_coin_id(),
            &PuzzleHash::from_bytes([0x74; 32]),
            &Amount::new(1),
        );
        let base = test_bundle_spending_creating("base-then-fee-upgrade", &input, &output);
        let mut manager = TransactionManager::new(PersistableMockGameSession);
        manager.configure_fee(FeeConfiguration {
            amount: Amount::new(15),
            attachment_failure_policy: AttachmentFailurePolicy::SubmitWithoutFee,
        });
        let fee_intent = SubmissionFeeIntent::Attach {
            target: input.to_coin_id(),
            amount: Amount::new(15),
            attachment_failure_policy: AttachmentFailurePolicy::SubmitWithoutFee,
        };
        manager.pending_submissions.push(PendingSubmission {
            id: None,
            submission: TransactionSubmission::attach_to(base.clone(), None, &input),
            fee_intent,
        });

        let first = manager.drain_submissions().unwrap().submissions.remove(0);
        assert_eq!(first.goal, SubmissionDeliveryGoal::EnsureBroadcast);
        let fallback = manager
            .finalize_submission_delivery(
                first.id,
                first.goal,
                &first.variant_fingerprint,
                SubmissionFeeSource::Failed("provider unavailable".to_string()),
                &Hash::default(),
                1,
            )
            .unwrap();
        assert_eq!(fallback.bundle, base);
        assert!(fallback.should_broadcast);
        manager
            .acknowledge_submission_variant(first.id, &fallback.variant_fingerprint)
            .unwrap();
        assert!(manager.drain_submissions().unwrap().submissions.is_empty());

        let encoded = bencodex::to_vec(&manager).unwrap();
        let mut restored: TransactionManager<PersistableMockGameSession> =
            bencodex::from_slice(&encoded).unwrap();
        restored.request_fee_upgrades();
        let triggered = bencodex::to_vec(&restored).unwrap();
        restored = bencodex::from_slice(&triggered).unwrap();
        let upgrade = restored.drain_submissions().unwrap().submissions.remove(0);
        assert_eq!(upgrade.id, first.id);
        assert_eq!(upgrade.goal, SubmissionDeliveryGoal::FeeUpgrade);
        assert_eq!(upgrade.intent_fingerprint, first.intent_fingerprint);
        let unavailable_upgrade = restored
            .finalize_submission_delivery(
                upgrade.id,
                upgrade.goal,
                &upgrade.variant_fingerprint,
                SubmissionFeeSource::Failed("still unavailable".to_string()),
                &Hash::default(),
                2,
            )
            .unwrap();
        assert!(!unavailable_upgrade.should_broadcast);
        assert!(restored.drain_submissions().unwrap().submissions.is_empty());

        let mut allocator = AllocEncoder::new();
        restored
            .report_coin_states(
                &mut allocator,
                3,
                &[
                    CoinStateRecord {
                        coin: input,
                        created_height: Some(1),
                        spent_height: Some(3),
                    },
                    CoinStateRecord {
                        coin: output,
                        created_height: Some(3),
                        spent_height: None,
                    },
                ],
            )
            .unwrap();
        assert_eq!(restored.drain_retired_submission_ids(), vec![first.id]);
        restored.request_fee_upgrades();
        assert!(restored.drain_submissions().unwrap().submissions.is_empty());
    }

    #[test]
    fn already_paid_finalization_rejects_an_impossible_fee_source() {
        let protocol_bundle = test_bundle("already-paid");
        let mut manager = TransactionManager::new(PersistableMockGameSession);
        manager.pending_submissions.push(PendingSubmission {
            id: None,
            submission: TransactionSubmission::already_paid(protocol_bundle.clone(), None),
            fee_intent: SubmissionFeeIntent::AlreadyPaid,
        });
        let drained = manager.drain_submissions().unwrap().submissions.remove(0);
        assert_eq!(drained.fee_intent, SubmissionFeeIntent::AlreadyPaid);
        let finalized = manager
            .finalize_submission(
                drained.id,
                SubmissionFeeSource::NotRequested,
                &Hash::default(),
                1,
            )
            .unwrap();
        assert_eq!(finalized.bundle, protocol_bundle);
        assert_eq!(finalized.applied_fee, 0);
        assert_eq!(
            finalized.fee_source_disposition,
            FeeSourceDisposition::NotRequested
        );
        assert!(manager
            .finalize_submission(
                drained.id,
                SubmissionFeeSource::Failed("unexpected".to_string()),
                &Hash::default(),
                1,
            )
            .is_err());
    }

    #[test]
    fn requeue_submitted_discards_expired_transactions() {
        let mut allocator = AllocEncoder::new();
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![GameSessionEvent::OutboundTransaction(
            test_submission("expired", Some(10)),
        )]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");
        let expired = mgr.drain_submissions().unwrap().submissions.remove(0);

        mgr.last_height = 10;
        mgr.requeue_submitted();
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
        assert!(mgr.submitted.is_empty());
        assert_eq!(mgr.drain_retired_submission_ids(), vec![expired.id]);
        assert!(mgr.drain_retired_submission_ids().is_empty());

        let mut allocator = AllocEncoder::new();
        mgr.report_height(&mut allocator, 9).unwrap();
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
    }

    #[test]
    fn conflicting_spend_prunes_once_expected_output_is_watched() {
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
            GameSessionEvent::OutboundTransaction(TransactionSubmission::attach_to(
                spend_tx.clone(),
                None,
                &coin,
            )),
        ]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");

        // Host submits the spend; the manager retains it.
        let submitted = mgr.drain_submissions().unwrap().submissions.remove(0);
        assert!(!mgr.snapshot_watched_coins().contains(&child));

        // The first input-spent snapshot was queried before the handler could
        // react by watching the expected child, so its absence is not yet
        // evidence that a conflicting transaction won.
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
        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);

        // Once the expected child is in the watched scope, a later complete
        // snapshot that still lacks it proves that a conflicting spend won.
        mgr.register_watch(child, Timeout::new(50), None, None);
        mgr.report_coin_states(
            &mut allocator,
            13,
            &[CoinStateRecord {
                coin: coin.clone(),
                created_height: Some(10),
                spent_height: Some(12),
            }],
        )
        .expect("report");
        mgr.requeue_submitted();
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
        assert_eq!(mgr.drain_retired_submission_ids(), vec![submitted.id]);
    }

    #[test]
    fn rollback_prune_removes_pending_id_without_consuming_unrelated_urgent_work() {
        let input = test_coin(34);
        let expected = CoinString::from_parts(
            &input.to_coin_id(),
            &PuzzleHash::from_bytes([35; 32]),
            &Amount::new(1),
        );
        let mut mgr = TransactionManager::new(PersistableMockGameSession);
        mgr.pending_submissions.push(PendingSubmission {
            id: None,
            submission: TransactionSubmission::already_paid(
                test_bundle_spending_creating("losing", &input, &expected),
                None,
            ),
            fee_intent: SubmissionFeeIntent::AlreadyPaid,
        });
        let losing = mgr.drain_submissions().unwrap().submissions.remove(0);
        mgr.acknowledge_submission(losing.id).unwrap();

        let mut allocator = AllocEncoder::new();
        mgr.report_coin_states(&mut allocator, 20, &[]).unwrap();
        mgr.pending_submissions.push(PendingSubmission {
            id: None,
            submission: test_submission("urgent", None),
            fee_intent: SubmissionFeeIntent::AlreadyPaid,
        });
        mgr.register_watch(expected, Timeout::new(50), None, None);
        mgr.report_coin_states(
            &mut allocator,
            19,
            &[CoinStateRecord {
                coin: input,
                created_height: Some(10),
                spent_height: Some(19),
            }],
        )
        .unwrap();

        assert!(!mgr.submitted.iter().any(|tx| tx.id == losing.id));
        let drained = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].bundle.name.as_deref(), Some("urgent"));
    }

    #[test]
    fn vanished_landed_output_then_competing_spend_prunes_creator() {
        let input = test_coin(36);
        let output = CoinString::from_parts(
            &input.to_coin_id(),
            &PuzzleHash::from_bytes([37; 32]),
            &Amount::new(1),
        );
        let mut mock = MockGameSession::default();
        mock.queue_drain(vec![
            watch_event(&input, 50),
            watch_event(&output, 50),
            GameSessionEvent::OutboundTransaction(TransactionSubmission::already_paid(
                test_bundle_spending_creating("stale-creator", &input, &output),
                None,
            )),
        ]);
        let mut mgr = TransactionManager::new(mock);
        let mut allocator = AllocEncoder::new();
        mgr.flush_and_collect(&mut allocator).unwrap();
        let creator = mgr.drain_submissions().unwrap().submissions.remove(0);
        mgr.acknowledge_submission(creator.id).unwrap();
        mgr.report_coin_states(
            &mut allocator,
            20,
            &[
                CoinStateRecord {
                    coin: input.clone(),
                    created_height: Some(10),
                    spent_height: Some(20),
                },
                CoinStateRecord {
                    coin: output,
                    created_height: Some(20),
                    spent_height: None,
                },
            ],
        )
        .unwrap();
        assert_eq!(
            mgr.submitted[0].chain_terminality,
            SubmissionChainTerminality::Landed
        );

        mgr.report_coin_states(
            &mut allocator,
            19,
            &[CoinStateRecord {
                coin: input,
                created_height: Some(10),
                spent_height: Some(19),
            }],
        )
        .unwrap();

        assert!(mgr.submitted.is_empty());
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
    }

    #[test]
    fn stale_pending_id_is_quarantined_without_blocking_valid_queue_entries() {
        let mut mgr = TransactionManager::new(PersistableMockGameSession);
        mgr.pending_submissions.extend([
            PendingSubmission {
                id: Some(999),
                submission: test_submission("stale", None),
                fee_intent: SubmissionFeeIntent::AlreadyPaid,
            },
            PendingSubmission {
                id: None,
                submission: test_submission("valid", None),
                fee_intent: SubmissionFeeIntent::AlreadyPaid,
            },
        ]);

        let drained = mgr.drain_submissions().unwrap();
        assert_eq!(drained.submissions.len(), 1);
        assert_eq!(drained.submissions[0].bundle.name.as_deref(), Some("valid"));
        assert_eq!(drained.failures.len(), 1);
        assert_eq!(drained.failures[0].retained_submission_id, None);
        assert_eq!(drained.failures[0].candidate_submission_id, Some(999));
        assert_eq!(
            drained.failures[0].stage,
            SubmissionDrainFailureStage::RetainedState
        );
        assert!(mgr.drain_retired_submission_ids().is_empty());
        assert!(mgr.pending_submissions.is_empty());
        let next = mgr.drain_submissions().unwrap();
        assert!(next.submissions.is_empty());
        assert!(next.failures.is_empty());
    }

    #[test]
    fn pending_id_fee_intent_mismatch_is_quarantined_without_blocking_valid_work() {
        let mut mgr = TransactionManager::new(PersistableMockGameSession);
        mgr.pending_submissions.push(PendingSubmission {
            id: None,
            submission: test_submission("retained", None),
            fee_intent: SubmissionFeeIntent::AlreadyPaid,
        });
        let retained = mgr.drain_submissions().unwrap().submissions.remove(0);
        mgr.requeue_submitted();
        mgr.pending_submissions[0].fee_intent = SubmissionFeeIntent::NoFeeConfigured;
        mgr.pending_submissions
            .push(mgr.pending_submissions[0].clone());
        mgr.pending_submissions.push(PendingSubmission {
            id: None,
            submission: test_submission("valid", None),
            fee_intent: SubmissionFeeIntent::AlreadyPaid,
        });

        let drained = mgr.drain_submissions().unwrap();
        assert_eq!(drained.submissions.len(), 1);
        assert_eq!(drained.submissions[0].bundle.name.as_deref(), Some("valid"));
        assert_eq!(drained.failures.len(), 1);
        assert_eq!(
            drained.failures[0].retained_submission_id,
            Some(retained.id)
        );
        assert_eq!(
            drained.failures[0].stage,
            SubmissionDrainFailureStage::RetainedState
        );
        assert!(drained.failures[0].message.contains("fee intent"));
        assert!(!mgr
            .submitted
            .iter()
            .any(|submission| submission.id == retained.id));
        assert_eq!(mgr.drain_retired_submission_ids(), vec![retained.id]);
        assert!(mgr.drain_retired_submission_ids().is_empty());
        mgr.acknowledge_submission(drained.submissions[0].id)
            .expect("acknowledge unrelated valid work");
        mgr.requeue_submitted();
        assert!(mgr.pending_submissions.is_empty());
        let next = mgr.drain_submissions().unwrap();
        assert!(next.submissions.is_empty());
        assert!(next.failures.is_empty());

        let encoded = bencodex::to_vec(&mgr).expect("serialize retired manager");
        let mut restored: TransactionManager<PersistableMockGameSession> =
            bencodex::from_slice(&encoded).expect("restore retired manager");
        restored.requeue_submitted();
        let restored_drain = restored.drain_submissions().unwrap();
        assert!(restored_drain.submissions.is_empty());
        assert!(restored_drain.failures.is_empty());
        assert!(restored.drain_retired_submission_ids().is_empty());
    }

    #[test]
    fn pending_id_fingerprint_mismatch_retires_once_and_never_requeues() {
        let mut mgr = TransactionManager::new(PersistableMockGameSession);
        mgr.pending_submissions.push(PendingSubmission {
            id: None,
            submission: test_submission("retained", None),
            fee_intent: SubmissionFeeIntent::AlreadyPaid,
        });
        let retained = mgr.drain_submissions().unwrap().submissions.remove(0);
        mgr.requeue_submitted();
        mgr.pending_submissions[0].submission = test_submission("mismatched", Some(1));

        let drained = mgr.drain_submissions().unwrap();
        assert!(drained.submissions.is_empty());
        assert_eq!(drained.failures.len(), 1);
        assert_eq!(
            drained.failures[0].retained_submission_id,
            Some(retained.id)
        );
        assert_eq!(
            drained.failures[0].stage,
            SubmissionDrainFailureStage::RetainedState
        );
        assert_eq!(mgr.drain_retired_submission_ids(), vec![retained.id]);
        assert!(mgr.drain_retired_submission_ids().is_empty());

        mgr.requeue_submitted();
        let next = mgr.drain_submissions().unwrap();
        assert!(next.submissions.is_empty());
        assert!(next.failures.is_empty());
    }

    #[test]
    fn landed_spend_is_not_requeued_on_reload_and_is_retained_until_buried() {
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
            GameSessionEvent::OutboundTransaction(TransactionSubmission::attach_to(
                spend_tx.clone(),
                None,
                &coin,
            )),
        ]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");
        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);

        // The input is spent and the retained tx's expected child appears.  That
        // means this transaction won, so it stays retained for explicit reorg
        // recovery but an ordinary reload does not resubmit it.
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
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
        assert_eq!(mgr.submitted.len(), 1);

        // Once the spent input is buried deeply enough, the input coin is evicted
        // and the winning transaction no longer needs to be retained.
        let depth = mgr.confirmation_depth();
        mgr.report_coin_states(&mut allocator, 12 + depth, &[])
            .expect("report");
        assert!(mgr.watched_coin(&coin).is_none());
        assert!(mgr.submitted.is_empty());
        mgr.requeue_submitted();
        assert!(mgr.drain_submissions().unwrap().submissions.is_empty());
    }

    #[test]
    fn restored_fresh_sync_queries_input_and_does_not_requeue_landed_submission() {
        let mut allocator = AllocEncoder::new();
        let input = test_coin(34);
        let child = CoinString::from_parts(
            &input.to_coin_id(),
            &PuzzleHash::from_bytes([35; 32]),
            &Amount::new(1),
        );
        let spend_tx = test_bundle_spending_creating("spend-coin", &input, &child);
        let mut mgr = TransactionManager::new(PersistableMockGameSession);
        mgr.register_watch(child.clone(), Timeout::new(50), None, None);
        mgr.pending_submissions.push(PendingSubmission {
            id: None,
            submission: TransactionSubmission::already_paid(spend_tx.clone(), None),
            fee_intent: SubmissionFeeIntent::AlreadyPaid,
        });
        let drained = mgr.drain_submissions().unwrap().submissions;
        assert_eq!(drained.len(), 1);
        assert_eq!(drained[0].bundle, spend_tx);
        assert_eq!(drained[0].expiry, None);
        assert_eq!(drained[0].fee_intent, SubmissionFeeIntent::AlreadyPaid);

        let encoded = bencodex::to_vec(&mgr).expect("serialize manager");
        let mut restored: TransactionManager<PersistableMockGameSession> =
            bencodex::from_slice(&encoded).expect("restore manager");
        assert_eq!(
            restored.snapshot_watched_coins(),
            vec![input.clone(), child.clone()]
        );

        restored
            .report_coin_states(
                &mut allocator,
                12,
                &[
                    CoinStateRecord {
                        coin: input.clone(),
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
            .expect("fresh report");
        restored.requeue_submitted();
        assert!(restored.drain_submissions().unwrap().submissions.is_empty());
        assert_eq!(
            restored.snapshot_watched_coins(),
            vec![input.clone(), child.clone()]
        );

        let drain = restored
            .flush_and_collect(&mut allocator)
            .expect("drain unwatch");
        assert!(drain.unwatch_coins.is_empty());

        let depth = restored.confirmation_depth();
        restored
            .report_coin_states(
                &mut allocator,
                12 + depth,
                &[
                    CoinStateRecord {
                        coin: input.clone(),
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
            .expect("buried fresh report");
        assert_eq!(restored.snapshot_watched_coins(), vec![child]);
        let drain = restored
            .flush_and_collect(&mut allocator)
            .expect("drain bounded input unwatch");
        assert_eq!(drain.unwatch_coins, vec![input]);
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
            GameSessionEvent::OutboundTransaction(TransactionSubmission::attach_to(
                spend_tx.clone(),
                None,
                &coin,
            )),
        ]);
        let mut mgr = TransactionManager::new(mock);
        mgr.flush_and_collect(&mut allocator).expect("drain");
        assert_eq!(mgr.drain_submissions().unwrap().submissions.len(), 1);

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
                mgr.drain_submissions().unwrap().submissions.is_empty(),
                "should not rebroadcast at height {height}",
            );
        }
    }
}
