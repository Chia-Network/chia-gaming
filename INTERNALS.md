# Internals

Protocol mechanisms and internal invariants. For the conceptual overview, see
`OVERVIEW.md`. For on-chain dispute resolution, see `ON_CHAIN.md`.

## Table of Contents

- [Timeouts](#timeouts)
- [Peer Disconnect Invariant](#peer-disconnect-invariant)
- [Peer Error Escalation](#peer-error-escalation)
- [Local Action Errors](#local-action-errors)
- [Batch Rollback Scope](#batch-rollback-scope)
- [Blockchain Observation Boundary](#blockchain-observation-boundary)
- [Atomic Proposal Factory Invariants](#atomic-proposal-factory-invariants)
- [cached_redo_actions and the Redo Mechanism](#cached_redo_actions-and-the-redo-mechanism)
- [Cheat Support](#cheat-support)
- [Simulator Strictness](#simulator-strictness)
- [Test Infrastructure](#test-infrastructure)
- [Invariant Assertions: game_assert! / game_assert_eq!](#invariant-assertions-game_assert--game_assert_eq)

---

## Timeouts

There are three distinct timeouts in the system:


| Timeout           | Purpose                                                                                                                                                                                    | Typical test value |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `channel_timeout` | Safety timeout for the watcher to detect channel coin spends. Not an on-chain timelock. The hub accepts values in the 3-30 block range and defaults to 15.                         | 15 blocks          |
| `unroll_timeout`  | On-chain `ASSERT_HEIGHT_RELATIVE` on the unroll coin. Controls how long the opponent has to preempt before the timeout path succeeds. The hub accepts values in the 3-30 block range and defaults to 15. | 15 blocks          |
| `game_timeout`    | On-chain `ASSERT_HEIGHT_RELATIVE` on each game coin (referee). Controls how long the current mover has before the opponent can claim a timeout. Stored in `OnChainGameState.game_timeout`. Proposals are restricted to 3-100 blocks; the UX defaults to 15 blocks. | 15 blocks          |


**Important:** Game coins are registered with the watcher using their specific
`game_timeout` (from the referee), not the `channel_timeout`. The
`channel_timeout` is the normal channel/unroll watcher timeout configuration.
One bootstrap exception exists in the initiator handshake path, where channel
coin registration currently uses a fixed large timeout (`Timeout::new(1_000_000)`).

**Timeout transactions** should be submitted as soon as the relative timelock
allows (i.e., at the exact block height where the coin's creation height +
timeout = current height). The simulator enforces this by panicking if a
transaction with an unsatisfied `ASSERT_HEIGHT_RELATIVE` is submitted to the
mempool.

The default 15-block unroll timeout gives honest users enough time to preempt
stale unrolls without making mainnet dispute resolution overly slow. At mainnet
block cadence it is roughly five minutes; in the simulator it is roughly 150
seconds. The hub bounds channel and unroll timeout negotiation to
3-30 blocks so users can make small adjustments without accepting arbitrarily
long or short dispute windows.

### Eager Timeout Submission and Confirmation-Driven Notifications

Timeout handling is split into two decoupled responsibilities: the
`TransactionManager` owns **submission** (and its timing), while the handlers
own **notification**, driven by observing the resulting on-chain spend. There is
no maturity callback into the handlers — `coin_timeout_reached` was removed.

**Eager claim, registered up front.** When a coin that can be claimed on timeout
is registered, the handler pre-builds the claim `SpendBundle` and attaches it to
the registration. The plumbing carries it end to end:
`Effect::RegisterCoin { spend: Option<SpendBundle>, .. }` →
`GameSessionEvent::WatchCoin { spend, .. }` →
`TransactionManager::register_watch(.., spend)`. The manager also returns the
watch registration to the host as a `watchCoins` polling delta. There are three
eager-claim sites:

- the unroll-via-timeout claim, built at `WaitForTimeout` registration
(`build_unroll_timeout_spend`);
- the per-game-coin timeout claim, built when game coins are first registered
(`build_timeout_claim` / `register_initial_game_coins`).

A claim is attached **only when the timeout pays us**; otherwise the field is
`None` and the manager submits nothing on our behalf.

**The manager is the sole submitter.** Each `WatchedCoin` stores the optional
`timeout_spend` plus a reorg-aware `birthday` and a `claim_submitted` flag. On
every block the manager submits a stored claim once the coin reaches
`birthday + timeout_blocks` while it is still unspent, setting `claim_submitted`.
A reorg that rolls back or shifts the coin's birthday re-arms `claim_submitted`,
so the claim is resubmitted. This replaced the old lazy "build and submit at the
moment the timeout fires" logic in the handlers.

**Reorg boundary: leaf logic pretends reorgs do not happen.** Protocol handlers
are intentionally written against a simplified lifecycle: they register coins,
hand the transaction manager any timeout/safety spend that should be submitted
when mature, and then react to the semantic lifecycle events they observe. They
do not own maturity polling, reorg replay, or repeated resubmission decisions.

The transaction manager is the boundary that absorbs chain churn. It tracks
creation and spend heights, detects rollback, re-arms stored timeout claims when
a watched coin's birthday changes, retains submitted transactions across
restore, and resubmits transactions whose output coins vanished because their
creation was rolled back. Handler-level logic should not receive repeated
semantic events merely because a reorg made the same transaction need replaying.
It is also the sole watch registry: handlers emit `WatchCoin` intents, while the
manager converts authoritative raw snapshots into ordered `Created`, `Spent`,
then height observations for `GameSession`. The session never maintains or
filters a second watch set.

The same ownership applies to submission intent: Rust
`TransactionManager` is its durable retained owner. The controller's
nonserialized `PendingSubmissionDelivery` map bridges only a submission already
drained from Rust but not yet launched when the committed runtime lease is
replaced. Lease replacement may reschedule that persistence-gated launch. Once
the launch has entered `TransactionSubmitQueue`, that ordered queue owns
exactly-once completion and the bridge cannot schedule it again.

**Retained transaction rebroadcast.** When the manager drains a transaction for
submission, it keeps a retained copy for reload/reorg recovery and derives the
output coins that transaction should create from its `CREATE_COIN` conditions.
Those expected outputs are replay/conflict metadata only. They do not become host
poll targets unless a protocol handler separately registers the coin as watched.
After the wallet accepts the transaction, the host acknowledges that retained
entry and stores the exact wallet-finalized aggregate bundle. Wallet delivery and
chain landing are independent durable facts.

There are exactly two replay paths:

- **Ordinary fresh synchronization.** Restore or reconnect first obtains a
  complete coin snapshot, then calls `resubmit_submitted`. Only unexpired,
  unlanded entries still awaiting wallet acknowledgement are requeued.
  Acknowledged entries are not ordinarily rebroadcast, and block reports do not
  create a per-block retry loop. An unavailable wallet call remains awaiting
  acknowledgement for a later fresh-sync retry; an explicit rejection retires
  only that stable submission ID.
- **Rollback replay.** A lower tip opens a rollback epoch and queues every
  surviving retained transaction at most once. At an equal or higher restored
  tip, replay requires causal evidence for one retained transaction: a
  previously landed watched expected output is explicitly absent while an input
  from that same atomic bundle is explicitly live again. Only the matching
  transaction is queued. Opening either replay path invalidates stale landing
  evidence and sets delivery back to awaiting acknowledgement, so a replay
  drained but unavailable before another reload remains recoverable.

Every rollback replay reuses the exact stored wallet-finalized bundle and
`AlreadyPaid` fee intent; it never asks the wallet to construct a second fee
spend. `rollback_replayed_ids` survives drain and acknowledgement for the current
epoch, preventing the height report and its following same-tip snapshot from
duplicating a replay. Re-observing the expected output closes that transaction's
epoch so a later independent rollback can replay it once again.

Here “replay” means **transaction rebroadcast** of exact retained chain bytes.
It is unrelated to **reliable peer-frame replay**, where the transport resends
unacknowledged numbered protocol frames after reconnect or peer availability.

The host poller makes this evidence explicit. Once all interests are registered
and a coin-record request succeeds, every queried coin produces a
`CoinStateRecord`; an omitted provider record becomes null creation and spend
heights. Registration failures, provider failures, and malformed records suppress
the snapshot instead of fabricating absence. Retained inputs remain reconciliation
interests while their transaction is unlanded and, after landing, only while a
watched expected output remains inside the manager's confirmation-depth recovery
window. They are then unwatched rather than polled indefinitely.

Conflict pruning and absolute expiry still apply before either replay. If an
input is spent and a complete snapshot already covered a watched missing
expected output, another transaction won and the obsolete local intent is
forgotten. The first input-spent report cannot prove that when the handler only
registers the output in reaction to that report, because the host queried the
older scope.

Focused coverage lives in `src/transaction_manager.rs`, including
`height_only_rollback_replay_survives_drain_failure_and_restore`,
`restored_equal_or_higher_tip_reorg_replays_exact_finalized_bundle_per_epoch`,
`conflicting_spend_prunes_once_expected_output_is_watched`, and
`requeue_submitted_discards_expired_transactions`. The browser/simulator restore
boundary is covered by the offline equal-tip replacement case in
`front-end/src/lib/tests/load_wasm.unroll_reload.test.ts`.

**Spends first observed as already-spent are still forwarded.** A watched coin
whose very first observation already carries a spend height (an opponent's coin
that was published and spent before our first poll of it) never enters the live
set, so the present→absent diff cannot surface it. The manager captures these
`first_seen_spent` coins and emits an ordered `Created` then `Spent` pair; without
the creation first, a handshake handler cannot transition before the spend is
delivered, and without the spend, a handler waiting on an
opponent-published unroll coin stalls forever
(`coin_first_seen_already_spent_is_forwarded_as_spend`). Those records already
carry `created_height` (birthday) and `spent_height` (`spent_confirmed_at`).

**Unspent-only feeds and spend-height inference.** Some feeds report only the
live unspent set and omit spent coins entirely (no `spent_height` on a record).
When a coin that was already live (birthday already set from creation) leaves
that set during forward progress, the manager infers a spend and, if
`spent_confirmed_at` is still unset, stamps the current poll height as a lower
bound. This is distinct from first-seen-already-spent (real spend height) and
from reorg handling: a reorg that rolls back or remine-shifts a coin's creation
clears or updates `birthday` so relative timeouts re-arm from the new creation
height — it does not rely on the poll-height spend stamp.

**Host polling vs semantic coin ownership.** The browser-side poller owns the
active transport queue of coin names to query. It reports raw coin-state
observations to the WASM transaction manager, and it may stop polling a coin
after it has reported a sufficiently buried spend. The transaction manager still
owns the semantic lifecycle: it decides which observed states become
`coin_created`/`coin_spent`, handles first-seen-spent coins, detects reorgs,
re-arms timeout submissions, and prunes retained transactions. In other words,
the poller may forget how to query a terminal coin, but it does not interpret
what that terminal coin means for the channel or game.

**Notifications ride the observed spend.** Terminal notifications are emitted
from `handle_game_coin_spent` (via the `coin_spent` → `coin_puzzle_and_solution`
pipeline) by interpreting what the observed spend created — our reward coin
(we claimed) vs. the opponent's reward coin (they moved or claimed). In the
common opponent-moved case our eager claim simply never confirms and the game
advances; nothing is pre-emptively notified. See
[On-Chain Step 5](ON_CHAIN.md#step-5-timeout-resolution) for the full outcome
table.

---

## Peer Disconnect Invariant

When a peer calls `go_on_chain`, its peer connection is **immediately severed**.
No further peer messages are sent or received by that peer. The other peer is
**not notified directly** — it only discovers the on-chain transition when it
sees the channel coin being spent on the blockchain.

This is enforced in `GameSessionState`:

- A `peer_disconnected: bool` flag is set to `true` at the start of
`GameSession::go_on_chain`, before any on-chain logic runs.
- The same flag is also set from channel status transitions in
`emit_channel_status_if_changed` when state becomes `GoingOnChain`,
`Unrolling`, or (`ResolvedUnrolled`/`ResolvedStale` while already on-chain).
- `PacketSender::send_message` silently drops outbound messages when
`peer_disconnected` is true.
- `GameSession::deliver_message` silently drops inbound messages when
`peer_disconnected` is true.

After disconnection, all state updates come from coin-watching events. The
disconnected peer's own unroll transaction is detected via the same
`handle_channel_coin_spent` path that handles opponent-initiated unrolls (see
[Unified Path](ON_CHAIN.md#unified-path)).

Historically, `ChannelState` had an `initiated_on_chain` field intended for
transition bookkeeping. In current code, the behavior above is enforced by
peer disconnection and handler replacement (`OffChainPhase -> SpendChannelCoinPhase`)
rather than by checking `initiated_on_chain` at runtime.

**Key code:** `src/game_session.rs` — `go_on_chain`,
`emit_channel_status_if_changed`, `send_message`, `deliver_message`;
`src/session_phases/mod.rs` — `go_on_chain`, `take_channel_spend_next_phase`

### Peer Error Escalation

Any error processing a peer message — during handshake or active play — is
treated as a protocol violation. The cradle sets `peer_disconnected = true`,
emits a `ReceiveError` event for diagnostic purposes, and calls
`go_on_chain(true)` on the active handler. The specific behavior depends on
the channel lifecycle stage:

**Before funding transaction is submitted** (early handshake — steps A through
C/D): No money is on-chain. The handshake handler sets an internal `failed`
flag, `channel_status_snapshot()` returns `ChannelStatus::Failed`, and the
session is terminally dead. No dispute is needed because no funds are at risk.

**After funding transaction is submitted but before channel coin confirms**
(steps E/F onward): The funding `SpendBundle` is in the mempool or pending
inclusion. Two outcomes are possible:

1. The funding transaction **times out** (its `ASSERT_BEFORE_HEIGHT_ABSOLUTE`
   expires without inclusion). The `TransactionManager` detects this and
   independently emits a `Failed` channel status. Funds return to the wallets.

2. The channel coin **appears on-chain** despite the peer being hostile.
   `coin_created` fires, the handshake handler transitions to `OffChainPhase`
   via `take_replacement()`. After the swap, `process_effects` sees
   `peer_disconnected && handshake_finished() && !is_on_chain` and immediately
   calls `go_on_chain(true)` on the new `OffChainPhase`, submitting the unroll
   transaction. From this point forward, the normal dispute resolution path
   applies.

**After channel coin is confirmed** (active play in `OffChainPhase`): The
normal `go_on_chain` path runs immediately — cancel proposals, build the
channel-to-unroll spend bundle, submit it, and transition through
`SpendChannelCoinPhase` into `OnChainPhase`.

This means a hostile peer cannot cause silent data loss regardless of when the
attack occurs. Pre-funding errors are cheap (just abort). Post-funding errors
either resolve through timeout (funds return) or through dispute (unroll +
on-chain resolution).

### Local Action Errors

Local actions (moves, proposals, shutdown) queued in `game_action_queue` are
drained by `flush_pending_actions`. Unlike peer errors, local action failures
indicate programming bugs — the queue was populated by our own UI/logic.

The cradle catches `flush_pending_actions` errors and emits them as
`ActionFailed` notifications shown to the user with the full error string.
`drain_queue_into_batch` uses a narrow local `BatchPlan`: it packages actions
against a cloned channel while staging queue disposition and effects, then
commits those together only after cached-unroll finalization succeeds. If one
trusted action fails while packaging, only that action is removed and
attributed through `ActionFailed`; every other queued action remains in its
original order. If finalization fails, the full original queue remains. This is
atomic batch packaging, not general rollback or retry. `OffChainPhase` owns both
halves of the boundary: planning mutates only `BatchPlan`; commit installs its
channel, queue disposition, and effects together. The plan owns and mutates
only durable protocol and queue working state. Transient, nonserialized caches
remain outside it and are not transactionally cloned.

A valid received batch commits before a post-receive drain reconciles known
stale local actions and emits `ActionFailed`; any remaining unexpected drain
failure is an internal error and stays fail-fast. The JS-side game action
methods (`proposeGame`, `acceptProposal`, `cancel_proposal`, `makeMove`,
`acceptSettlement`, `cheat`) also catch WASM throws and surface them through
the UI error dialog.

---

## Batch Rollback Scope

Untrusted `PeerMessage::Batch` processing takes an explicit cloneable
`OffChainWorkingState` rollback snapshot. It contains channel state, queued
local and incoming messages, potato state, peer-potato intent, clean-shutdown
correlation, latest spend commitment, and height. If a peer action or signature
check fails, the snapshot is restored and no effects or replacement phase are
published. Received `CleanShutdown` has its own narrow snapshot because it
cancels proposals before the peer signature is validated; trusted local entry
points do not use a blanket transaction wrapper.

The queue snapshot matters even though the peer cannot directly enqueue local
actions. A valid prefix of a malicious peer batch can make our pre-existing
queued local actions stale before a later action or signature check fails. If
that stale queue leaked into `go_on_chain`, the on-chain handler could attempt
local responses that were only stale because the failed peer batch partially ran.
The invariant is therefore:

- **Peer batch failure is atomic.** No proposal, game, balance, signature,
  potato, shutdown, message, or queue mutation survives a failed received
  batch.
- **Bad peer data escalates.** Ordinary `OffChainPhase::received_message` errors
  call `go_on_chain(..., true)` after rollback. That is the protocol response to
  invalid peer data.
- **Local queue drain errors are internal/local problems.**
  `drain_queue_into_batch` processes user/UI actions queued through local APIs.
  Those errors are not a normal peer-message recovery path. A valid peer batch
  commits before explicit reconciliation removes known stale game actions and
  emits `ActionFailed`; the remaining queue drains once. Unexpected local
  failures stay fail-fast. Its local `BatchPlan` protects only package
  construction: cloned durable channel state, queue disposition, and staged
  effects commit after cached-unroll finalization, with no nested retry loop.
  Transient caches are not members of that transactional clone.

Do not generalize this rollback mechanism. Its purpose is to quarantine
partially applied, untrusted peer input. Local UI calls, block-height and coin
`go_on_chain`, and ordinary local drains must not acquire nested snapshots or
retry loops. Blockchain observations are also externally controlled and get
their own narrow ingestion boundary; that does not make rollback a general
runtime error-handling mechanism. If a new peer or chain message mutates state
before all of its externally controlled data is validated, give that entry
point the narrowest complete boundary that covers those mutations.

**Key code:** `src/session_phases/mod.rs` — `OffChainWorkingState`,
`process_received_batch`, `commit_received_batch_state`,
`drain_local_actions_after_receive`,
`assert_invalid_clean_shutdown_rollback_for_testing`, and
`drain_queue_into_batch`; regressions:
`test_peer_smoke` and
`failed_final_move_bad_signature_does_not_queue_accept_settlement`.
Test-only off-chain operations are exposed through the concrete
`OffChainPhase` accessor seam on `GameSession`; they are not part of the
production lifecycle trait contract and are not stubbed across unrelated
phases.

### Transaction Submission Drain Isolation

`TransactionManager::drain_submissions` is availability-first only where it can
prove isolation. Each queued candidate is planned on a working copy and commits
independently. If `B` fails in an `A/B/C` queue, `A` and `C` commit, `B` is
consumed, and one typed failure records its candidate index, optional stable ID,
intent fingerprint, stage, bounded message, and Rust context. A later drain
does not report `B` again. Rust abandonment emits retirement IDs before removing
retained submissions, allowing the wallet ledger to cancel only the exact
provider reservations Rust no longer needs.

The host persists one bounded diagnostic incident with a JavaScript stack and
the Rust context, emits one recoverable-internal-error notification, and shows
one dismissible nonfatal modal while the game and dashboard remain active. It
must not also emit an ordinary session error or a global uncaught-error report.
This continuation is legal only because the per-item working copy proves the
remaining manager/session state intact. Unknown global integrity remains fatal.
The recovered boundary follows the live failed-checkpoint policy: attempt the
checkpoint, release safe work once even if it fails, and retain dirty in-memory
state for a later checkpoint.

---

## Blockchain Observation Boundary

Each height, coin-snapshot, or puzzle/solution callback runs against a fresh
`TransactionManager<GameSession>` working copy created by a Bencodex
serialize/deserialize round trip. This cost is intentional: the durable
transaction scope includes both the manager and the complete nested
`GameSession`, so a late handler, encoding, decoding, or application failure
cannot commit a partial chain interpretation. Rolling back effects alone would
be insufficient because observation callbacks also mutate protocol state.

Transient output is excluded from that durable copy and held in one observation
journal: pending manager events, watch and unwatch deltas, detached cradle
output, and timeout-claim reconciliation state. Failure restores that journal
unchanged. Success prepends the old journal to new output, preserving FIFO
order, and commits the working copy. Test-only stale-unroll snapshots belong to
the simulator harness and are passed explicitly; they are not production
`GameSession` or observation-journal state.

Callbacks execute with a fresh scratch `AllocEncoder`, not the caller's
allocator. A failed callback therefore leaves no CLVM allocations behind in
the caller. Any state or effect that survives the observation owns its CLVM
data as serialized `Program` bytes; allocator-local `NodePtr` values must not
cross the boundary. Requested puzzle/solution coin IDs are durable manager
state. Explicit restore reissues each still-live request once; retire-aware
controller deliveries prevent a callback owned by an obsolete runtime from
committing into its replacement. Puzzle and solution bytes remain protocol
evidence even when a trusted wallet RPC returned successfully. Malformed bytes
make the Rust callback fail transactionally and terminally block that request;
ordinary wallet-readiness or height changes do not retry deterministic invalid
data.

**Key code:** `src/transaction_manager.rs` — `ObservationTransients`,
`apply_observation_transaction`, `report_height`, and `report_coin_states`.

---

## Browser Commit Boundary

`SessionMachineRuntime` construction is inert. The committed React layout
effect installs its render callback and calls `activate()`; only then does it
attach an exclusive `SessionRuntimeLease`. Layout-effect cleanup calls only
`clearRender()`. It does not retire the lease or protocol. Replacement of the
committed lease and `SessionController` cleanup—including terminal
cleanup—own retirement. The controller retains the committed runtime while no
renderer is mounted; a later renderer reads and reattaches that same runtime
without changing protocol ownership during render.

Local restore and external recovery are separate. A valid IndexedDB envelope
and WASM cradle may project the restored shell/game/dashboard immediately,
without a live hub, wallet, or blockchain. Controls that require those services
stay gated until their independent reconciliation completes.

For an active or rehydrated browser session, the activated runtime is the only
commit owner. One stimulus is not finished merely because its first reducer or
WASM call returned. The runtime must continue through reducer effects,
controller/WASM callbacks, generated events, UX-model changes, and reliable
transport changes until the whole event graph is quiescent.

The required normal order is:

1. Drain all internal and UX-model work to a fixed point.
2. Synchronously freeze the final JS model, serialized WASM cradle, and reliable
   transport generation.
3. Attempt exactly one awaited persistence operation.
4. Publish the captured model to React.
5. Release captured peer messages, acknowledgements, wallet/chain work, and
   completion callbacks exactly once.

React rendering is a projection after the persistence attempt, not another
participant in the event drain. Intermediate models remain unpublished; this
is both the commit-boundary mechanism and the general flicker-avoidance
mechanism. Work arriving during the write belongs to the next commit and cannot
change the captured payload.

A live-checkpoint failure is serious but must not stop a game for money for an
internal storage reason. Report a persistent durability warning, publish and
release the captured gameplay/network boundary once—including cleanup,
transaction submission, and peer frame/ACK work—retain the latest in-memory
state as dirty, and retry only after later activity. Persisted and released
generations are distinct: a later successful full checkpoint captures every
still-unresolved durable intent, clears degraded durability, and does not resend
effects already released in degraded mode. There is no durability-required
effect gate. This availability choice admits a crash window in which external
effects are newer than the last durable local checkpoint.

Do not add active-session save timers, direct reducer/effect persistence,
mid-drain React updates, or eager peer sends. Every new event source must feed
the same coordinator. Pre-runtime negotiation may use the standalone reliable
transport flush, but it follows the same attempt-persistence-before-release
ordering and degraded failure policy.

`SessionRuntimeLease` is the peer transport's narrow
`ReliableCommitCoordinator` plus one capability:
`snapshotModel()` returns the authoritative runtime model. Replacing a committed
lease or cleaning up its controller retires the old runtime, discards queued
events and fire-and-forget controller work, and rejects queued result promises
and persistence-gated effects. Completion callbacks from an in-flight write
also become inert after retirement. Final controller cleanup settles unlaunched
submission deliveries and queued jobs and removes tracked effects from
quiescence. A wallet RPC that returns afterward can only register/cancel its
trade through the wallet-level ledger; it cannot mutate the dropped cradle.

The funding outbox is single-flight and persists exactly zero or one canonical
request. A restored request cannot launch while the ledger still owns a wallet
reservation for that same stable operation.
Rust creates the canonical request, the external wallet constructs the funding
offer from it, and Rust validates the returned offer. Rejection ends the
handshake; it never creates controller-owned successor or predecessor requests.

The current app-owned persistence contracts are browser session envelope v31,
Rust/WASM cradle schema 17, and independent wallet reservation record v3.
Their explicit versions are future migration hooks. None has shipped, so strict
codecs accept only the current shape and version; they do not migrate, alias, or
fallback-decode predecessors. Deployed Cloud/WalletConnect RPC, Chia offer
compression and Coinset JSON, peer/on-chain protocols, and signed-unroll
recognition remain compatibility-sensitive external contracts.
Rust snapshots convert `usize` state numbers through checked `u64`; WASM and
all internal/persisted JavaScript channel state-number fields are `bigint`.
Conversion to `number` is restricted to external APIs that require it, and
number-valued persistence or event decodes are rejected.

Persisted funding and fee offers enter the strict wallet-level durable ledger
shared across controller lifetimes. Entries preserve the exact provider trade
ID and exact `(installationPlayerId, peerSessionId, purpose kind,
operationId)` owner, so multiple trades for one operation remain independent.
Provider adapters own external offer lifecycle; the controller and Rust own
protocol intent. Wallet mutations wait for successful ledger hydration and fail
closed on malformed hydration. The only durable post-creation stages are
`reserved`, `retained-for-replay`, and `cancel-required`; pending Cloud creation
also persists its exact `signatureRequest` recovery ID. Controller retirement
promotes only `reserved` entries and preserves `retained-for-replay`.
An attached fee stays retained while Rust owns exact-byte replay; wallet
acknowledgement or Rust retirement requests typed cancellation. Cloud
cancellation is complete only after its signature request reaches terminal
success. Reloaded Cloud creation reconciles the same request without another
begin call, with popup source/origin/request correlation and exact listener and
popup cleanup. Deployed WalletConnect lacks end-to-end create-offer idempotency
and response-loss reconciliation; a lost successful response may orphan an
external offer, so retry is currently best-effort. The provider boundary keeps
an optional reconciliation capability for future support.

One IndexedDB transaction checkpoints the complete session envelope and
independent ledger snapshot atomically. Strict codecs reject unknown/missing
fields, duplicate trade IDs, invalid discriminants, and non-current versions.
One generation-fenced storage mutation coordinator serializes session, ledger,
clear, and reset writes. Old tabs and retired leases cannot overwrite a winning
generation, and a clear immediately followed by an unawaited save leaves the
save. Hard reset advances the fence before deletion and intentionally erases
every reservation, including replay retention; pre-reset writes cannot recreate
the database or cached state after the wipe.
Ledger persistence does not gate wallet use, transaction release, or
`cancelOffer`; a failed write leaves both in-memory authorities dirty for a
later full checkpoint. A failed cancellation stays in the ledger and is
retried only on restore, wallet reconnect/attachment, or an explicit
terminal-finalization attempt—never by a timer or immediate retry loop.
Unresolved cleanup blocks terminal quiescence.

Transaction submission promises span persistence-gated launch, ordered wallet
delivery, Rust acknowledgement/rejection, and fee-offer cleanup. Terminal
finalization drains those promises, controller events, persistence, and reliable
transport repeatedly to quiescence, then takes the terminal snapshot from that
post-quiescence authoritative runtime model. The terminal record must be
written before ownership is retired. Unlike a live-checkpoint failure, a
terminal-record write failure retains live ownership and blocks teardown.

The live transport checkpoint includes the cooperative terminal handoff's Rust
command identity, exact reliable frame bytes and message number, sent state, and
ACK state. Restore strictly reconciles that binding with both Rust and the
unacknowledged frame journal. An ACKed binding completes Rust without
retransmission; an unacknowledged binding reuses the same frame. The receive
reorder queue is not persisted: retransmission from the sender's durable
unacknowledged journal reconstructs the gap. Outstanding puzzle/solution host
requests are different: Rust persists their coin IDs independently of drained
events and reissues each once during explicit runtime restore.

These browser ownership and persistence rules require no peer wire schema
change. Transaction rebroadcast remains the exact-chain-byte behavior described
above; reliable peer-frame replay remains the separate numbered-frame transport
behavior.

---

## Atomic Proposal Factory Invariants

Proposal construction starts from exactly one group request:
`game_type`, game-specific `parameters`, and one timeout shared by all games in
the result. Both peers run the same registered deterministic factory. Its output
is a non-empty ordered list of canonical 10-field records containing
player-A/player-B contributions, `player_a_goes_first`, the initial state
fields, fixed my-turn and their-turn handlers, and a nonempty validator
registry. The registry's first program is initially current; later programs are
selected by tree hash. The host derives the amount from the contributions and
uses the first validator's hash as the protocol identity.

The result remains in stable A/B orientation. The proposal-wide
`sender_is_player_a` maps sender/receiver and local/opponent perspectives onto
that orientation. The higher layer selects the fixed handler matching the local
initial turn and projects A/B contributions into local contribution fields.
This avoids peer-specific factory runs or proposal parsers while ensuring both
peers commit to the same ordered records. Calpoker and Space Poker factories
return one record; Krunk returns two.

Rust supports multiple pending proposals. The browser intentionally admits only
one uncancelled proposal at a time across local and peer origins as a product
policy; a second incoming proposal is definitively cancelled without frontend
admission, while cancelling an existing entry releases the slot. This is a
temporary single-hand UX constraint. Future multi-hand work should replace the
frontend admission and presentation policy, not narrow Rust's ledger or wire
protocol.

Atomicity is enforced at three boundaries:

1. **Propose:** Store and send only the proposal ID, game type, opaque
   parameters, timeout, and player orientation. Factory execution, economics,
   member cardinality, and game IDs remain deferred.
2. **Accept:** When a queued acceptance executes, run the factory with the
   proposer and accepter reserves remaining after all earlier batch actions.
   Validate and build all temporary games and economics first, then commit them
   once inside the batch's already cloned channel. Allocate ordered `GameID`s
   and continue to the next action. A cancellation addresses the proposal ID
   and creates no games.
3. **Receive:** Replay acceptances in wire order with the same reserve
   orientation and calculations. The enclosing untrusted peer-batch rollback
   withholds every mutation and effect until all actions and signatures
   validate.

Do not move factory execution or game-ID allocation back to proposal time, and
do not add frontend group/member proposal identities. The accepted notification
is the correlation point between one endpoint-local proposal ID and its ordered
generated games.

---

## cached_redo_actions and the Redo Mechanism

### Design Principle

All state transitions are **forward-only**. There is no rewind logic. When a
game goes on-chain, the system either recognizes that the game coin is already
at the latest state, or it replays cached moves to advance to the latest state.
This is the "redo" mechanism.

Redo is entirely Rust-owned. The browser and game UI submit each semantic move
once; they do not journal move payloads or entropy, consume resync commands, or
call a replay API. A repeated normal `make_move` command is a caller invariant
violation and fails at the Rust phase that owns turn and pending-action state.

### Lifecycle

`cached_redo_actions` on the `ChannelState` is a
`Vec<CachedRedoActions>` (defined in
`src/channel_state/types/potato.rs`) that stores data for unacknowledged
outgoing actions. Because a single batch can contain multiple moves and game
acceptances across different games, multiple entries may need to be redone
on-chain.

There are three kinds of cached entries:

- `**CachedSendMove`** — a move we sent but the opponent hasn't acknowledged.
Stores the move data, the puzzle hash it operates on (`match_puzzle_hash`),
and the post-move puzzle hash (`saved_post_move_last_ph`).
- `**CachedAcceptSettlement`** — a game acceptance we sent. Stores the game ID, puzzle
hash, live game state, and reward amounts. When the potato returns
(acknowledgment), `drain_cached_accept_settlements` emits `GameSettled` with
`outcome: accept_settlement` for each cached accept.
- `**ProposalAccepted**` — an internal per-ID protocol replay marker for a
proposal acceptance we sent. Stores one game ID and is repeated for members of
an atomic group. This exact `CachedRedoActions::ProposalAccepted` Rust name is
not the UI notification; UI acceptance is one ordered
`GameNotification::ProposalAcceptedGroup`. The marker is used during stale
unroll handling to distinguish in-flight proposal accepts (which get
`EndedCancelled`) from fully established games (which get `GameError`).

**Set** in `send_move_no_finalize` (moves) and
`send_accept_settlement_no_finalize` (accept settlements).

**Cleared** (selectively) when we receive the potato back:

- `CachedSendMove` entries are cleared in `verify_received_batch_signatures`
and `received_empty_potato` (the opponent's response acknowledges our moves).
- `ProposalAccepted` entries are also cleared on potato receive.
- `CachedAcceptSettlement` entries are **retained** across those clears and only drained
  later by `drain_cached_accept_settlements` during `commit_received_batch_state` or clean
  shutdown, when `GameSettled` notifications are emitted.

### How Redo Works

When game coins are created after an unroll, `set_state_for_coins` checks each
coin's puzzle hash against all entries in `cached_redo_actions`:

1. **Coin PH matches a `CachedSendMove.match_puzzle_hash`**: The game coin is at
   the state our cached move operates on. A redo is needed to replay that move
   on-chain. Set `our_turn = true`.
2. **Coin PH == `last_referee_puzzle_hash`**: The game coin is at the latest
   state. No redo needed. Set `our_turn` based on `is_my_turn()`.
3. **Neither matches**: Error condition (game disappeared or unexpected state).

**Why `match_puzzle_hash` is the right value.** When a player makes a move via
`send_potato_move`, the `puzzle_hash_for_unroll` in the move result is the
curried referee puzzle hash of the **pre-move** state (computed from
`self.spend_this_coin()` before updating the referee). This value is stored as
`match_puzzle_hash` in `cached_redo_actions`. It corresponds to the puzzle
hash the unroll coin would create for this game coin if the unroll resolved
at the state *before* our move — which is exactly the puzzle hash that
appears on-chain in both the non-stale redo case and in a stale unroll at
that state.

Multiple games may need redos simultaneously if the batch contained moves for
different games. Redo transactions are emitted in parallel during
`finish_on_chain_transition`, with a `PendingMoveSavedState` entry inserted into
the handler's `pending_moves` map for each one.

**In-flight proposal acceptances** (`CachedRedoActions::ProposalAccepted` entries in
`cached_redo_actions`) don't trigger a redo — if the game coin never
materialized on-chain, the game is cancelled (`EndedCancelled`).

### When Redo Happens (and When It Doesn't)

A redo is triggered when:

- We sent a move that wasn't acknowledged before going on-chain
- The unroll/preemption resolved to the state *before* that move

A redo is NOT needed when:

- The preemption or timeout resolved to the latest state (our move was already
included in the unroll data)
- We were the *receiver* of the last move (nothing to replay)

### Stale Cache After Peer Disconnect

When `go_on_chain` is called, all incoming peer messages are black-holed (see
[Peer Disconnect Invariant](#peer-disconnect-invariant)). If we sent actions
(adding to `cached_redo_actions`) but the peer's response — which would normally
clear the entries — arrives *after* the disconnect, the entries remain.
This is expected and correct: the stale cache causes `set_state_for_coins` to
detect that redos or cancellations are needed, replaying our unacknowledged
moves and timeout claims on-chain.

### Redo and User-Queued Moves Can Coexist

There are two sources of on-chain actions after `go_on_chain`:

- **Redo actions** (from `cached_redo_actions`): moves or accept settlements we
already sent with the last potato but that weren't acknowledged before going
on-chain. These apply to games where **it was our turn and we acted**.
- **User-queued actions** (from `game_action_queue`): moves the user queued
(via `make_move`) while waiting for the potato or after going on-chain. These
apply to games where **it was the opponent's turn** (so we couldn't have sent
anything yet), or actions queued after the transition.

Because moves alternate, a single game cannot have entries in both lists — you
can't have an unacknowledged move you sent (it was your turn) and a queued move
waiting to send (it was their turn) for the same game. But with multiple games
running simultaneously, some games may need redos while others have queued
moves. Both are placed on `game_action_queue` and processed independently; any
sequencing within a single game (e.g. redo a move then claim a timeout) is
enforced by on-chain coin dependencies, not queue order.

---

## Cheat Support

**This feature is for testing and demonstration purposes only.**

The `cheat(game_id, mover_share)` call submits a move containing illegal data
to the game, allowing tests and demos to exercise the slashing and timeout
paths. The `mover_share` parameter is what the cheater leaves for the victim on
timeout (zero to take everything). Cheating is a first-class action that flows
through the normal queue/redo pipeline — there is no separate "enable cheating"
step.

### How It Works

When `cheat()` is called on a `GameSession`:

1. A `GameAction::Cheat(game_id, mover_share, entropy)` is queued internally.
2. Like a normal `Move`, the `Cheat` action is deferred until it is the
  player's turn.
3. When processed (off-chain in `drain_queue_into_batch` or on-chain in
  `do_on_chain_action`), the handler atomically:
  - Enables cheating on the `ChannelState`'s referee for that game,
  substituting `0x80` (nil) as the move bytes and the given `mover_share`
  (which becomes the victim's share on timeout).
  - Executes the move through the normal referee path. The referee bypasses
  validation and produces a game-move with the fake data.
4. The resulting move is sent to the opponent, who detects the invalid data and
  can slash on-chain.

### Outcomes


| Scenario                        | Notification (cheater)                                       | Notification (victim)                                         |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| Opponent detects and slashes    | `GameSettled { outcome: opponent_slashed_us, … }`             | `GameSettled { outcome: slashed_opponent, … }`                |
| Opponent fails to slash in time | `GameSettled { outcome: opponent_timed_out, … }`             | `GameSettled { outcome: opponent_cheated, … }`                |


**Key code:**

- `src/game_session.rs` — `GameSession::cheat`
- `src/session_phases/types.rs` — `GameAction::Cheat`
- `src/session_phases/mod.rs` — `cheat_game`, `drain_queue_into_batch` (Cheat arm)
- `src/session_phases/on_chain.rs` — `do_on_chain_action` (Cheat arm)
- `wasm/src/mod.rs` — WASM `cheat` binding

---

## Simulator Strictness

The simulator (`src/simulator/mod.rs`) can run in strict mode
(`Simulator::new_strict()`), which panics on conditions the real blockchain
would silently reject or ignore. The main potato-handler integration suite uses
strict mode; some simulator tests also run explicitly in non-strict mode. In
non-strict mode the simulator behaves like a normal blockchain, returning rejection codes
instead of panicking. The point of strict-mode panics is that in a correct
implementation none of these conditions should ever occur — hitting one means
there is a bug.

The simulator service's `replace_chain` operation validates rollback and target
height bounds before calling `reorg` or mutating its coin adapter and simulation
record. An invalid replacement request therefore leaves runner state unchanged.

**Strict-mode panics** (non-strict mode returns rejection codes instead):


| Check                           | What it catches                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Puzzle hash mismatch**        | Computed puzzle hash differs from the coin record's puzzle hash. Indicates incorrect puzzle reconstruction.                    |
| **Premature timelock**          | `ASSERT_HEIGHT_RELATIVE` not yet satisfied at submission time. The real chain silently drops these.                            |
| **Conflicting mempool spends**  | Two different transactions spending the same coin. The real chain picks one.                                                   |
| **CLVM execution error**        | Puzzle/solution fails to run. Means the code submitted a malformed transaction.                                                |
| **Aggregate signature failure** | Spend bundle's aggregate signature does not verify. Means signing logic has a bug.                                             |
| **Implicit fee mismatch**       | Implicit fee differs from declared `RESERVE_FEE`. In strict mode this now panics to enforce explicit fee accounting.             |
| **Coin not found**              | Spending a coin that doesn't exist. Means stale state or a logic error in coin tracking.                                       |
| **Already spent**               | Spending a coin that was spent in a prior block. Means stale timeout or duplicate submission.                                  |
| **Minting**                     | Outputs exceed inputs (creating value from nothing). Means incorrect amount calculation.                                       |
| **RESERVE_FEE not satisfied**   | Declared fee exceeds available implicit fee. Means the fee arithmetic is wrong.                                                  |
| **Missing validated spend**     | `validated.spends` has no entry for an input spend index. Accepting would skip CREATE_COIN / relative-lock bookkeeping.        |


**Conflicting mempool spends are the one exception to "this can only be a bug."**
Two *different* transactions spending the same coin is perfectly normal on a real
chain: it happens whenever both parties go on chain at once, a peer misbehaves, or
the two sides are temporarily disconnected, and the chain resolves it for free
(only one spend of a coin can confirm). Strict mode still fails fast on it because
an *unexpected* conflict is usually a symptom worth investigating, and failing at
the point of conflict is far easier to debug than a divergent outcome many blocks
later. (Resubmitting an *identical* bundle is not a conflict — the mempool
de-duplicates by fingerprint.) The genuine bug this guards against is a single
party putting two different competing transactions on chain itself (e.g. holding a
good clean-shutdown and *also* unrolling). When a test legitimately drives both
sides to spend the same coin, it must designate a winner by nerfing the loser; see
[Strict Mode](SIMULATOR_TESTING.md#strict-mode-why-double-submission-fails-tests)
in the simulator testing reference.

**Key code:** `src/simulator/mod.rs` — `push_transactions`

---

## Test Infrastructure

### Debug Game

The debug game (`b"debug"`) is a minimal game used for tests that need precise
control over `mover_share`. It is registered in the Rust game table for test
infrastructure only, not as a user-facing game. Its core handler/curry wiring
lives in `src/test_support/debug_game.rs`, while `DebugGameTestMove::new(mover_share, slash)`
is defined in `src/simulator/tests/session_phases_sim.rs`.

### Simulation Test Actions

Tests drive the simulation loop with a sequence of `GameAction` values defined
in `src/test_support/sim_script.rs`. The current action catalog, trigger semantics,
two-phase `AcceptProposal` behavior, and stall-detection notes live in
`SIMULATOR_TESTING.md`.

**Key code:**

- `src/test_support/debug_game.rs` — `DebugGameHandler` and debug game registration
- `src/simulator/tests/session_phases_sim.rs` — `DebugGameTestMove` and integration scenarios
- `src/test_support/sim_script.rs` — `GameAction` enum (sim-tests variant)
- `SIMULATOR_TESTING.md` — simulator testing reference

---

## Invariant Assertions: `game_assert!` / `game_assert_eq!`

These macros are the primary tool for the codebase's
[fail-fast philosophy](OVERVIEW.md#design-philosophy-fail-fast): when an internal
invariant is violated, surface it immediately instead of adding a
belt-and-suspenders backstop that tolerates the broken state.

Production code must never crash on bad data from peers or the blockchain.
At the same time, internal invariant violations are bugs that should be caught
loudly during development and testing.

The `game_assert!` and `game_assert_eq!` macros (defined in
`src/common/types/macros.rs`) bridge these two needs:

- **Debug / test builds:** the macro panics immediately (via `debug_assert!`),
making invariant violations impossible to miss during development.
- **Release builds:** the macro returns `Err(Error::StrErr(...))`, allowing the
caller to handle the failure gracefully (typically by emitting a `GameError`
notification and continuing).

### Usage

```rust
game_assert!(self.have_potato, "must have potato to send accept");
game_assert_eq!(expected_ph, actual_ph, "puzzle hash mismatch");
```

The calling function must return `Result<_, Error>` — the compiler enforces
this because the macro contains a `return Err(...)`.

### When to use each pattern


| Situation                                     | Pattern                                           |
| --------------------------------------------- | ------------------------------------------------- |
| Internal invariant (own logic)                | `game_assert!` / `game_assert_eq!`                |
| Data from peer or blockchain                  | Return `Err` directly (never trust external data) |
| Deserialization of wire data                  | `map_err(serde::de::Error::custom)?`              |
| Infallible conversions (e.g. `0.to_bigint()`) | `.unwrap()` is acceptable                         |
| Test-only code                                | Standard `assert!` / `assert_eq!`                 |


### Rationale

Before these macros, the codebase used a mix of `assert!`, `.expect()`, and
`.unwrap()` for invariant checks — all of which panic unconditionally, crashing
the process even in production when a trusted full node sends bad data. The
macros replace these with a single consistent pattern that is strict during
development but graceful in production.

**Key code:** `src/common/types/macros.rs`
