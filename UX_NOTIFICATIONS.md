# UX Notifications

For the conceptual overview, see `OVERVIEW.md`. For the frontend component
hierarchy, notification routing, hub relay protocol, session persistence,
peer message reliability, and reconnect reconciliation, see
`FRONTEND_ARCHITECTURE.md`. For the authoritative settlement outcome glossary
(off-chain accept + on-chain #1–#11), see
[`NAMING_AUDIT.md` — Settlement glossary](NAMING_AUDIT.md#settlement-glossary-ux). The frontend supports full page reload — game state
is continuously saved to localStorage and restored on reload with a fresh RNG
seed.

The UI layer receives events via the `ToLocalUI` trait callbacks and
`GameNotification` variants (delivered through `game_notification`).

**Important naming note:** this document sometimes uses conceptual UX labels
like "OpponentMoved" for readability. The canonical wire model in Rust is
`GameNotification` plus `GameStatusKind` for in-play status, and
`GameNotification::GameSettled` for all settled outcomes:

- dedicated variants: `ProposalMade`, `ProposalAccepted`,
  `ProposalCancelled`, `InsufficientBalance`, `MoveRejected`, `ActionFailed`,
  `ChannelStatus`
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
- [Dashboard Status Labels](#dashboard-status-labels)
- [Gameplay Notifications](#gameplay-notifications)
- [Proposal Notifications](#proposal-notifications)
- [Game Outcome Notifications (Terminal)](#game-outcome-notifications-terminal)
- [Key Invariants](#key-invariants)
- [Additional Design Rules](#additional-design-rules)

---

## WASM Event FIFO and Async Drain

Every communication produced by the Rust game session starts as a `GameSessionEvent` in
the game session's FIFO event queue. The `TransactionManager` drains that queue and
intercepts blockchain bookkeeping events before they reach JavaScript:
`OutboundTransaction` entries are captured for `drain_submissions()`, and
`WatchCoin` entries update the manager's watched-coin set and are returned as
`result.watchCoins` polling deltas. The remaining events — wallet requests
(`NeedCoinSpend`, `NeedLauncherCoin`), outbound peer messages, notifications,
logs, receive errors, and puzzle/solution requests — are returned to JS as
`result.events`.

Flow:

1. Rust handlers push all `GameSessionEvent`s onto the game-session queue.
2. `TransactionManager::flush_and_collect` drains that queue, intercepting
   `OutboundTransaction` and `WatchCoin` while preserving order for the events
   still delivered to JS.
3. `processResult()` applies `result.watchCoins` to the poller, appends
   `result.events` to the JS `eventQueue`, calls `drain_submissions()` for
   intercepted transaction submissions, and calls `scheduleDrain()`.
4. `scheduleDrain()` is a no-op if a drain is already scheduled or the queue
   is empty. Otherwise it schedules a `setTimeout(0)` callback that dispatches
   **one** event, saves state, and calls `scheduleDrain()` again for the next.

Each event is dispatched exactly once by `dispatchEvent()`, in a separate
macrotask. Event types and their handlers:

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

Why async (one event per macrotask):

- Some event handlers trigger additional WASM calls that produce more
  `GameSessionEvent`s (for example, a notification handler that calls
  `proposeGame`, which returns new events). Those events are appended to
  the queue and drained in subsequent macrotasks.
- Notification handlers in React check React state (e.g.
  `gameConnectionState`). React `setState` calls don't flush until the
  call stack unwinds. If multiple notifications were dispatched in a single
  synchronous loop, handlers for events 2..N would see stale React state
  from before event 1's `setState` took effect.
- By yielding to the macrotask queue between events, React flushes state
  updates before the next event handler runs. This means notification
  handlers can rely on React state being current — no special rules about
  using refs instead of state for guards.
- Ordering is preserved: events from the first WASM call are queued first;
  events produced re-entrantly (from a WASM call inside a handler) are
  appended after. The queue drains in FIFO order.

This makes frontend event processing deterministic and allows notification
handlers to use ordinary React state without worrying about synchronous
batching artifacts.

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

| `ChannelStatus`        | When                                           | Meaning                                                                                                                                       |
| --------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Handshaking`         | Handshake in progress                          | Channel negotiation messages are being exchanged (steps A–D)                                                                                  |
| `WaitingForHeightToOffer` | Handshake waiting on block height gate | Wallet spend inputs are ready, but the protocol is waiting for the configured height to submit the offer                                      |
| `WaitingForHeightToAccept` | Receiver waiting on block height gate | Receiver is waiting for the configured height gate before accepting/submitting the channel transaction                                        |
| `OurWalletMakingOffer` | Initiator waiting on local wallet | Our wallet is building the channel-creation offer spend                                                                                        |
| `OurWalletMakingOfferAcceptance` | Receiver waiting on local wallet | Our wallet is finishing/funding the channel-creation acceptance spend                                                                          |
| `OfferSent`           | Our half of the spend sent to peer             | We have sent our offer/spend to the other side; they could create the channel coin                                                            |
| `TransactionPending`  | Full spend bundle assembled                    | We have the complete channel-creation transaction in hand, waiting for on-chain confirmation                                                  |
| `Active`              | Channel operational                            | Channel is live and games can be played. Emitted repeatedly as balances change (potato firings). Includes `our_balance`, `their_balance`, `game_allocated`, and `coin` fields. |
| `ShuttingDown`    | Clean shutdown initiated                       | Cooperative channel closure has been initiated (advisory protocol, not yet on-chain)                                                          |
| `ShutdownTransactionPending` | Clean shutdown spend assembled | A clean shutdown transaction has been formed and is pending confirmation                                                                       |
| `GoingOnChain` | Explicit on-chain transition initiated | Local side has initiated transition from off-chain potato flow to on-chain resolution                                                         |
| `Unrolling`       | Unroll detected on-chain                       | The channel coin has been spent to an unroll coin (by either player). `advisory` describes the reason if known.                                |
| `ResolvedClean`   | Clean shutdown completed                       | Channel closed cooperatively; balances reflect the final split                                                                                |
| `ResolvedUnrolled`| Unroll completed (non-stale)                   | The unroll was at the latest state; per-game `GameSettled` / on-chain turn status notifications follow separately |
| `ResolvedStale`   | Stale unroll completed                         | The opponent tried to unroll with an older state; per-game outcomes follow separately                                                         |
| `Failed`          | Unrecoverable error                            | The channel or unroll coin is in an unrecoverable state; `advisory` has the reason                                                            |

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
notification type for its persistent channel state display.

Monotonicity applies across all three lenses:

- **Handler lens:** phase ownership moves forward through handler replacement;
  handlers may branch by path, but do not rewind to earlier handshake phases.
- **Notification lens:** `ChannelStatus` and `GameStatusKind` progress forward in
  lifecycle terms (with same-level repeats allowed for updates/advisory changes).
- **On-chain lifecycle lens:** coin progression is forward-only
  (`created -> unrolling -> resolved` for channels, and
  `off-chain -> on-chain loop -> terminal` for games).

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

| Hand label | Meaning |
| --- | --- |
| `No hand` | No accepted hand is currently active or being displayed. |
| `Active` | The channel is going on-chain/unrolling before a concrete game coin is being tracked. |
| `Your turn` | A game coin is on-chain and the protocol says our side is the mover. |
| `Their turn` | A game coin is on-chain and the protocol says the opponent is the mover. |
| `Playing move` | Our on-chain move is being submitted, confirmed, or replayed as part of the on-chain resolution path. |
| `Ended` | A `GameSettled` or non-settlement terminal (`EndedCancelled`, `EndedError`) has been observed. The collapsed bar adds a short hand detail from the settlement glossary label when useful. |

Terminal hand details are derived from `GameSettled.outcome` via
`SETTLEMENT_OUTCOME_LABELS` in `front-end/src/lib/settlement.ts` (see
[Settlement glossary](NAMING_AUDIT.md#settlement-glossary-ux)). Full raw
details remain available in the expanded dashboard rows.

| Detail (examples) | Meaning |
| --- | --- |
| `Accepted` | Off-chain `accept_settlement` or on-chain `we_accepted` |
| `Settled cleanly` | On-chain close from an already-terminal state |
| `Opponent timed out` | Opponent's timeout path; intent unknown |
| `Forfeited` | Our share is 0 and we stopped watching (#3–#5) |
| `Attempt to move failed` | Our move did not land before the opponent's timeout claim |
| `Timed out waiting for our move` | Our turn; we never chose a move before the clock expired |
| `Slashed opponent` / `Opponent slashed us` / `Opponent cheated` | On-chain dispute settled outcomes |

There is no session-level **Folded** label. Poker UIs may still say **Fold**
locally when calling `accept_settlement`.

Forfeits and routine clean settlements are usually bar-only (no pop-up).
Adverse settlements (`isErrorSettlementOutcome`) may also enqueue `game-terminal`
notifications.

---

## Gameplay Notifications

These fire during active gameplay (after a game proposal has been accepted).

| Conceptual UX label | Actual wire shape | When | Meaning |
| --- | --- | --- | --- |
| OpponentMoved | `GameStatus { status: MyTurn, other_params: { readable, mover_share } }` | Opponent made a move | It is now our turn; `mover_share` is our share on timeout from the opponent's move |
| OpponentPlayedIllegalMove | `GameStatus { status: IllegalMoveDetected, ... }` | Opponent's on-chain move detected as illegal | Emitted before slash resolution |
| GameMessage | `GameStatus { status: MyTurn/TheirTurn, other_params: { readable } }` | Informational game message | Decoded advisory/readable message payload |
| MoveRejected | `MoveRejected { id, tag, message }` | A local my-turn handler rejects user input | Recoverable game-scoped rejection; no peer batch is sent for the rejected move |
| GameOnChain | `GameStatus { status: OnChainMyTurn / OnChainTheirTurn / Replaying, coin_id }` | Game transitions on-chain | On-chain phase begins for this game. `Replaying` means a cached off-chain send-move exists for this game id and will be spent as an on-chain redo (same criterion as `take_cached_move_for_game`). |
| WeMoved | `GameStatus { status: OnChainTheirTurn, other_params: { moved_by_us: true }, coin_id }` | Our on-chain move confirms | New game coin is tracked in `coin_id` |

---

## Proposal Notifications


| Notification                                               | When                                 | Meaning                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `ProposalMade { id, group_ids, my_contribution, their_contribution, timeout, game_type, ... }` | Atomic proposal group received from opponent | Fires exactly once for the receiver. `id` is the first factory-produced game ID; `group_ids` is always the full ordered member list (singleton ⇒ `[id]`). Contributions are aggregate totals in the receiver's local perspective. |
| `ProposalAccepted { id, amount }`                          | Proposal accepted by either side     | The game is now live; `amount` is that game's total pot                                                              |
| `ProposalCancelled { id, reason }`                         | Proposal cancelled or invalidated    | The proposal was cancelled explicitly, or automatically due to going on-chain                                        |

### Cancellation Reasons (`CancelReason`)

`ProposalCancelled` carries a `reason` field indicating why the cancellation
happened. The reason determines both the frontend's behavior and whether the
user is notified.

| `CancelReason` | Emitted when | Frontend behavior |
|---|---|---|
| `SupersededByIncoming` | A peer proposal arrived in a batch while our own proposal was queued locally. WASM removes our queued proposal because the state it was built against is now stale. | **Local/silent.** Terms stashed in `pendingRetryTermsRef` for automatic re-submission (see [Proposal Collision Handling](GAME_LIFECYCLE.md#proposal-collision-handling)). |
| `PeerProposalPending` | JS called `propose_game` while an unresolved peer proposal already exists in `proposed_games`. WASM rejects immediately to avoid silently cancelling the peer's proposal as a side effect. | **Local/silent.** Same retry stash as `SupersededByIncoming`. |
| `GameActive` | Reserved for future use. The JS-side guard prevents this from occurring in practice. | **Local/silent.** Clears retry state. |
| `CancelledByPeer` | The peer sent `BatchAction::CancelProposal` for our proposal. This usually means the peer rejected it, but the same protocol message is also used as the peer-side follow-up for failed accept attempts such as insufficient balance (see [Race Conditions in Proposal Lifecycle](GAME_LIFECYCLE.md#race-conditions-in-proposal-lifecycle)). | **User-facing notice:** the proposal did not proceed on the peer side. |
| `CancelledByUs` | We explicitly cancelled the peer's proposal (via `cancel_proposal`). | **Silent.** We initiated the cancellation; nothing to tell the user. |
| `CleanShutdown` | The channel is shutting down cooperatively. All outstanding proposals are cancelled. | **Silent.** The shutdown UI handles this. |
| `WentOnChain` | The channel transitioned to on-chain resolution. Proposals not reflected in the unroll are cancelled. | **Silent.** The on-chain UI handles this. |
| `ChannelError` | An unrecoverable channel error occurred. All proposals are cancelled as cleanup. | **Silent.** The error UI handles this. |

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

**Dual delivery:** the same payload drives (1) the session banner / dashboard
label and (2) the active reference-game UI via `GameplayEvent.Settled`.
Neither sink may invent a parallel event shape or skip "boring" outcomes.

Display labels come from `SETTLEMENT_OUTCOME_LABELS` in
`front-end/src/lib/settlement.ts`.

| Glossary | `outcome` (wire) | Display label |
| --- | --- | --- |
| Off-chain accept | `accept_settlement` | Accepted |
| #1 Settled cleanly | `settled_cleanly` | Settled cleanly |
| #2 Opponent timed out | `opponent_timed_out` | Opponent timed out |
| #3 Forfeited skipped reveal | `forfeited_skipped_reveal` | Forfeited |
| #4 Forfeited opponent won | `forfeited_opponent_won` | Forfeited |
| #5 Forfeited we accepted | `forfeited_we_accepted` | Forfeited |
| #6 We accepted | `we_accepted` | Accepted |
| #7 Attempt to move failed | `attempt_to_move_failed` | Attempt to move failed |
| #8 Timed out waiting for our move | `timed_out_waiting_for_our_move` | Timed out waiting for our move |
| #9 Slashed opponent | `slashed_opponent` | Slashed opponent |
| #10 Opponent slashed us | `opponent_slashed_us` | Opponent slashed us |
| #11 Opponent cheated | `opponent_cheated` | Opponent cheated |

**Fold** is not a protocol or session label. Space Poker may show a Fold button
that calls `accept_settlement`; settlement still notifies via `GameSettled`.

**Timeout** in user-facing copy is reserved for true clock stories: referee
timelock, the on-chain **timeout claim** mechanism, `opponent_timed_out`, and
`timed_out_waiting_for_our_move` — not for intentional accepts or forfeits.

### On-chain trigger map (mechanism → outcome)

The Rust backend chooses `outcome` from on-chain context. This replaces the
old five-case Forfeit / Claim / Terminal / Fold / Move-too-late table:

| Case | Trigger (our turn unless noted) | `GameSettled.outcome` |
| --- | --- | --- |
| Voluntary off-chain accept | `AcceptSettlement` batch ack or receive | `accept_settlement` |
| Terminal clean close | Game already over; timeout claim pays us | `settled_cleanly` |
| Opponent timeout path | Opponent's turn; their timeout claim confirms | `opponent_timed_out` |
| Skip losing reveal/move | Our computed move would give opponent 100% | `forfeited_skipped_reveal` |
| Opponent terminal at 0% | Their terminal move left us at 0% (opponent's turn) | `forfeited_opponent_won` |
| Accept at 0% | Explicit `AcceptSettlement` while share == 0 | `forfeited_we_accepted` |
| Intentional accept / auto-accept | Share > 0; timeout claim pays us | `we_accepted` |
| Move too late | Pending move overtaken by opponent timeout claim | `attempt_to_move_failed` |
| Clock expired, no move | We never chose a move | `timed_out_waiting_for_our_move` |
| Slash / cheat | Illegal-move dispute resolved on-chain | `slashed_opponent` / `opponent_slashed_us` / `opponent_cheated` |

Auto-accept (terminal game or `our_share == game_amount`) queues
`AcceptSettlement` and eventually settles as `we_accepted` or `settled_cleanly`
when the timeout claim confirms. See `ON_CHAIN.md` for mechanism details.

### Other terminal notifications

| Notification | Wire shape | When |
| --- | --- | --- |
| InsufficientBalance | `InsufficientBalance { id, our_balance_short, their_balance_short }` | Group accept attempted with insufficient aggregate funds |
| EndedCancelled | `GameStatus { status: EndedCancelled, ... }` | In-flight accept lost during stale unroll |
| GameError | `GameStatus { status: EndedError, reason }` | Unrecoverable game-level issue |

`EndedError` covers situations that "should never happen" under normal
operation but *can* happen if, for example, a trusted full node sends
fabricated data (bogus puzzle solutions, impossible mover shares, missing
coins, etc.).  The system must handle these gracefully — emitting a
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

Calling `propose_game`, `accept_proposal`, or `cancel_proposal` queues an
intent. The potato protocol resolves it when the potato is held and the queue
is drained. The notification stream — not the API call — is the source of
truth. One proposal call represents one factory-derived group and the receiver
gets one `ProposalMade` with ordered IDs. Accept and cancel expand from any
member ID to the whole group. Proposing comes with a liveness guarantee (every
produced game ID will resolve); accepting and cancelling do not (the intent may
silently evaporate if the proposal was already resolved by the time the queue
is drained).

### Rule A — Proposal lifecycle

Every group-start event — a `propose_game` call (proposer side) or the single
`ProposalMade` notification (receiver side) — covers the ordered IDs returned
by the deterministic factory. Each member ID yields exactly one
`ProposalAccepted` or `ProposalCancelled` on that player's side, but group
acceptance and cancellation are all-or-none. The `cancel_all_proposals()` call
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

### Rule B — Game lifecycle (bijection)

There is a one-to-one correspondence between `ProposalAccepted` notifications
and terminal game notifications per player per game ID. Every
`ProposalAccepted` has exactly one terminal (`GameSettled`, `InsufficientBalance`,
`EndedCancelled`, or `EndedError`), and every terminal has a preceding
`ProposalAccepted`. Enforced by the simulation loop's post-test assertion.

### Additional invariants

3. **`GameOnChain` invariant.** Every `GameOnChain` notification references a
   game that has a preceding `ProposalAccepted` in the same player's
   notification stream. A cancelled or never-accepted game must never produce
   `GameOnChain`. Enforced by the simulation loop's post-test assertion.
4. **First post-unroll status classification.** For each game that is still
   live when `ChannelStatus::Unrolling` is first observed, the first subsequent
   terminal or on-chain-turn notification for that game must classify it into a
   valid unroll-resolution bucket: `GameSettled`, `GameStatus` with
   `OnChainMyTurn`, `OnChainTheirTurn`, `Replaying`, `EndedCancelled`, or
   `EndedError`.
5. **Channel state monotonicity.** `ChannelStatus` values are serialized to the
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

| `kind` | Source | Behavior |
|---|---|---|
| `channel-state` | `ChannelStatus` in `ATTENTION_STATES` | **Replaceable slot**: a new channel-state entry replaces any prior undismissed channel-state entry rather than stacking. Always floats to position 0 in the queue. |
| `session-over` | Balance exhausted (cooperative shutdown) | Queued as a normal FIFO entry. |
| `action-failed` | `ActionFailed` notification (WASM `Err`) | Also logged to diagnostics. |
| `infra-error` | `ReceiveError`, tx submit failures, general `error` events | Catch-all for infrastructure errors. |

### Game-Scoped Queue

Displayed at `z-40`, bounded to the game area. Covers in-game and between-hand
events.

| `kind` | Source | Behavior |
|---|---|---|
| `game-terminal` | Adverse `GameSettled` outcomes (`isErrorSettlementOutcome`), except bar-only forfeits | Shows reward amount and coin info. |
| `proposal-rejected` | `ProposalCancelled` with `CancelledByPeer` | Peer-side cancellation notice; cleared when a `ProposalAccepted` arrives. |
| `insufficient-bal` | `InsufficientBalance` notification | Game could not start due to balance. |

### Data Model

Each notification carries an `id` (unique integer), `kind`, `title`, `message`,
and an optional `payload` (typed for `channel-state` and `game-terminal`
entries). Queues are persisted to `SessionSave` (without non-serializable
payloads) and restored on reload.

### Overlay Behavior

Both overlays share a unified `NotificationOverlay` component that:

- Uses `useDragControls` with drag confined to the `CardHeader` (the drag
  handle), leaving the content area free for text selection.
- Applies `select-text cursor-text` CSS classes on content so the user can
  select and copy notification text.
- Has no backdrop/scrim — the UI underneath remains fully interactive.
- Renders based on the `kind` of the front notification: channel-state shows
  coin info, game-terminal shows reward details, errors use `<pre>` for
  copyable stack traces, and notices show centered text.

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

## GameplayEvent Mapping

The `useGameSession` hook translates raw `WasmNotification` events into
game-agnostic `GameplayEvent` variants before forwarding them to
game-specific hooks (`useCalpokerHand`, `useSpacepokerHand`, `useKrunkHand`).
Game hooks never see raw notifications; they receive one of:

| Variant | Shape | When |
|---------|-------|------|
| `OpponentMoved` | `{ readable, gameId?, moverShare: string }` | Remapped from `GameStatus` with `other_params.readable` and `other_params.mover_share`. `moverShare` is our share after the opponent's move (including on timeout from that move). |
| `GameMessage` | `{ readable, gameId? }` | Remapped from `GameStatus` with readable but no `mover_share` (advisory / out-of-band message). |
| `ProposalAccepted` | `{ id }` | A new game is starting |
| `Settled` | `{ gameId, outcome, ourShare }` | From `GameSettled`; same payload drives session banner labels via `terminalInfoFromGameSettled` |
| `MoveRejected` | `{ gameId: string, tag: string, message: string }` | Recoverable local handler rejection routed only to the matching game hook |
| `GameError` | `{ gameId, reason }` | `EndedCancelled`, `EndedError`, `InsufficientBalance`, or unknown settlement outcome |

Settlement label helpers live in `front-end/src/lib/settlement.ts`
(`settlementLabel`, `isForfeitOutcome`, game-specific copy helpers).

Non-terminal move/status notifications are remapped by
`gameplayEventsForGameStatus` into the `OpponentMoved` / `GameMessage` shapes
above (including `moverShare` on `OpponentMoved`).

**Key code:** `front-end/src/hooks/useGameSession.ts` (`terminalInfoFromGameSettled`,
`settledEventForInfo`, `gameplayEventsForGameStatus`),
`front-end/src/lib/settlement.ts`
