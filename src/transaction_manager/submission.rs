use std::collections::{BTreeSet, HashSet, VecDeque};

use serde::{Deserialize, Serialize};

use crate::common::types::{aggregate_wallet_fee_bundle, CoinString, Error, Hash};
use crate::session_phases::effects::{
    AttachmentFailurePolicy, SubmissionFeeIntent, TransactionSubmission,
};

use super::replay::ReplayEpoch;
use super::{
    bounded_text, plan_pending_submission, submission_variant_fingerprint, DurableFeeIntent,
    FeeResolution, FeeSourceDisposition, FinalizedSubmission, SubmissionBroadcastVariant,
    SubmissionChainTerminality, SubmissionDrainFailure, SubmissionDrainResult, SubmissionFeeSource,
    SubmittedTx, SUBMISSION_DRAIN_MESSAGE_LIMIT, SUBMISSION_DRAIN_RUST_CONTEXT_LIMIT,
};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct PendingSubmissionIntent {
    pub(super) id: Option<u64>,
    pub(super) submission: TransactionSubmission,
    pub(super) fee_intent: SubmissionFeeIntent,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub(super) enum DeliveryTrigger {
    Protocol,
    FreshChain,
    Rollback,
    ProviderReadiness,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SubmissionDeliveryGoal {
    EnsureBroadcast,
    FeeUpgrade,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmissionSuccessorRelationship {
    Exact,
    NewerFeeBearing,
    Other,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum SubmissionAttemptStatus {
    Applied,
    Stale,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct PendingDelivery {
    pub(super) intent: PendingSubmissionIntent,
    pub(super) trigger: DeliveryTrigger,
    pub(super) goal: SubmissionDeliveryGoal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub(super) struct DeliveryAttempt {
    pub(super) token: u64,
    pub(super) submission_id: u64,
    pub(super) goal: SubmissionDeliveryGoal,
    pub(super) drained_variant_fingerprint: Hash,
    pub(super) finalized_variant_fingerprint: Option<Hash>,
}

impl DeliveryAttempt {
    pub(super) fn resolved_variant_fingerprint(&self) -> &Hash {
        self.finalized_variant_fingerprint
            .as_ref()
            .unwrap_or(&self.drained_variant_fingerprint)
    }
}

/// Durable owner of submission intent, delivery attempts, retirement, and
/// rollback replay synchronization.
///
/// This is flattened into [`TransactionManager`](super::TransactionManager),
/// preserving the current schema-19 serialized field names.
#[derive(Debug, Default, Serialize, Deserialize)]
pub(super) struct SubmissionBook {
    pending_deliveries: Vec<PendingDelivery>,
    delivery_attempts: Vec<DeliveryAttempt>,
    completed_delivery_attempts: Vec<DeliveryAttempt>,
    next_delivery_attempt_token: u64,
    replay_epoch: ReplayEpoch,
    submitted: Vec<SubmittedTx>,
    retired_submission_ids: Vec<u64>,
    next_submission_id: u64,
}

impl SubmissionBook {
    pub(super) fn queue(
        &mut self,
        intent: PendingSubmissionIntent,
        trigger: DeliveryTrigger,
        goal: SubmissionDeliveryGoal,
    ) {
        self.pending_deliveries.push(PendingDelivery {
            intent,
            trigger,
            goal,
        });
    }

    pub(super) fn drain(&mut self) -> Result<SubmissionDrainResult, Error> {
        let mut pending = std::mem::take(&mut self.pending_deliveries)
            .into_iter()
            .enumerate()
            .map(|(index, pending)| (index as u64, pending))
            .collect::<VecDeque<_>>();
        let mut result = SubmissionDrainResult {
            submissions: Vec::with_capacity(pending.len()),
            failures: Vec::new(),
        };
        let mut emitted_ids = HashSet::new();
        while let Some((candidate_index, candidate)) = pending.pop_front() {
            let goal = candidate.goal;
            match plan_pending_submission(
                &candidate.intent,
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
                    if let Some(mut drained) = delta.drained {
                        let drained_variant_fingerprint = self
                            .submitted
                            .iter()
                            .find(|tx| tx.id == drained.id)
                            .expect("drained submission must remain retained")
                            .current_variant_fingerprint()?;
                        let token = self.next_delivery_attempt_token;
                        self.next_delivery_attempt_token =
                            token.checked_add(1).ok_or_else(|| {
                                Error::StrErr(
                                    "delivery attempt token source is exhausted".to_string(),
                                )
                            })?;
                        drained.attempt_token = token;
                        self.delivery_attempts.push(DeliveryAttempt {
                            token,
                            submission_id: drained.id,
                            goal,
                            drained_variant_fingerprint,
                            finalized_variant_fingerprint: None,
                        });
                        result.submissions.push(drained);
                    }
                }
                Err(error) => {
                    if let Some(id) = error.retained_submission_id {
                        self.retain_submitted(|tx| tx.id != id);
                        pending.retain(|(_, pending)| pending.intent.id != Some(id));
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
        Ok(result)
    }

    pub(super) fn attempt(&self, token: u64) -> Option<&DeliveryAttempt> {
        self.delivery_attempts
            .iter()
            .find(|attempt| attempt.token == token)
    }

    pub(super) fn attempt_mut(&mut self, token: u64) -> Option<&mut DeliveryAttempt> {
        self.delivery_attempts
            .iter_mut()
            .find(|attempt| attempt.token == token)
    }

    fn issued_token_is_inactive(&self, token: u64) -> bool {
        token < self.next_delivery_attempt_token && self.attempt(token).is_none()
    }

    pub(super) fn archive_attempt(&mut self, attempt_index: usize) {
        let completed = self.delivery_attempts.remove(attempt_index);
        self.completed_delivery_attempts.push(completed);
    }

    pub(super) fn supersede_attempt(&mut self, submission_id: u64) {
        if let Some(index) = self
            .delivery_attempts
            .iter()
            .position(|attempt| attempt.submission_id == submission_id)
        {
            self.archive_attempt(index);
        }
    }

    pub(super) fn retain_submitted(
        &mut self,
        mut keep: impl FnMut(&SubmittedTx) -> bool,
    ) -> Vec<u64> {
        let removed_ids = self
            .submitted
            .iter()
            .filter(|tx| !keep(tx))
            .map(|tx| tx.id)
            .collect::<HashSet<_>>();
        if removed_ids.is_empty() {
            return Vec::new();
        }
        self.submitted.retain(|tx| !removed_ids.contains(&tx.id));
        self.pending_deliveries.retain(|pending| {
            !pending
                .intent
                .id
                .is_some_and(|id| removed_ids.contains(&id))
        });
        let attempts = std::mem::take(&mut self.delivery_attempts);
        let (retired_attempts, live_attempts): (Vec<_>, Vec<_>) = attempts
            .into_iter()
            .partition(|attempt| removed_ids.contains(&attempt.submission_id));
        self.delivery_attempts = live_attempts;
        self.completed_delivery_attempts.extend(retired_attempts);
        // Completed attempts are deliberate stale-token tombstones. Keeping the
        // latest one per retired submission makes late wallet callbacks typed
        // no-ops without permitting them to mutate current state.
        self.replay_epoch.retain(|id| !removed_ids.contains(&id));

        let mut sorted = removed_ids.into_iter().collect::<Vec<_>>();
        sorted.sort_unstable();
        for id in &sorted {
            self.emit_retirement(*id);
        }
        sorted
    }

    pub(super) fn emit_retirement(&mut self, id: u64) {
        if !self.retired_submission_ids.contains(&id) {
            self.retired_submission_ids.push(id);
        }
    }

    pub(super) fn drain_retirements(&mut self) -> Vec<u64> {
        let retired = std::mem::take(&mut self.retired_submission_ids);
        if !retired.is_empty() {
            let retired_set = retired.iter().copied().collect::<HashSet<_>>();
            self.completed_delivery_attempts
                .retain(|attempt| !retired_set.contains(&attempt.submission_id));
        }
        retired
    }

    pub(super) fn reconciliation_input_coins(
        &self,
        mut retain_landed_output: impl FnMut(&CoinString) -> bool,
    ) -> BTreeSet<CoinString> {
        self.submitted
            .iter()
            .filter(|tx| {
                tx.chain_terminality == SubmissionChainTerminality::Active
                    || tx
                        .expected_output_coins
                        .iter()
                        .any(&mut retain_landed_output)
            })
            .flat_map(|tx| tx.base_bundle.spends.iter().map(|spend| spend.coin.clone()))
            .collect()
    }

    pub(super) fn fee_intent_for_attempt(
        &self,
        attempt_token: u64,
    ) -> Result<Option<SubmissionFeeIntent>, Error> {
        let Some(attempt) = self.attempt(attempt_token) else {
            if self.issued_token_is_inactive(attempt_token) {
                return Ok(None);
            }
            return Err(Error::StrErr(format!(
                "unknown delivery attempt token {attempt_token}"
            )));
        };
        self.submitted
            .iter()
            .find(|tx| tx.id == attempt.submission_id)
            .map(|tx| {
                Some(
                    tx.unresolved_fee_intent()
                        .cloned()
                        .unwrap_or(SubmissionFeeIntent::AlreadyPaid),
                )
            })
            .ok_or_else(|| {
                Error::StrErr(format!("unknown submission id {}", attempt.submission_id))
            })
    }

    pub(super) fn finalize_attempt(
        &mut self,
        attempt_token: u64,
        fee_source: SubmissionFeeSource,
        agg_sig_me_additional_data: &Hash,
        height: u64,
    ) -> Result<Option<FinalizedSubmission>, Error> {
        let Some(attempt) = self.attempt(attempt_token).cloned() else {
            if self.issued_token_is_inactive(attempt_token) {
                return Ok(None);
            }
            return Err(Error::StrErr(format!(
                "unknown delivery attempt token {attempt_token}"
            )));
        };
        if attempt.finalized_variant_fingerprint.is_some() {
            return Err(Error::StrErr(format!(
                "delivery attempt token {attempt_token} was already finalized"
            )));
        }
        let id = attempt.submission_id;
        let goal = attempt.goal;
        let submission = self
            .submitted
            .iter_mut()
            .find(|tx| tx.id == id)
            .ok_or_else(|| Error::StrErr(format!("unknown submission id {id}")))?;
        submission.validate()?;
        let current_fingerprint = submission.current_variant_fingerprint()?;
        if current_fingerprint != attempt.drained_variant_fingerprint {
            return Err(Error::StrErr(format!(
                "delivery attempt token {attempt_token} refers to a stale broadcast variant"
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
                FinalizedSubmission {
                    bundle: submission.current_bundle().clone(),
                    applied_fee: submission.current_applied_fee(),
                    warning: None,
                    fee_source_disposition: FeeSourceDisposition::NotRequested,
                    variant_fingerprint: current_fingerprint.clone(),
                    should_broadcast: goal == SubmissionDeliveryGoal::EnsureBroadcast,
                }
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
                        FinalizedSubmission {
                            bundle,
                            applied_fee: amount.to_u64(),
                            warning: None,
                            fee_source_disposition: FeeSourceDisposition::Attached,
                            variant_fingerprint,
                            should_broadcast: true,
                        }
                    }
                    Err(reason) => match attachment_failure_policy {
                        AttachmentFailurePolicy::SubmitWithoutFee => FinalizedSubmission {
                            bundle: submission.base_bundle.clone(),
                            applied_fee: 0,
                            warning: Some(format!(
                                "Configured fee was not applied: {reason}. The transaction will be attempted without a fee."
                            )),
                            fee_source_disposition: FeeSourceDisposition::Unused,
                            variant_fingerprint: current_fingerprint.clone(),
                            should_broadcast: goal == SubmissionDeliveryGoal::EnsureBroadcast,
                        },
                    },
                }
            }
            Some(SubmissionFeeIntent::AlreadyPaid | SubmissionFeeIntent::NoFeeConfigured) => {
                return Err(Error::StrErr(format!(
                    "submission {id} retained an invalid unresolved fee intent"
                )));
            }
        };
        if finalized.should_broadcast && submission.current_variant_acknowledged()? {
            finalized.should_broadcast = false;
        }
        submission.validate()?;
        self.attempt_mut(attempt_token)
            .expect("validated delivery attempt must remain live")
            .finalized_variant_fingerprint = Some(finalized.variant_fingerprint.clone());
        Ok(Some(finalized))
    }

    pub(super) fn acknowledge_attempt(
        &mut self,
        attempt_token: u64,
    ) -> Result<SubmissionAttemptStatus, Error> {
        let Some(attempt_index) = self
            .delivery_attempts
            .iter()
            .position(|attempt| attempt.token == attempt_token)
        else {
            return if self.issued_token_is_inactive(attempt_token) {
                Ok(SubmissionAttemptStatus::Stale)
            } else {
                Err(Error::StrErr(format!(
                    "unknown delivery attempt token {attempt_token}"
                )))
            };
        };
        let attempt = self.delivery_attempts[attempt_index].clone();
        if attempt.finalized_variant_fingerprint.is_none() {
            return Err(Error::StrErr(format!(
                "delivery attempt token {attempt_token} was not finalized"
            )));
        }
        let variant_fingerprint = attempt.resolved_variant_fingerprint();
        let Some(submission) = self
            .submitted
            .iter_mut()
            .find(|tx| tx.id == attempt.submission_id)
        else {
            return Ok(SubmissionAttemptStatus::Stale);
        };
        if submission.current_variant_fingerprint()? != *variant_fingerprint {
            return Err(Error::StrErr(format!(
                "delivery attempt token {attempt_token} refers to a stale broadcast variant"
            )));
        }
        submission.wallet_acknowledged_variant = Some(variant_fingerprint.clone());
        self.archive_attempt(attempt_index);
        self.pending_deliveries
            .retain(|pending| pending.intent.id != Some(attempt.submission_id));
        Ok(SubmissionAttemptStatus::Applied)
    }

    pub(super) fn classify_successor(
        &mut self,
        successor_attempt_token: u64,
        completed_attempt_token: u64,
    ) -> Result<SubmissionSuccessorRelationship, Error> {
        let attempt = self
            .attempt(successor_attempt_token)
            .ok_or_else(|| {
                Error::StrErr(format!(
                    "unknown or stale delivery attempt token {successor_attempt_token}"
                ))
            })?
            .clone();
        let completed_index = self
            .completed_delivery_attempts
            .iter()
            .position(|completed| completed.token == completed_attempt_token)
            .ok_or_else(|| {
                Error::StrErr(format!(
                    "unknown or stale completed delivery attempt token {completed_attempt_token}"
                ))
            })?;
        let completed = self.completed_delivery_attempts.remove(completed_index);
        Ok(if attempt.goal == SubmissionDeliveryGoal::FeeUpgrade {
            SubmissionSuccessorRelationship::NewerFeeBearing
        } else if attempt.drained_variant_fingerprint == *completed.resolved_variant_fingerprint() {
            SubmissionSuccessorRelationship::Exact
        } else {
            SubmissionSuccessorRelationship::Other
        })
    }

    pub(super) fn stop_attempt(
        &mut self,
        attempt_token: u64,
    ) -> Result<SubmissionAttemptStatus, Error> {
        let Some(attempt_index) = self
            .delivery_attempts
            .iter()
            .position(|attempt| attempt.token == attempt_token)
        else {
            return if self.issued_token_is_inactive(attempt_token) {
                Ok(SubmissionAttemptStatus::Stale)
            } else {
                Err(Error::StrErr(format!(
                    "unknown delivery attempt token {attempt_token}"
                )))
            };
        };
        self.archive_attempt(attempt_index);
        Ok(SubmissionAttemptStatus::Applied)
    }

    pub(super) fn relinquish_completed_attempt(
        &mut self,
        attempt_token: u64,
    ) -> Result<SubmissionAttemptStatus, Error> {
        if let Some(index) = self
            .completed_delivery_attempts
            .iter()
            .position(|attempt| attempt.token == attempt_token)
        {
            self.completed_delivery_attempts.remove(index);
            return Ok(SubmissionAttemptStatus::Applied);
        }
        if attempt_token < self.next_delivery_attempt_token {
            return Ok(SubmissionAttemptStatus::Stale);
        }
        Err(Error::StrErr(format!(
            "unknown delivery attempt token {attempt_token}"
        )))
    }

    pub(super) fn active_ids(&self) -> Vec<u64> {
        self.submitted
            .iter()
            .filter(|tx| tx.chain_terminality == SubmissionChainTerminality::Active)
            .map(|tx| tx.id)
            .collect()
    }

    pub(super) fn all_ids(&self) -> HashSet<u64> {
        self.submitted.iter().map(|tx| tx.id).collect()
    }

    pub(super) fn finish_replay_if_advanced(&mut self, height: u64) {
        self.replay_epoch.finish_if_advanced(height);
    }

    pub(super) fn replay_rollback_height(&self) -> Option<u64> {
        self.replay_epoch.rollback_height()
    }

    pub(super) fn begin_replay(&mut self, height: u64) -> bool {
        self.replay_epoch.begin(height)
    }

    pub(super) fn reset_replay_at(&mut self, height: u64) {
        self.replay_epoch.reset_at(height);
    }

    pub(super) fn reconcile_chain_terminality(
        &mut self,
        observed_created: &HashSet<CoinString>,
        reorg: bool,
        spend_reversal: bool,
        causally_rolled_back_ids: &HashSet<u64>,
    ) {
        let mut newly_landed_ids = Vec::new();
        for tx in &mut self.submitted {
            if tx.expected_output_coins.is_empty() {
                continue;
            }
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
        for id in newly_landed_ids {
            self.replay_epoch.remove(id);
            self.pending_deliveries
                .retain(|pending| pending.intent.id != Some(id));
            if let Some(index) = self
                .delivery_attempts
                .iter()
                .position(|attempt| attempt.submission_id == id)
            {
                self.archive_attempt(index);
            }
            self.emit_retirement(id);
        }
    }

    pub(super) fn causally_rolled_back_ids(
        &self,
        explicitly_absent: &HashSet<CoinString>,
        explicitly_live_input_ids: &HashSet<crate::common::types::CoinID>,
    ) -> HashSet<u64> {
        self.submitted
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
            .collect()
    }

    pub(super) fn absent_outputs_for_ids(
        &self,
        ids: &HashSet<u64>,
        explicitly_absent: &HashSet<CoinString>,
    ) -> Vec<CoinString> {
        self.submitted
            .iter()
            .filter(|tx| ids.contains(&tx.id))
            .flat_map(|tx| tx.expected_output_coins.iter())
            .filter(|coin| explicitly_absent.contains(*coin))
            .cloned()
            .collect()
    }

    pub(super) fn queue_rebroadcast_epoch(
        &mut self,
        ids: &[u64],
        trigger: DeliveryTrigger,
    ) -> Result<(), Error> {
        for id in ids {
            let Some(tx) = self.submitted.iter().find(|tx| tx.id == *id) else {
                continue;
            };
            let goal = if tx.current_variant_acknowledged()? {
                SubmissionDeliveryGoal::FeeUpgrade
            } else {
                SubmissionDeliveryGoal::EnsureBroadcast
            };
            self.queue_retained_delivery(*id, trigger, goal);
        }
        Ok(())
    }

    pub(super) fn queue_fee_readiness(&mut self) -> Result<(), Error> {
        let candidates = self
            .submitted
            .iter()
            .filter(|tx| {
                tx.chain_terminality == SubmissionChainTerminality::Active
                    && tx.unresolved_fee_intent().is_some()
            })
            .map(|tx| Ok((tx.id, tx.current_variant_acknowledged()?)))
            .collect::<Result<Vec<_>, Error>>()?;
        for (id, acknowledged) in candidates {
            self.queue_retained_delivery(
                id,
                DeliveryTrigger::ProviderReadiness,
                if acknowledged {
                    SubmissionDeliveryGoal::FeeUpgrade
                } else {
                    SubmissionDeliveryGoal::EnsureBroadcast
                },
            );
        }
        Ok(())
    }

    pub(super) fn queue_retained_delivery(
        &mut self,
        id: u64,
        trigger: DeliveryTrigger,
        goal: SubmissionDeliveryGoal,
    ) {
        if matches!(
            trigger,
            DeliveryTrigger::FreshChain | DeliveryTrigger::Rollback
        ) {
            self.supersede_attempt(id);
        }
        if self
            .pending_deliveries
            .iter()
            .any(|pending| pending.intent.id == Some(id))
            || self
                .delivery_attempts
                .iter()
                .any(|attempt| attempt.submission_id == id)
        {
            return;
        }
        let Some(tx) = self.submitted.iter().find(|tx| tx.id == id) else {
            return;
        };
        if goal == SubmissionDeliveryGoal::FeeUpgrade && tx.unresolved_fee_intent().is_none() {
            return;
        }
        self.pending_deliveries.push(PendingDelivery {
            intent: PendingSubmissionIntent {
                id: Some(tx.id),
                submission: TransactionSubmission::already_paid(tx.base_bundle.clone(), tx.expiry),
                fee_intent: tx.canonical_fee_intent().clone(),
            },
            trigger,
            goal,
        });
    }

    pub(super) fn collect_rollback_replay_ids(&mut self, ids: &HashSet<u64>) {
        for tx in &mut self.submitted {
            if !ids.contains(&tx.id) || !self.replay_epoch.mark_replayed(tx.id) {
                continue;
            }
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
            self.queue_retained_delivery(
                id,
                DeliveryTrigger::Rollback,
                SubmissionDeliveryGoal::EnsureBroadcast,
            );
        }
    }

    pub(super) fn clear_local_artifacts(&mut self) {
        self.retain_submitted(|_| false);
        self.pending_deliveries.clear();
        self.delivery_attempts.clear();
        self.completed_delivery_attempts.clear();
        self.replay_epoch.clear();
    }

    #[cfg(test)]
    pub(super) fn test_attempt_for_submission(&self, id: u64) -> Option<&DeliveryAttempt> {
        self.delivery_attempts
            .iter()
            .find(|attempt| attempt.submission_id == id)
    }

    #[cfg(test)]
    pub(super) fn test_attempt_mut(&mut self, token: u64) -> Option<&mut DeliveryAttempt> {
        self.delivery_attempts
            .iter_mut()
            .find(|attempt| attempt.token == token)
    }

    #[cfg(test)]
    pub(super) fn test_submitted(&self) -> &[SubmittedTx] {
        &self.submitted
    }

    #[cfg(test)]
    pub(super) fn test_submitted_mut(&mut self) -> &mut [SubmittedTx] {
        &mut self.submitted
    }

    #[cfg(test)]
    pub(super) fn test_next_submission_id(&self) -> u64 {
        self.next_submission_id
    }

    #[cfg(test)]
    pub(super) fn test_pending(&self) -> &[PendingDelivery] {
        &self.pending_deliveries
    }

    #[cfg(test)]
    pub(super) fn test_pending_mut(&mut self) -> &mut Vec<PendingDelivery> {
        &mut self.pending_deliveries
    }

    #[cfg(test)]
    pub(super) fn test_completed_attempt_count(&self) -> usize {
        self.completed_delivery_attempts.len()
    }
}
