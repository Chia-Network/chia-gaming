# Transaction Replay Follow-up

## Status

This document records unresolved questions about on-chain transaction replay
and rehydration. It is intentionally separate from the dynamic-acceptance and
transaction-boundary work in PR #428.

The ordinary restore path has direct unit and real-WASM coverage and is not
currently known to be broken. The concerns below involve dropped broadcasts,
repeated reorgs, and disagreement between the documented contract and the
implementation. They should be adjudicated as a separate design task before
changing replay behavior.

## Current Ownership and Restore Flow

`TransactionManager` retains each drained submission together with:

- the protocol-authored bundle;
- the exact wallet-finalized bundle after acknowledgement;
- the input coin IDs;
- expected output coins;
- an optional absolute expiry; and
- a `landed` flag.

The browser restore sequence is:

1. Deserialize the Rust transaction manager.
2. Ask `snapshot_watched_coins()` for protocol watches plus inputs of retained,
   unlanded submissions.
3. Obtain a fresh complete coin-state snapshot when there are watched coins.
4. Report that snapshot to Rust.
5. Call `resubmit_submitted()`.
6. Drain and submit whatever Rust requeued.

This ordering matters. Requeueing before the fresh snapshot can rebroadcast a
transaction whose input is already spent. Omitting retained inputs from the
fresh snapshot can prevent Rust from distinguishing a landed transaction from
a still-valid replay candidate.

## Behavior That Is Covered

The following behavior has focused coverage in `src/transaction_manager.rs`:

- `requeue_submitted_replays_retained_transactions`: a drained but unlanded
  transaction remains replayable.
- `acknowledged_submission_requeues_exact_finalized_bundle_after_fresh_sync`:
  replay uses the wallet-finalized aggregate bundle, including its original fee
  spend.
- `restored_manager_requeues_retained_on_chain_submission`: retained
  submissions survive Rust serialization.
- `requeue_submitted_discards_expired_transactions`: expired submissions are
  not replayed.
- `landed_spend_is_not_requeued_on_reload_and_is_retained_until_buried`: an
  observed expected output prevents ordinary restore replay.
- `restored_fresh_sync_queries_input_and_does_not_requeue_landed_submission`:
  fresh restore reconciliation observes both input and expected output before
  deciding whether to replay.
- `conflicting_spend_prunes_once_expected_output_is_watched`: a retained local
  intent is pruned only after the snapshot scope can provide valid conflict
  evidence.

`front-end/src/lib/tests/load_wasm.unroll_reload.test.ts` additionally exercises
a real unilateral unroll across browser reload and later chain observations.

These tests support leaving the normal rehydration path unchanged while the
edge cases below are investigated.

## Open Contract Question 1: When Should an Unlanded Submission Be Retried?

The code and documentation currently disagree.

`TransactionManager::requeue_submitted()` requeues every retained, unexpired
submission whose expected output has not landed. This includes acknowledged
submissions, using their exact finalized bundle. The browser invokes this after
fresh chain synchronization on restore or reconnect.

The implementation also contains
`no_per_block_resubmission_of_unlanded_transactions`, which explicitly asserts
that ordinary block reports do not rebroadcast an unlanded transaction.

`INTERNALS.md`, however, describes per-block rebroadcast through
`resubmit_pending`, `auto_resubmit`, and `bundle_has_relative_timelock`. Those
mechanisms are not present in the current `TransactionManager`. The same section
also first says that normal fresh sync requeues only unacknowledged entries,
then describes wallet acknowledgement as insufficient proof that a transaction
reached the mempool. The implementation follows the latter interpretation:
acknowledged but unlanded transactions are replayed after fresh sync.

The intended requirement needs to be chosen explicitly:

1. **Restore/reconnect retry only.** Wallet acceptance is trusted until the
   connection or process restarts. A silently dropped broadcast can stall until
   then.
2. **Per-block retry for safe bundles.** Output-bearing, non-timelocked bundles
   are rebroadcast while an input remains unspent.
3. **Host/network-driven retry.** Retry follows an explicit mempool or
   submission-lifecycle signal rather than every block.

This is a product and protocol-operability decision, not a cleanup to infer
from the stale documentation.

## Open Contract Question 2: What State Follows a Vanished Output?

When a watched output's creation is rolled back, `resubmit_vanished()` queues
the exact retained bundle once. The retained `SubmittedTx` remains marked
`landed`.

That works for a replay which is immediately submitted and later recreates the
output. The unproven case is:

1. transaction lands;
2. its output vanishes in a reorg;
3. Rust queues one replay;
4. that replay is drained but does not reach the mempool; and
5. the browser reloads before the output returns.

Because `requeue_submitted()` only selects `!landed` entries, the restored
manager may not retry that vanished transaction. The current code also uses a
set of vanished coins, so an output which remains absent does not repeatedly
produce a newly-vanished event.

Before changing this, add a test for the exact sequence above. If replay is
required, replace the one-way `landed: bool` with an explicit lifecycle such as
`Unobserved`, `Landed`, and `VanishedAwaitingReplay`. Do not simply clear
`landed` without checking conflict pruning, expiry, watch interest, and
wallet-finalized bundle reuse.

## Open Contract Question 3: Reorg While the Browser Is Offline

Rollback detection currently has strong evidence when the reported peak height
decreases or a watched coin explicitly reappears with changed chain state.
There is a harder case when:

1. an expected output was observed before shutdown;
2. a replacement chain removes that output while the browser is offline; and
3. the replacement peak is equal to or higher than the last persisted height.

On restore, absence from the live set may look like a spend rather than a
rolled-back creation unless the coin-state API supplies enough explicit
creation/spend information to distinguish them. This is a hypothesis, not a
confirmed failure. A simulator test should establish what records the poller
actually supplies for the removed output and its parent before any recovery
logic is proposed.

## Required Test Matrix Before Redesign

Any replay follow-up should cover at least:

1. unacknowledged, unlanded submission restored with an unspent input;
2. acknowledged, unlanded submission restored with an unspent input;
3. landed submission restored while its output remains live;
4. conflicting input spend restored while the expected output is absent;
5. landed output vanishes and its creating transaction is replayed once;
6. the first replay is dropped, followed by another reload;
7. replayed output reappears and then vanishes in a second reorg;
8. output disappears during an offline equal-or-higher-tip reorg;
9. absolute-expiry behavior at and beyond the boundary;
10. relative-timelock bundles are not made invalid by an unsafe retry policy;
11. exact wallet-finalized fee spends survive every replay path; and
12. handlers do not receive duplicate semantic creation/spend events merely
    because the manager retried a transaction.

Tests should assert submitted bundle bytes, retained-manager state, watched coin
interest, and emitted semantic observations. Merely asserting that the final
channel status advances can hide duplicate submission or notification bugs.

## Non-goals for PR #428 Follow-up

The transaction-boundary correction should not:

- add per-block transaction rebroadcast;
- change `landed` or vanished-submission semantics;
- alter retry treatment of relative timelocks;
- add compatibility decoders or persistence migrations; or
- weaken strict acknowledgement and retained-submission assertions.

Only the independently required Rust/WASM serialization schema bump belongs in
that work. Replay semantics should change later, after the contract questions
and test matrix above are resolved.
