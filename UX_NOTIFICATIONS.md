# UX Notifications

For the conceptual overview, see `OVERVIEW.md`. For the frontend component
hierarchy, notification routing, hub relay protocol, session persistence,
peer message reliability, and reconnect reconciliation, see
`FRONTEND_ARCHITECTURE.md`. For the authoritative settlement outcome glossary
(off-chain accept + on-chain #1–#11), see
[`NAMING_AUDIT.md` — Settlement glossary](NAMING_AUDIT.md#settlement-glossary-ux). The frontend supports full page reload — game state
is continuously saved to IndexedDB and restored on reload with a fresh RNG
seed.

## Authority vs projection

Rust notifications are protocol facts. JavaScript renders and persists their
browser envelope, but does not infer settlement, channel lifecycle, or
protocol validity from display data. A UI action is an intent sent to Rust.
`LocalActionApplied` is the host-only fact that an immediate or queued local
action was actually applied; merely accepting an API call into Rust's queue is
not enough. The sole JS exception is explicit client capability policy, such
as declining a second concurrent proposal group while still supporting each
independently progressing game within an accepted group.

The UI layer receives events via the `ToLocalUI` trait callbacks and
`GameNotification` variants (delivered through `game_notification`).

The focused `GameSlice` atomically owns active/current-hand IDs, keyed game
instances, the last-displayed ID, hand key, and active game type. Each instance
stores its coin, terminal data, and one canonical `GameProtocolPresentation`
discriminant; turn and hand labels are derived compatibility views, not
separately mutable state. Local turns, non-terminal `GameStatus`, coin
enrichment, settlement, and whole-group removal therefore update the owning
instance or group atomically. Version-20 saves persist only `gameInstances` plus
`lastDisplayedGameId` for protocol presentation. There are no aggregate
current-game presentation fields and no migration from older records:
incompatible alpha records are discarded.

**Important naming note:** this document sometimes uses conceptual UX labels
like "OpponentMoved" for readability. The canonical wire model in Rust is
`GameNotification` plus `GameStatusKind` for in-play status, and
`GameNotification::GameSettled` for all settled outcomes:

- dedicated variants: `ProposalMade`, `ProposalAcceptedGroup`,
  `ProposalCancelled`, `InsufficientBalance`, `MoveRejected`, `ActionFailed`,
  host-only `LocalActionApplied`, and `ChannelStatus`
- gameplay lifecycle (non-terminal): `GameNotification::GameStatus { status:
GameStatusKind, ... }`
- **settlements (terminal):** `GameNotification::GameSettled { id, outcome,
our_share, coin_id }` — off-chain `accept_settlement` plus on-chain glossary
  outcomes #1–#11; see [Settlement glossary](NAMING_AUDIT.md#settlement-glossary-ux)

Settlements no longer use `EndedWeTimedOut`, `EndedOpponentTimedOut`, or other
`Ended*` slash/timeout status kinds. Slash and cheat paths are settled outcomes
via `GameSettled` too.

So when you see a conceptual label below, map it to the corresponding wire
shape.

There is also a separate protocol view that is useful for reasoning about
on-chain behavior:

- channel lifecycle: `created -> unrolling -> resolved`
- per-game lifecycle: `off-chain -> on-chain move loop (my/their turn) -> settled`

Those are conceptual progression models; the concrete emitted values are still
`ChannelStatus { state: ChannelStatus, ... }`, non-terminal
`GameStatus { status: GameStatusKind, ... }`, and terminal
`GameSettled { outcome, our_share, ... }`.

## Table of Contents

- [WASM Event FIFO and Async Drain](#wasm-event-fifo-and-async-drain)
- [Channel Lifecycle Notifications](#channel-lifecycle-notifications)
- [Abandonment and Zero-Payout Shutdown](#abandonment-and-zero-payout-shutdown)
- [Dashboard Status Labels](#dashboard-status-labels)
- [Gameplay Notifications](#gameplay-notifications)
- [Proposal Notifications](#proposal-notifications)
- [Game Outcome Notifications (Terminal)](#game-outcome-notifications-terminal)
- [Key Invariants](#key-invariants)
- [Additional Design Rules](#additional-design-rules)

---

## WASM Event FIFO and Async Drain

Every communication produced by the Rust cradle starts as a `GameSessionEvent` in
the cradle's FIFO event queue. The `TransactionManager` drains that queue and
intercepts blockchain bookkeeping events before they reach JavaScript:
`OutboundTransaction` entries are captured for `drain_submissions()`, and
`WatchCoin` entries update the manager's watched-coin set and are returned as
`result.watchCoins` polling deltas. The remaining events — wallet requests
(`NeedCoinSpend`, `NeedLauncherCoin`), outbound peer messages, notifications,
logs, receive errors, and puzzle/solution requests — are returned to JS as
`result.events`.

Flow:

1. Rust handlers push all `GameSessionEvent`s onto the cradle queue.
2. `TransactionManager::flush_and_collect` drains that queue, intercepting
   `OutboundTransaction` and `WatchCoin` while preserving order for the events
   still delivered to JS.
3. `processResult()` applies `result.watchCoins`/`unwatchCoins` to the poller,
   appends `result.events` to the JS `eventQueue`, then drains intercepted
   submissions into the serialized wallet RPC submission lane before it calls
   `scheduleDrain()`. Notifications therefore cannot dispatch before their
   preceding watch/transport bookkeeping and submission intents have been
   accepted by the host.
4. `scheduleDrain()` is a no-op if a drain is already scheduled or the queue
   is empty. Otherwise it schedules one `setTimeout(0)` callback. That active
   drain consumes the complete synchronous FIFO, including events appended by a
   re-entrant active WASM call, before returning. To prevent a re-entrant
   producer from monopolizing the browser, a drain yields after 100 events and
   schedules the remaining FIFO for the next macrotask.

Each event is dispatched exactly once by `dispatchEvent()`, in FIFO order.
The first active event still begins in a later macrotask; subsequent events in
the same synchronous drain do not get separate timers. Event types and their
handlers:

- `OutboundMessage` — send to peer via hub
- `Notification` — surface game/channel state to the UI
- `ReceiveError` — peer message decode failure
- `CoinSolutionRequest` — fetch puzzle/solution from blockchain
- `Log` — diagnostic output
- `NeedLauncherCoin` — request the wallet to provide the launcher coin
- `NeedCoinSpend` — request the wallet to create and sign a spend bundle

`OutboundTransaction` and `WatchCoin` are intentionally absent from the JS event
list because they are intercepted during manager drain. They still originate as
queued Rust events; they just become manager state/submission buffers and
polling deltas before JS dispatch.

Why the macrotask boundary and quiescent active drain coexist:

- The timer preserves the existing asynchronous host boundary before a normal
  active result becomes visible.
- During that timer callback, an event handler can synchronously call WASM and
  append more active effects. The controller keeps the active-drain marker set,
  so those effects join the same FIFO transaction instead of scheduling a
  second visible update.
- A self-replenishing active source is bounded to 100 events per macrotask.
  The unprocessed tail remains in FIFO order and is scheduled normally, so it
  cannot starve rendering or other browser work.
- A terminal `ManagerDrainDisposition` does not use this path. It clears stale
  queued presentation/protocol work and performs its existing final flush, so
  a stale active notification cannot follow terminal presentation.

This makes the controller's active presentation delivery deterministic while
preserving terminal queue replacement, delivery-critical save failure handling,
and cooperative terminal-handoff acknowledgement behavior.

---

## Channel Lifecycle Notifications

All channel lifecycle events are delivered as a single `ChannelStatus`
notification containing the current `ChannelStatus`, balance information, and
an optional `advisory` string for context (e.g. error reason). The
`ChannelStatus` values are:

`ChannelStatus` is the notification-level state model exposed to the UI and
tests. It is distinct from peer handler ownership and from the on-chain coin
lifecycle; see [Peer Handlers vs States](OVERVIEW.md#peer-handlers-vs-states)
for how those lenses relate.

| `ChannelStatus`                  | When                                   | Meaning                                                                                                                                                                        |
| -------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Handshaking`                    | Handshake in progress                  | Channel negotiation messages are being exchanged (steps A–D)                                                                                                                   |
| `WaitingForHeightToOffer`        | Handshake waiting on block height gate | Wallet spend inputs are ready, but the protocol is waiting for the configured height to submit the offer                                                                       |
| `WaitingForHeightToAccept`       | Receiver waiting on block height gate  | Receiver is waiting for the configured height gate before accepting/submitting the channel transaction                                                                         |
| `OurWalletMakingOffer`           | Initiator waiting on local wallet      | Our wallet is building the channel-creation offer spend                                                                                                                        |
| `OurWalletMakingOfferAcceptance` | Receiver waiting on local wallet       | Our wallet is finishing/funding the channel-creation acceptance spend                                                                                                          |
| `OfferSent`                      | Our half of the spend sent to peer     | We have sent our offer/spend to the other side; they could create the channel coin                                                                                             |
| `TransactionPending`             | Full spend bundle assembled            | We have the complete channel-creation transaction in hand, waiting for on-chain confirmation                                                                                   |
| `Active`                         | Channel operational                    | Channel is live and games can be played. Emitted repeatedly as balances change (potato firings). Includes `our_balance`, `their_balance`, `game_allocated`, and `coin` fields. |
| `ShuttingDown`                   | Clean shutdown initiated               | Cooperative channel closure has been initiated (advisory protocol, not yet on-chain)                                                                                           |
| `ShutdownTransactionPending`     | Clean shutdown spend assembled         | A clean shutdown transaction has been formed. Normally the local side may submit it; with `zero_payout: true`, the peer is given the complete spend and owns publication.      |
| `GoingOnChain`                   | Explicit on-chain transition initiated | Local side has initiated transition from off-chain potato flow to on-chain resolution                                                                                          |
| `Unrolling`                      | Unroll detected on-chain               | The channel coin has been spent to an unroll coin (by either player). `advisory` describes the reason if known.                                                                |
| `ResolvedClean`                  | Clean shutdown completed               | Channel closed cooperatively; balances reflect the final split                                                                                                                 |
| `ResolvedUnrolled`               | Unroll completed (non-stale)           | The unroll was at the latest state; per-game `GameSettled` / on-chain turn status notifications follow separately                                                              |
| `ResolvedStale`                  | Stale unroll completed                 | The opponent tried to unroll with an older state; per-game outcomes follow separately                                                                                          |
| `Failed`                         | Unrecoverable error                    | The channel or unroll coin is in an unrecoverable state; `advisory` has the reason                                                                                             |

**Assumes single-handing for `ShuttingDown` timing.** The current clean shutdown
flow emits `ShuttingDown` as soon as the user requests it, even before the
potato arrives and the shutdown batch is actually sent. This is correct for
single-handing (one proposal at a time) because there is no outstanding
proposal that could fail. In a future multi-handing model, the shutdown batch
could arrive while proposals are still in flight, and the peer could reject
the shutdown or the proposals could fail. At that point, immediately reporting
`ShuttingDown` to the user would be premature — the status would need to wait
until the shutdown batch is actually sent. See `ON_CHAIN.md` for the protocol
details.

Each `ChannelStatus` notification is emitted when the `PeerLifecyclePhase` is
replaced (handler transition) or when the current handler's snapshot changes
(e.g. balance update during `Active`). The frontend uses this single
notification type for its persistent channel state display. At the WASM
boundary it is normalized into one `ChannelStatusModel`, containing the real
channel state, optional local `sessionDisposition`,
advisory, coin identity and amount, both balances, game allocation,
`havePotato`, `zeroPayout`, and optional on-chain progress context. During an
unroll, `unrollInitiator` identifies whether we or the opponent caused the
observed channel spend when that attribution is definitive; a locally queued
spend or cooperative-close setup alone leaves it unknown. `semanticPhase` is
the situation within `GoingOnChain` / `Unrolling`: submitting or resolving a
channel spend, finding the landed unroll state, preempting, waiting for the
relative timeout, or spending the timeout finish. Actor is not encoded in the
phase. These are display facts, not new lifecycle states. Banner text, the potato indicator, dashboard
actions, phase selection, persistence, and restore all project from that one
snapshot instead of maintaining parallel channel-status shapes.
During a cooperative terminal handoff, Rust sets
`sessionDisposition: AwaitOutboundTerminal`; this is a local delivery state,
not a channel result. It keeps the frontend session live until the peer
acknowledges the close command, even if the channel snapshot has already moved
to a resolved state.

Monotonicity applies across all three lenses:

- **Handler lens:** phase ownership moves forward through handler replacement;
  handlers may branch by path, but do not rewind to earlier handshake phases.
- **Notification lens:** `ChannelStatus` and `GameStatusKind` progress forward in
  lifecycle terms (with same-level repeats allowed for updates/advisory changes).
- **On-chain lifecycle lens:** coin progression is forward-only
  (`created -> unrolling -> resolved` for channels, and
  `off-chain -> on-chain loop -> terminal` for games).

When a watched timeout spend becomes mature, `TransactionManager` is the sole
component that queues its submission. Before the host drains the submission
buffer, it updates the session's canonical status snapshot to
`finishing_spending` (with `unrollInitiator` naming who started the unroll);
the normal `ChannelStatus` notification then persists and restores that fact. The UI never infers timeout maturity, submits
the transaction, or mutates a durable channel snapshot from a transient event.
If a reorg changes or clears the watched coin's birthday, the manager re-arms
the relative timeout and restores the canonical waiting phase
(`finishing_waiting_timeout`) until the claim becomes mature
again.

---

## Abandonment and Zero-Payout Shutdown

Abandonment is a local, terminal choice owned by Rust. JavaScript can request
`abandon`, but it does not validate whether abandonment is safe, infer a payout,
or synthesize a terminal channel state. `GameSession::abandon` stops local peer
participation, clears queued inbound protocol work and watched coins, and emits
the last real `ChannelStatus` snapshot with `session_disposition: Abandoned`;
it first discards pending cradle events and resync work so an older status
cannot follow the terminal result.
`TransactionManager::abandon` also discards
unsubmitted transactions, events, and watch registrations. It cannot retract a
transaction that was already broadcast or change the blockchain's eventual
resolution.

`session_disposition: Abandoned` does not mean that the channel was resolved on-chain or that the
player received zero. To keep the terminal dashboard useful after reload, the
notification carries forward the most recent channel snapshot's balances, coin,
game allocation, potato state, and `zero_payout` value. A manual abandon can
therefore show a nonzero last-known balance; that is display context, not a
promise that funds are settled or claimable.

### Zero-payout shutdown

Rust computes `zero_payout` only while the channel is shutting down. It is true
when the local current channel share is zero **and** no active game can later
produce a share. This deliberately reuses the channel's authoritative
settlement/forfeit state instead of asking React to reason about pending accepts,
game commitments, or timeout paths.

The flag keeps the clean-shutdown protocol cooperative. The zero-payout side
continues to validate, sign, and send the close material its peer needs; it does
not create its own fallback or clean-close submission. A block update or peer
silence does not silently turn that state into an on-chain spend or local
abandonment. The user may explicitly abandon while the handshake is waiting.
An explicit Go On-Chain request maps to the same local abandonment outcome
rather than creating a zero-value spend.

An inbound `deliver_message` failure is deliberately different: it is treated
as an escalation request because the local protocol host could not accept or
process a peer message. `SessionController` calls the normal Go On-Chain entry
point for that error. Rust then applies the same zero-payout remap, producing
local abandonment instead of a spend when there is nothing to protect. This is
intentional protocol-host behavior, not a frontend inference. The sole
exception is an already-issued terminal-handoff command: Rust preserves that
command until its close message is acknowledged, because abandoning it would
leave the peer without the cooperative close material.

When a zero-payout responder completes the clean-shutdown spend, Rust emits one
persisted terminal-handoff command containing `CleanShutdownComplete`. JavaScript
persists, sends, and replays that exact command until the peer acknowledges its
message number; only then may it call Rust's completion entry point. Rust then
performs the ordinary atomic local-abandonment transition. This waits for peer
receipt of the close material—not for the peer to publish or confirm the
transaction—and means the peer is solely responsible for the subsequent on-chain close.
For a zero-payout initiator, receiving `CleanShutdownComplete` proves the peer
already has every required artifact; Rust therefore abandons immediately and
does not queue the returned transaction locally.

The dashboard behavior is:

| Situation                                                         | Primary action                                                              | Why                                                                                                                                                                  |
| ----------------------------------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ShuttingDown`, `zero_payout: true`                               | **Abandon**, immediately                                                    | This is an explicit escape hatch while the cooperative handshake waits. The Rust status is the authority for this exception; it bypasses the ordinary abandon timer. |
| `ShuttingDown`, `zero_payout: false` or absent                    | **Waiting** during the cooperative-close grace period, then **Go On-Chain** | We may still have a payout or an unresolved game, so the user can escalate the cooperative close to normal on-chain resolution.                                      |
| `OfferSent`, `TransactionPending`, `GoingOnChain`, or `Unrolling` | **Abandon** only after the waiting timeout                                  | These are stalled-state escape hatches, not a payout determination.                                                                                                  |
| `ShutdownTransactionPending`, `zero_payout: true`                 | **Waiting**                                                                 | The completed close command is already durable and must remain available until the peer acknowledges it.                                                             |
| Pre-active handshake/counterparty setup                           | **Cancel** / abandonment as applicable                                      | The frontend sends `session_reject` to release the peer before terminating its local cradle.                                                                         |

The Rust `go_on_chain` entry point also checks this same zero-payout predicate.
If it is invoked despite the dashboard rule — for example by a stale UI action
or another caller — it abandons locally before producing or submitting a new
on-chain spend. This is a safety property of the protocol host, not a second
frontend decision.

On the final terminal drain, the JavaScript controller drops queued outbound protocol
messages, acknowledgements, retries, durability sends, and new watch requests;
it also replaces already-queued presentation work with presentation events from
the terminal result. This prevents a final status from racing with stale local
protocol work. The preceding terminal-handoff command is not terminal and
intentionally retains its one required outbound message until acknowledged. The terminal signal can arrive
before React has committed that final status, so Shell performs resolved-display
cleanup from the status/phase update rather than using the signal to overwrite
the dashboard snapshot.

---

## Dashboard Status Labels

The Game tab dashboard is the persistent user-facing summary. Its collapsed bar
is intentionally calmer than the raw notification stream:

`Channel: <channel status> <channel advisory> [Hand N: <status> <detail>]`

The channel half summarizes the channel lifecycle. `Unrolling` and
`ResolvedUnrolled` are not separate pop-up-worthy events; the bar is the source
of truth for those states. `Failed` and `ResolvedStale` can still produce
error-style attention because they indicate adverse channel-level outcomes.

Lifecycle rows are omitted entirely during off-chain play. Once the channel
enters on-chain resolution, the dashboard shows one row per accepted game in
the current hand (`Hand` for one game, `Hand 1`, `Hand 2`, etc. for multiple
games). Each row uses that game's own turn or terminal state:

| Hand label     | Meaning                                                                                                                                                                                   |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `No hand`      | No accepted hand is currently active or being displayed.                                                                                                                                  |
| `Active`       | The channel is going on-chain/unrolling before a concrete game coin is being tracked.                                                                                                     |
| `Your turn`    | A game coin is on-chain and the protocol says our side is the mover.                                                                                                                      |
| `Their turn`   | A game coin is on-chain and the protocol says the opponent is the mover.                                                                                                                  |
| `Playing move` | Our on-chain move is being submitted, confirmed, or replayed as part of the on-chain resolution path.                                                                                     |
| `Ended`        | A `GameSettled` or non-settlement terminal (`EndedCancelled`, `EndedError`) has been observed. The collapsed bar adds a short hand detail from the settlement glossary label when useful. |

Terminal hand details are derived from `GameSettled.outcome` via
`SETTLEMENT_OUTCOME_LABELS` in `front-end/src/lib/settlement.ts` (see
[Settlement glossary](NAMING_AUDIT.md#settlement-glossary-ux)). Full raw
details remain available in the expanded dashboard rows.

| Detail (examples)                                               | Meaning                                                   |
| --------------------------------------------------------------- | --------------------------------------------------------- |
| `Accepted`                                                      | Off-chain `accept_settlement` or on-chain `we_accepted`   |
| `Settled cleanly`                                               | On-chain close from an already-terminal state             |
| `Opponent timed out`                                            | Opponent's timeout path; intent unknown                   |
| `Forfeited`                                                     | Our share is 0 and we stopped watching (#3–#5)            |
| `Attempt to move failed`                                        | Our move did not land before the opponent's timeout claim |
| `Timed out waiting for our move`                                | Our turn; we never chose a move before the clock expired  |
| `Slashed opponent` / `Opponent slashed us` / `Opponent cheated` | On-chain dispute settled outcomes                         |

There is no session-level **Folded** label. Poker UIs may still say **Fold**
locally when calling `accept_settlement`.

All settlement details remain in the dashboard/session bar and the mounted
game result. Settlements do not enqueue a second game-scoped pop-up.

---

## Gameplay Notifications

These fire during active gameplay (after a game proposal has been accepted).

| Conceptual UX label       | Actual wire shape                                                                       | When                                                                                   | Meaning                                                                                                                                                                                                                                                                                                                             |
| ------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpponentMoved             | `GameStatus { status: MyTurn, other_params: { readable, mover_share } }`                | Opponent made a move                                                                   | It is now our turn; `mover_share` is our share on timeout from the opponent's move                                                                                                                                                                                                                                                  |
| OpponentPlayedIllegalMove | `GameStatus { status: IllegalMoveDetected, ... }`                                       | Opponent's on-chain move detected as illegal                                           | Emitted before slash resolution                                                                                                                                                                                                                                                                                                     |
| GameMessage               | `GameStatus { status: MyTurn/TheirTurn, other_params: { readable } }`                   | Informational game message                                                             | Decoded advisory/readable message payload                                                                                                                                                                                                                                                                                           |
| MoveRejected              | `MoveRejected { id, tag, message }`                                                     | A local my-turn handler rejects user input                                             | Recoverable game-scoped rejection; no peer batch is sent for the rejected move                                                                                                                                                                                                                                                      |
| LocalActionApplied        | `LocalActionApplied { id, action }`                                                     | A local move, settlement acceptance, or diagnostic cheat is actually applied           | Host-only candidate lifecycle signal. The host promotes the separately staged candidate exactly once; game packages never receive this notification.                                                                                                                                                                                |
| GameOnChain               | `GameStatus { status: OnChainMyTurn / OnChainTheirTurn / Replaying, coin_id }`          | Game transitions on-chain                                                              | On-chain phase begins for this game. `Replaying` means a cached off-chain send-move exists for this game id and will be spent as an on-chain redo (same criterion as `take_cached_move_for_game`).                                                                                                                                  |
| PlayingMove               | `GameStatus { status: PlayingMove, coin_id }`                                           | The host accepted an on-chain move for publication and we are waiting for confirmation | Transient pending-move status. In the browser, the preceding spend has entered the serialized wallet RPC submission lane; this does not claim that the asynchronous RPC succeeded, reached a full-node mempool, or confirmed on chain. In the simulator, the synchronous host boundary has already submitted it to the simulator mempool before delivering this notification. Followed by `OnChainTheirTurn { moved_by_us: true }` when the spend lands. Distinct from `Replaying`, which is a cached off-chain redo action being replayed on-chain. |
| WeMoved                   | `GameStatus { status: OnChainTheirTurn, other_params: { moved_by_us: true }, coin_id }` | Our on-chain move confirms                                                             | New game coin is tracked in `coin_id`                                                                                                                                                                                                                                                                                               |

---

## Proposal Notifications

| Notification                                                                                   | When                                         | Meaning                                                                                                                                                                                                                           |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProposalMade { id, group_ids, player_a_contribution, player_b_contribution, sender_is_player_a, timeout, game_type, parameters }` | Atomic proposal group received from opponent | Fires exactly once for the receiver. `id` is the first factory-produced game ID; `group_ids` is always the full ordered member list (singleton ⇒ `[id]`). Parameters and A/B terms are preserved exactly. |
| `ProposalAcceptedGroup { members: [{ id, player_a_contribution, player_b_contribution, our_turn }, ...] }` | Proposal accepted by either side | Fires once for the whole group. Members are in exact factory order and retain the factory-approved A/B contribution split; total amount is their sum. The two peers have opposite `our_turn` for every member. |
| `ProposalCancelled { id, reason }`                                                             | Proposal cancelled or invalidated            | The proposal was cancelled explicitly, or automatically due to going on-chain                                                                                                                                                     |

### Cancellation Reasons (`CancelReason`)

`ProposalCancelled` carries a `reason` field indicating why the cancellation
happened. The reason determines both the frontend's behavior and whether the
user is notified.

| `CancelReason`         | Emitted when                                                                                                                                                                                                                                                                                                                                 | Frontend behavior                                                                                                                                                         |
| ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `SupersededByIncoming` | A peer proposal arrived in a batch while our own proposal was queued locally. WASM removes our queued proposal because the state it was built against is now stale.                                                                                                                                                                          | **Local/silent.** Terms stashed in `pendingRetryTermsRef` for automatic re-submission (see [Proposal Collision Handling](GAME_LIFECYCLE.md#proposal-collision-handling)). |
| `PeerProposalPending`  | JS called `propose_games` while an unresolved peer proposal already exists in `proposed_games`. WASM rejects immediately to avoid silently cancelling the peer's proposal as a side effect.                                                                                                                                                  | **Local/silent.** Same retry stash as `SupersededByIncoming`.                                                                                                             |
| `GameActive`           | Reserved for future use. The JS-side guard prevents this from occurring in practice.                                                                                                                                                                                                                                                         | **Local/silent.** Clears retry state.                                                                                                                                     |
| `CancelledByPeer`      | The peer sent `BatchAction::CancelProposalGroup` for our proposal group. This usually means the peer rejected it, but the same protocol message is also used as the peer-side follow-up for failed accept attempts such as insufficient balance (see [Race Conditions in Proposal Lifecycle](GAME_LIFECYCLE.md#race-conditions-in-proposal-lifecycle)). | **User-facing notice:** the proposal did not proceed on the peer side.                                                                                                    |
| `CancelledByUs`        | We explicitly cancelled the peer's proposal (via `cancel_proposal`).                                                                                                                                                                                                                                                                         | **Silent.** We initiated the cancellation; nothing to tell the user.                                                                                                      |
| `CleanShutdown`        | The channel is shutting down cooperatively. All outstanding proposals are cancelled.                                                                                                                                                                                                                                                         | **Silent.** The shutdown UI handles this.                                                                                                                                 |
| `WentOnChain`          | The channel transitioned to on-chain resolution. Proposals not reflected in the unroll are cancelled.                                                                                                                                                                                                                                        | **Silent.** The on-chain UI handles this.                                                                                                                                 |
| `ChannelError`         | An unrecoverable channel error occurred. All proposals are cancelled as cleanup.                                                                                                                                                                                                                                                             | **Silent.** The error UI handles this.                                                                                                                                    |

The `is_local()` method on `CancelReason` returns `true` for
`SupersededByIncoming`, `PeerProposalPending`, and `GameActive`. The frontend
uses this to decide whether to stash terms for retry (local + terms available)
or show a user-facing notification (only `CancelledByPeer`). `CancelledByPeer`
should be interpreted as a peer-side protocol cancellation, not necessarily as
a deliberate human rejection.

---

## Game Outcome Notifications (Terminal)

Settlements use a **single** notification type. Non-settlement terminals
(`EndedCancelled`, `EndedError`) still arrive as `GameStatus`.

### `GameSettled` (all settlements)

Every off-chain `AcceptSettlement` and every on-chain settled outcome (#1–#11
in the [settlement glossary](NAMING_AUDIT.md#settlement-glossary-ux)) emits:

```text
GameSettled { id, outcome: SettlementOutcome, our_share, coin_id? }
```

`outcome` is snake_case on the wire (`accept_settlement`, `settled_cleanly`,
`opponent_timed_out`, `forfeited_skipped_reveal`, …). `our_share` is always
present, including `0`.

The host normalizes the payload once into the terminal instance and
`hand-ended` model input. Session banners and game mounts both render that
machine-owned result; there is no second event delivery.

Display labels come from `SETTLEMENT_OUTCOME_LABELS` in
`front-end/src/lib/settlement.ts`.

| Glossary                          | `outcome` (wire)                 | Display label                  |
| --------------------------------- | -------------------------------- | ------------------------------ |
| Off-chain accept                  | `accept_settlement`              | Accepted                       |
| #1 Settled cleanly                | `settled_cleanly`                | Settled cleanly                |
| #2 Opponent timed out             | `opponent_timed_out`             | Opponent timed out             |
| #3 Forfeited skipped reveal       | `forfeited_skipped_reveal`       | Forfeited                      |
| #4 Lost                          | `lost`                           | Lost                           |
| #5 Forfeited we accepted          | `forfeited_we_accepted`          | Forfeited                      |
| #6 We accepted                    | `we_accepted`                    | Accepted                       |
| #7 Attempt to move failed         | `attempt_to_move_failed`         | Attempt to move failed         |
| #8 Timed out waiting for our move | `timed_out_waiting_for_our_move` | Timed out waiting for our move |
| #9 Slashed opponent               | `slashed_opponent`               | Slashed opponent               |
| #10 Opponent slashed us           | `opponent_slashed_us`            | Opponent slashed us            |
| #11 Opponent cheated              | `opponent_cheated`               | Opponent cheated               |

**Fold** is not a protocol or session label. Space Poker may show a Fold button
that calls `accept_settlement`; settlement still notifies via `GameSettled`.

**Timeout** in user-facing copy is reserved for true clock stories: referee
timelock, the on-chain **timeout claim** mechanism, `opponent_timed_out`, and
`timed_out_waiting_for_our_move` — not for intentional accepts or forfeits.

### On-chain trigger map (mechanism → outcome)

The Rust backend chooses `outcome` from on-chain context. This replaces the
old five-case Forfeit / Claim / Terminal / Fold / Move-too-late table:

| Case                             | Trigger (our turn unless noted)                     | `GameSettled.outcome`                                           |
| -------------------------------- | --------------------------------------------------- | --------------------------------------------------------------- |
| Voluntary off-chain accept       | `AcceptSettlement` batch ack or receive             | `accept_settlement`                                             |
| Terminal clean close             | Game already over; timeout claim pays us            | `settled_cleanly`                                               |
| Opponent timeout path            | Opponent's turn; their timeout claim confirms       | `opponent_timed_out`                                            |
| Skip losing reveal/move          | Our computed move would give opponent 100%          | `forfeited_skipped_reveal`                                      |
| Opponent terminal at 0%          | Their terminal move completed the game and left us at 0% | `lost`                                                       |
| Accept at 0%                     | Explicit `AcceptSettlement` while share == 0        | `forfeited_we_accepted`                                         |
| Intentional accept / auto-accept | Share > 0; timeout claim pays us                    | `we_accepted`                                                   |
| Move too late                    | Pending move overtaken by opponent timeout claim    | `attempt_to_move_failed`                                        |
| Clock expired, no move           | We never chose a move                               | `timed_out_waiting_for_our_move`                                |
| Slash / cheat                    | Illegal-move dispute resolved on-chain              | `slashed_opponent` / `opponent_slashed_us` / `opponent_cheated` |

Auto-accept (terminal game or `our_share == game_amount`) queues
`AcceptSettlement` and eventually settles as `we_accepted` or `settled_cleanly`
when the timeout claim confirms. See `ON_CHAIN.md` for mechanism details.

### Other terminal notifications

| Notification        | Wire shape                                                           | When                                                     |
| ------------------- | -------------------------------------------------------------------- | -------------------------------------------------------- |
| InsufficientBalance | `InsufficientBalance { id, our_balance_short, their_balance_short }` | Group accept attempted with insufficient aggregate funds |
| EndedCancelled      | `GameStatus { status: EndedCancelled, ... }`                         | In-flight accept lost during stale unroll                |
| GameError           | `GameStatus { status: EndedError, reason }`                          | Unrecoverable game-level issue                           |

`EndedError` covers situations that "should never happen" under normal
operation but _can_ happen if, for example, a trusted full node sends
fabricated data (bogus puzzle solutions, impossible mover shares, missing
coins, etc.). The system must handle these gracefully — emitting a
`GameStatus { status: EndedError, ... }` notification and continuing — rather
than panicking or crashing.
Any code path processing data from the blockchain or the peer should treat
unexpected values as `EndedError` (or a direct error variant where
appropriate), never an `assert!` or `unwrap()`.

---

## Key Invariants

The system enforces notification lifecycle invariants, checked per-player
independently (the two sides may see slightly different views). All invariants
hold even through `Failed` — when the channel enters `Failed` state, cleanup
notifications (`ProposalCancelled` for pending proposals, `GameError` for
live games) are emitted before the terminal `ChannelStatus`, ensuring every
open item is explicitly resolved.

### Local actions are advisory

Calling `propose_games`, `accept_proposal`, or `cancel_proposal` queues an
intent. The potato protocol resolves it when the potato is held and the queue
is drained. The notification stream — not the API call — is the source of
truth. One proposal call represents one factory-derived group and the receiver
gets one `ProposalMade` with ordered IDs. Accept and cancel expand from any
member ID to the whole group. Proposing comes with a liveness guarantee (every
produced game ID will resolve); accepting and cancelling do not (the intent may
silently evaporate if the proposal was already resolved by the time the queue
is drained).

### Rule A — Proposal lifecycle

Every group-start event — a `propose_games` call (proposer side) or the single
`ProposalMade` notification (receiver side) — covers the ordered IDs returned
by the deterministic factory. The group yields exactly one
`ProposalAcceptedGroup` containing every member in order, or cancellation for
all members; acceptance and cancellation are all-or-none. The
`cancel_all_proposals()` call
on every exit path (go-on-chain, clean shutdown, channel error) is the catch-all
that ensures no member is left unresolved. Enforced by the simulation loop's
post-test assertion.

### Atomic proposal-group invariant

Proposal creation derives all member economics atomically but does not require
the hand to be currently fundable. Acceptance checks the aggregate sender and
receiver contributions before accepting any member. A peer must place every
member acceptance in the same batch; partial acceptance rejects the batch.
Cancellation likewise expands to the complete group. Consequently the UI must
never model a factory group as partly pending, partly live, or partly cancelled.
The normalized proposal-group record retains each ordered group as a distinct
atomic unit through the single `ProposalAcceptedGroup`. If aggregate preflight
emits `InsufficientBalance`, no acceptance notification is emitted and the host
removes every member from active/current-hand presentation atomically. It must
not create a fake accepted hand from the failed request.

### Rule B — Game lifecycle (bijection)

Expand each `ProposalAcceptedGroup.members` entry conceptually by member ID.
There is a one-to-one correspondence between those accepted members and
terminal game notifications per player. Every accepted member has exactly one
terminal (`GameSettled`, `EndedCancelled`, or `EndedError`), and every such
terminal has a preceding accepted-group member. `InsufficientBalance` is a
failed group acceptance, not a terminal for a live member. Enforced by the
simulation loop's post-test assertion.

### Additional invariants

3. **`GameOnChain` invariant.** Every `GameOnChain` notification references a
   game that appears in a preceding `ProposalAcceptedGroup` in the same player's
   notification stream. A cancelled or never-accepted game must never produce
   `GameOnChain`. Enforced by the simulation loop's post-test assertion.
4. **First post-unroll status classification.** For each game that is still
   live when `ChannelStatus::Unrolling` is first observed, the first subsequent
   terminal or on-chain-turn notification for that game must classify it into a
   valid unroll-resolution bucket: `GameSettled`, `GameStatus` with
   `OnChainMyTurn`, `OnChainTheirTurn`, `Replaying`, `EndedCancelled`, or
   `EndedError`. `PlayingMove` is excluded from this classification because it
   is a later transient status emitted only after a manual on-chain move is
   submitted.
5. **`PlayingMove` ordering.** The host processes watched-coin deltas, transport
   effects, and transaction submissions before delivering the manual move's
   `PlayingMove`. In the browser this means the spend has reached the serialized
   wallet RPC lane, not that the RPC succeeded or the chain confirmed it. In the
   simulator the same synchronous boundary has already pushed it into the host
   mempool. It is followed by `GameStatus { status: OnChainTheirTurn, other_params:
{ moved_by_us: true } }` for the same game, unless the channel terminates
   first. It is distinct from `Replaying`, which classifies a cached off-chain
   redo action being replayed on-chain.
6. **Channel state monotonicity.** `ChannelStatus` values are serialized to the
   frontend by name; the numeric ordinals here are an internal test ordering,
   not wire codes. They must never decrease:
   `Handshaking/WaitingForHeightToOffer/WaitingForHeightToAccept(0) <
OurWalletMakingOffer/OurWalletMakingOfferAcceptance(1) < OfferSent(2) <
TransactionPending(3) < Active(4) <
ShuttingDown/GoingOnChain(5) < ShutdownTransactionPending/Unrolling(6) <
ResolvedClean/ResolvedUnrolled/ResolvedStale/Failed(7)`. `Active` may repeat
   at the same ordinal for balance updates, and winding-down states at ordinals
   5 and 6 may repeat as shutdown/on-chain details are refined. Enforced by the
   simulation loop's post-test assertion.

---

## UI Notification Queues

The frontend organizes user-facing notifications into two scoped FIFO queues,
each rendering only its front item. Dismissing a notification reveals the next
one in line. Both queues are non-modal — the user can interact with the UI
underneath a visible notification.

### Channel-Scoped Queue

Displayed at `z-50`, bounded to the full session area. Covers infrastructure-
level events: channel state highlights, session termination, WASM action
failures, and general errors.

| `kind`          | Source                                                     | Behavior                                                                                                                                                           |
| --------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `channel-state` | `ChannelStatus` in `ATTENTION_STATES`                      | **Replaceable slot**: a new channel-state entry replaces any prior undismissed channel-state entry rather than stacking. Always floats to position 0 in the queue. |
| `session-over`  | Balance exhausted (cooperative shutdown)                   | Queued as a normal FIFO entry.                                                                                                                                     |
| `action-failed` | `ActionFailed` notification (WASM `Err`)                   | Also logged to diagnostics.                                                                                                                                        |
| `infra-error`   | `ReceiveError`, tx submit failures, general `error` events | Catch-all for infrastructure errors.                                                                                                                               |

### Game-Scoped Queue

Displayed at `z-40`, bounded to the game area. Covers in-game and between-hand
events.

| `kind`              | Source                                     | Behavior                                                                       |
| ------------------- | ------------------------------------------ | ------------------------------------------------------------------------------ |
| `proposal-rejected` | `ProposalCancelled` with `CancelledByPeer` | Peer-side cancellation notice; cleared when a `ProposalAcceptedGroup` arrives. |
| `insufficient-bal`  | `InsufficientBalance` notification         | Game could not start due to balance.                                           |

### Data Model

Each notification carries an `id` (unique integer), `kind`, `title`, `message`,
and an optional `channel-state` payload. Queues are persisted to `SessionSave`
(without non-serializable payloads) and restored on reload.

### Overlay Behavior

Both overlays share a unified `NotificationOverlay` component that:

- Uses `useDragControls` with drag confined to the `CardHeader` (the drag
  handle), leaving the content area free for text selection.
- Applies `select-text cursor-text` CSS classes on content so the user can
  select and copy notification text.
- Has no backdrop/scrim — the UI underneath remains fully interactive.
- Renders based on the `kind` of the front notification: channel-state shows
  coin info, errors use `<pre>` for copyable stack traces, and notices show
  centered text.

### Resilience

The WASM event drain (`scheduleDrain`) wraps each `dispatchEvent` call in a
`try/catch` so a single bad event cannot permanently halt the drain loop.
Caught errors are emitted as `infra-error` notifications and draining
continues. Similarly, `deliverSingleMessage` wraps the WASM
`deliver_message` call so a peer-message panic emits an error rather than
crashing the app. A React `ErrorBoundary` wraps the `GameSession` component
so a render crash shows a recovery message instead of white-screening.

---

## Additional Design Rules

These are not lifecycle invariants but important rules enforced in the code:

- **Accept only on our turn.** Calling `accept_settlement()` when it is not our
  turn is an assert failure. `AcceptSettlement` is an alternative to moving when
  we choose to settle at the current `mover_share`.
- **Accepted + opponent move is an untested path.** Since accept_settlement only
  happens on our turn, and only the mover can advance a game coin, the opponent
  cannot move on a coin where we already accepted. The `accept_proposal_and_move` API exists but has
  not been tested end-to-end; Calpoker's move direction may prevent it from
  triggering in practice.
- **No phantom game-map entries.** During the on-chain transition,
  `finish_on_chain_transition` filters out both our and the opponent's reward
  puzzle hashes from the created-coins list before calling
  `set_state_for_coins`. This prevents reward coins from being incorrectly
  matched to live games and generating spurious terminal notifications.

**Key code:** `src/session_phases/effects.rs`,
`src/session_phases/handler_base.rs` (`emit_failure_cleanup`)

---

## Game Model Input Mapping

`sessionMachineNotifications.ts` normalizes raw notifications directly into
the machine-owned hand model. Game hooks never see raw notifications or an
observable. The package input list is:

- `hand-started`
- `opponent-moved`
- `game-message`
- `move-rejected`
- `hand-ended`

`ActionFailed`, JavaScript command exceptions, proposal/session lifecycle, and
infrastructure failures remain host-owned and use the shared notification
queues.

Settlement label helpers live in `front-end/src/lib/settlement.ts`
(`settlementLabel`, `isForfeitOutcome`, game-specific copy helpers).

**Key code:** `front-end/src/lib/session/sessionMachineNotifications.ts`,
`front-end/src/lib/session/sessionMachineGame.ts`,
`front-end/src/lib/session/gameSessionEvents.ts`, and
`front-end/src/lib/settlement.ts`
