# UX Notifications

For the conceptual overview, see `OVERVIEW.md`. For the frontend component
hierarchy, notification routing, tracker relay protocol, session persistence,
peer message reliability, and reconnect reconciliation, see
`FRONTEND_ARCHITECTURE.md`. The frontend supports full page reload — game state
is continuously saved to localStorage and restored on reload with a fresh RNG
seed.

The UI layer receives events via the `ToLocalUI` trait callbacks and
`GameNotification` variants (delivered through `game_notification`).

**Important naming note:** this document sometimes uses conceptual UX labels
like "OpponentMoved" or "WeTimedOut" for readability. The canonical wire model
in Rust is `GameNotification` plus `GameStatusKind`:

- dedicated variants: `ProposalMade`, `ProposalAccepted`,
  `ProposalCancelled`, `InsufficientBalance`, `ActionFailed`, `ChannelStatus`
- gameplay/terminal lifecycle: `GameNotification::GameStatus { status:
  GameStatusKind, ... }`

So when you see a conceptual label below, map it to the corresponding
`GameStatusKind` value.

There is also a separate protocol view that is useful for reasoning about
on-chain behavior:

- channel lifecycle: `created -> unrolling -> resolved`
- per-game lifecycle: `off-chain -> on-chain move loop (my/their turn) -> terminal`

Those are conceptual progression models; the concrete emitted values are still
`ChannelStatus { state: ChannelState, ... }` and
`GameStatus { status: GameStatusKind, ... }`.

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

Every communication produced by the Rust cradle starts as a `CradleEvent` in
the cradle's FIFO event queue. The `TransactionManager` drains that queue and
intercepts blockchain bookkeeping events before they reach JavaScript:
`OutboundTransaction` entries are captured for `drain_submissions()`, and
`WatchCoin` entries update the manager's watched-coin set exposed through
`get_coins_to_poll()`. The remaining events — wallet requests
(`NeedCoinSpend`, `NeedLauncherCoin`), outbound peer messages, notifications,
logs, receive errors, and puzzle/solution requests — are returned to JS as
`result.events`.

Flow:

1. Rust handlers push all `CradleEvent`s onto the cradle queue.
2. `TransactionManager::flush_and_collect` drains that queue, intercepting
   `OutboundTransaction` and `WatchCoin` while preserving order for the events
   still delivered to JS.
3. `processResult()` appends `result.events` to the JS `eventQueue`, calls
   `drain_submissions()` / `get_coins_to_poll()` for intercepted blockchain
   work, and calls `scheduleDrain()`.
4. `scheduleDrain()` is a no-op if a drain is already scheduled or the queue
   is empty. Otherwise it schedules a `setTimeout(0)` callback that dispatches
   **one** event, saves state, and calls `scheduleDrain()` again for the next.

Each event is dispatched exactly once by `dispatchEvent()`, in a separate
macrotask. Event types and their handlers:

- `OutboundMessage` — send to peer via tracker
- `Notification` — surface game/channel state to the UI
- `ReceiveError` — peer message decode failure
- `CoinSolutionRequest` — fetch puzzle/solution from blockchain
- `Log` — diagnostic output
- `NeedLauncherCoin` — request the wallet to provide the launcher coin
- `NeedCoinSpend` — request the wallet to create and sign a spend bundle

`OutboundTransaction` and `WatchCoin` are intentionally absent from the JS event
list because they are intercepted during manager drain. They still originate as
queued Rust events; they just become manager state/submission buffers before JS
dispatch.

Why async (one event per macrotask):

- Some event handlers trigger additional WASM calls that produce more
  `CradleEvent`s (for example, a notification handler that calls
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
notification containing the current `ChannelState`, balance information, and
an optional `advisory` string for context (e.g. error reason). The
`ChannelState` values are:

`ChannelState` is the notification-level state model exposed to the UI and
tests. It is distinct from peer handler ownership and from the on-chain coin
lifecycle; see [Peer Handlers vs States](OVERVIEW.md#peer-handlers-vs-states)
for how those lenses relate.

| `ChannelState`        | When                                           | Meaning                                                                                                                                       |
| --------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `Handshaking`         | Handshake in progress                          | Channel negotiation messages are being exchanged (steps A–D)                                                                                  |
| `WaitingForHeightToOffer` | Handshake waiting on block height gate | Wallet spend inputs are ready, but the protocol is waiting for the configured height to submit the offer                                      |
| `WaitingForHeightToAccept` | Receiver waiting on block height gate | Receiver is waiting for the configured height gate before accepting/submitting the channel transaction                                        |
| `OfferSent`           | Our half of the spend sent to peer             | We have sent our offer/spend to the other side; they could create the channel coin                                                            |
| `TransactionPending`  | Full spend bundle assembled                    | We have the complete channel-creation transaction in hand, waiting for on-chain confirmation                                                  |
| `Active`              | Channel operational                            | Channel is live and games can be played. Emitted repeatedly as balances change (potato firings). Includes `our_balance`, `their_balance`, `game_allocated`, and `coin` fields. |
| `ShuttingDown`    | Clean shutdown initiated                       | Cooperative channel closure has been initiated (advisory protocol, not yet on-chain)                                                          |
| `ShutdownTransactionPending` | Clean shutdown spend assembled | A clean shutdown transaction has been formed and is pending confirmation                                                                       |
| `GoingOnChain` | Explicit on-chain transition initiated | Local side has initiated transition from off-chain potato flow to on-chain resolution                                                         |
| `Unrolling`       | Unroll detected on-chain                       | The channel coin has been spent to an unroll coin (by either player). `advisory` describes the reason if known.                                |
| `ResolvedClean`   | Clean shutdown completed                       | Channel closed cooperatively; balances reflect the final split                                                                                |
| `ResolvedUnrolled`| Unroll completed (non-stale)                   | The unroll was at the latest state; per-game outcomes (`GameOnChain`, `WeTimedOut`, etc.) follow separately                                   |
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

Each `ChannelStatus` notification is emitted when the `PeerHandler` is
replaced (handler transition) or when the current handler's snapshot changes
(e.g. balance update during `Active`). The frontend uses this single
notification type for its persistent channel state display.

Monotonicity applies across all three lenses:

- **Handler lens:** phase ownership moves forward through handler replacement;
  handlers may branch by path, but do not rewind to earlier handshake phases.
- **Notification lens:** `ChannelState` and `GameStatusKind` progress forward in
  lifecycle terms (with same-level repeats allowed for updates/advisory changes).
- **On-chain lifecycle lens:** coin progression is forward-only
  (`created -> unrolling -> resolved` for channels, and
  `off-chain -> on-chain loop -> terminal` for games).

---

## Dashboard Status Labels

The Game tab dashboard is the persistent user-facing summary. Its collapsed bar
is intentionally calmer than the raw notification stream:

`Channel: <channel status> <channel advisory> Hand: <hand status> <hand detail>`

The channel half summarizes the channel lifecycle. `Unrolling` and
`ResolvedUnrolled` are not separate pop-up-worthy events; the bar is the source
of truth for those states. `Failed` and `ResolvedStale` can still produce
error-style attention because they indicate adverse channel-level outcomes.

The hand half summarizes one accepted hand. It deliberately hides off-chain turn
noise and only becomes turn-specific once a game coin is actually on-chain:

| Hand label | Meaning |
| --- | --- |
| `No hand` | No accepted hand is currently active or being displayed. |
| `Active` | A hand is live off-chain, or the channel is going on-chain/unrolling before a concrete game coin is being tracked. Off-chain `my turn` vs `their turn` is not important enough for the collapsed bar. |
| `Your turn` | A game coin is on-chain and the protocol says our side is the mover. |
| `Their turn` | A game coin is on-chain and the protocol says the opponent is the mover. |
| `Playing move` | Our on-chain move is being submitted, confirmed, or replayed as part of the on-chain resolution path. |
| `Ended` | A terminal `GameStatusKind` has been observed. The collapsed bar may add a short hand detail after `Ended`. |

Terminal hand details are high-level user labels derived from terminal
`GameStatus` metadata. Full raw details remain available in the expanded
dashboard rows.

| Detail | Meaning |
| --- | --- |
| `Forfeited` | The protocol explicitly marked the terminal as `forfeited`. This is a distinct adverse hand outcome, shown in the bar as `Hand: Ended Forfeited`, but it should not also create a pop-up. |
| `Move too late` | Our move or replay did not land before the opponent claimed the timeout. This is not a forfeit; it means the move missed the on-chain timing window. |
| `Timed out` | We timed out in a non-forfeit, non-late-move path. |
| `Opponent timed out` | The opponent timed out in a normal terminal path. This is considered a normal game end and is usually omitted from the collapsed bar detail. |
| `Ended cleanly` | The game result was accepted through normal protocol completion. This is also usually omitted from the collapsed bar detail. |
| Slash / cheat / error labels | Adverse terminal outcomes such as `Slashed opponent`, `Opponent slashed us`, `Opponent cheated`, or `Error`. |

Forfeits, move-too-late, slash, cheat, and game-error details belong to the hand
half of the dashboard, not the channel advisory. Channel advisories are reserved
for channel-level failures or context.

---

## Gameplay Notifications

These fire during active gameplay (after a game proposal has been accepted).

| Conceptual UX label | Actual wire shape | When | Meaning |
| --- | --- | --- | --- |
| OpponentMoved | `GameStatus { status: MyTurn, other_params: { readable, mover_share } }` | Opponent made a move | It is now our turn; `mover_share` is our share on timeout from the opponent's move |
| OpponentPlayedIllegalMove | `GameStatus { status: IllegalMoveDetected, ... }` | Opponent's on-chain move detected as illegal | Emitted before slash resolution |
| GameMessage | `GameStatus { status: MyTurn/TheirTurn, other_params: { readable } }` | Informational game message | Decoded advisory/readable message payload |
| GameOnChain | `GameStatus { status: OnChainMyTurn / OnChainTheirTurn / Replaying, coin_id }` | Game transitions on-chain | On-chain phase begins for this game |
| WeMoved | `GameStatus { status: OnChainTheirTurn, other_params: { moved_by_us: true }, coin_id }` | Our on-chain move confirms | New game coin is tracked in `coin_id` |

---

## Proposal Notifications


| Notification                                               | When                                 | Meaning                                                                                                              |
| ---------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `ProposalMade { id, my_contribution, their_contribution }` | Game proposal received from opponent | A new game has been proposed by the peer. Only fires for the receiver — the proposer does not get this notification. |
| `ProposalAccepted { id }`                                  | Proposal accepted by either side     | The game is now live and play can begin                                                                              |
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

These are the terminal notifications — each signals that a game is finished.
The frontend should treat any of these as the "game ended" signal.


| Conceptual UX label | Actual wire shape | When | Meaning |
| --- | --- | --- | --- |
| InsufficientBalance | `InsufficientBalance { id, our_balance_short, their_balance_short }` | Accept attempted with insufficient funds | Preceded by `ProposalAccepted`; the game is immediately terminated. The peer sees `ProposalCancelled { reason: CancelledByPeer }` as the Rule A follow-up for their proposal. |
| WeTimedOut | `GameStatus { status: EndedWeTimedOut, my_reward, coin_id }` | Game resolved in our favor | Off-chain accept-timeout completion or on-chain timeout/slash resolution path |
| OpponentTimedOut | `GameStatus { status: EndedOpponentTimedOut, my_reward, coin_id }` | Game resolved in opponent's favor | Includes receiving opponent accept-timeout and on-chain opponent-favor outcomes |
| EndedCancelled | `GameStatus { status: EndedCancelled, ... }` | In-flight accept lost during stale unroll | The game was accepted but no moves were made; the unroll predates the acceptance |
| WeSlashedOpponent | `GameStatus { status: EndedWeSlashedOpponent, my_reward, coin_id }` | Slash confirmed in our favor | Opponent's illegal move was proven on-chain |
| OpponentSlashedUs | `GameStatus { status: EndedOpponentSlashedUs, ... }` | Opponent slashed us | Our move was proven illegal on-chain |
| OpponentSuccessfullyCheated | `GameStatus { status: EndedOpponentSuccessfullyCheated, my_reward, coin_id }` | Illegal move timed out before slash | Opponent kept timeout path before we slashed |
| GameError | `GameStatus { status: EndedError, reason }` | Unrecoverable game-level issue | One game reached an error terminal condition |

### Terminal Taxonomy (On-Chain)

On-chain game endings fall into five distinct cases. Each has a different
trigger condition in the Rust backend and a different frontend label:

| Case | Trigger condition | Backend behavior | `GameStatusOtherParams` | Frontend label |
|---|---|---|---|---|
| **Forfeit** | Our turn; our computed move would give `mover_share == game_amount` to the opponent (our post-move share is 0%) | Move not submitted; `EndedWeTimedOut` emitted immediately with `my_reward: 0` | `game_finished: true, forfeited: true` | `Forfeited` (no pop-up) |
| **Claim** | Our turn; `our_share == game_amount` before any move (we already get 100%) | Auto-accept fires; `AcceptTimeout` queued; timeout claim built and submitted | `game_finished: true` | `Ended cleanly` |
| **Terminal** | Our turn; `is_game_over()` and `our_share > 0` | Auto-accept fires; `AcceptTimeout` queued; timeout claim built and submitted | `game_finished: true` | `Ended cleanly` |
| **Fold** | Our turn; frontend explicitly calls `accept_timeout`; our share > 0 | `AcceptTimeout` handler builds timeout claim and registers it for submission at maturity | `game_finished: true` | `Ended cleanly` |
| **Move too late** | We submitted a move on-chain but the opponent's timeout claim landed first | Detected when the pending-move coin's spend pays the opponent's reward puzzle hash | `game_finished: None` | `Move too late` |

When both **Claim** and **Terminal** conditions are true simultaneously
(game is over AND `our_share == game_amount`), the case is treated as
**Terminal** — both auto-accept identically.

**`game_finished: true`** in `GameStatusOtherParams` is the unified "clean
end" signal. The frontend maps it to `cleanEnd: true`, which renders as
"Ended cleanly" in the dashboard. Claim, Terminal, and Fold all produce this
signal.

**`forfeited: true`** is the "adverse but intentional" signal. The frontend
maps it to `type: 'forfeit'`, which renders as "Forfeited" in the dashboard
without a pop-up notification (forfeits are routine, not surprising).

**Move too late** is the only case that uses the `reason` string — and only
when the game was not already in a finished state. If a pending move is
overtaken on a game that was already `game_finished`, the notification omits
the reason string and the frontend treats it as a clean end.

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
truth. Proposing comes with a liveness guarantee (every game ID will resolve);
accepting and cancelling do not (the intent may silently evaporate if the
proposal was already resolved by the time the queue is drained).

### Rule A — Proposal lifecycle

Every proposal-start event — a `propose_game` call (proposer side) or a
`ProposalMade` notification (receiver side) — yields exactly one
`ProposalAccepted` or `ProposalCancelled` for that game ID on that player's
side. The `cancel_all_proposals()` call on every exit path (go-on-chain, clean
shutdown, channel error) is the catch-all that ensures no proposal is left
unresolved. Enforced by the simulation loop's post-test assertion.

### Rule B — Game lifecycle (bijection)

There is a one-to-one correspondence between `ProposalAccepted` notifications
and terminal game notifications per player per game ID. Every
`ProposalAccepted` has exactly one terminal (`InsufficientBalance`,
`EndedWeTimedOut`, `EndedOpponentTimedOut`, `EndedCancelled`,
`EndedWeSlashedOpponent`, `EndedOpponentSlashedUs`,
`EndedOpponentSuccessfullyCheated`, or `EndedError`), and every terminal has a
preceding `ProposalAccepted`. Enforced by the simulation loop's post-test
assertion.

### Additional invariants

3. **`GameOnChain` invariant.** Every `GameOnChain` notification references a
   game that has a preceding `ProposalAccepted` in the same player's
   notification stream. A cancelled or never-accepted game must never produce
   `GameOnChain`. Enforced by the simulation loop's post-test assertion.
4. **First post-unroll status classification.** For each game that is still
   live when `ChannelState::Unrolling` is first observed, the first subsequent
   `GameStatus` for that game must be one of:
   `OnChainMyTurn`, `OnChainTheirTurn`, `Replaying`, `EndedCancelled`,
   `EndedError`, or `EndedWeTimedOut`. This ensures every live game is
   immediately classified into a valid unroll-resolution bucket.
5. **Channel state monotonicity.** `ChannelState` values are serialized to the
   frontend by name; the numeric ordinals here are an internal test ordering,
   not wire codes. They must never decrease:
   `Handshaking/WaitingForHeightToOffer/WaitingForHeightToAccept(0) <
   WaitingForOffer(1) < OfferSent(2) < TransactionPending(3) < Active(4) <
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
| `game-terminal` | Adverse `GameStatus` terminal during on-chain flow, except bar-only outcomes such as forfeits | Shows reward amount and coin info. |
| `proposal-rejected` | `ProposalCancelled` with `CancelledByPeer` | Peer-side cancellation notice; cleared when a `ProposalAccepted` arrives. |
| `insufficient-bal` | `InsufficientBalance` notification | Game could not start due to balance. |

### Data Model

Each notification carries an `id` (unique integer), `kind`, `title`, `message`,
and an optional `payload` (typed for `channel-state` and `game-terminal`
entries). Queues are persisted to `SessionState` (without non-serializable
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

- **Accept only on our turn.** Calling `accept_timeout()` when it is not our
turn is an assert failure. Accept-timeout is an alternative to moving.
- **Accepted + opponent move is an untested path.** Since accept_timeout only
happens on our turn, and only the mover can advance a game coin, the opponent
cannot move on a coin where we already accepted. The `accept_proposal_and_move` API exists but has
not been tested end-to-end; Calpoker's move direction may prevent it from
triggering in practice.
- **No phantom game-map entries.** During the on-chain transition,
`finish_on_chain_transition` filters out both our and the opponent's reward
puzzle hashes from the created-coins list before calling
`set_state_for_coins`. This prevents reward coins from being incorrectly
matched to live games and generating spurious terminal notifications.

**Key code:** `src/potato_handler/effects.rs`,
`src/potato_handler/handler_base.rs` (`emit_failure_cleanup`)

---

## GameplayEvent Mapping

The `useGameSession` hook translates raw `WasmNotification` terminal events
into game-agnostic `GameplayEvent` variants before forwarding them to
game-specific hooks (`useCalpokerHand`, `useSpacepokerHand`). Game hooks
never see raw notifications; they receive one of:

| Variant | Shape | When |
|---------|-------|------|
| `Timeout` | `{ byUs: boolean, forfeited: boolean }` | Any timeout-based terminal: forfeit, clean end, fold, move too late, opponent timeout. `forfeited: true` marks the case where the losing side intentionally skipped its final move (no point paying for an on-chain move that wins nothing), so games can label it "Forfeit" instead of the misleading "Timed Out". `byUs` gives the direction. |
| `GameError` | `{ reason: string }` | Slashes, cheats, cancellations, errors, insufficient balance |

The mapping from `GameTerminalType` (produced by `parseGameStatusTerminalInfo`)
to `GameplayEvent`:

| Terminal type | GameplayEvent |
|---------------|---------------|
| `forfeit` | `Timeout { byUs, forfeited: true }` -- direction from the original `GameStatusKind` |
| `we-timed-out` | `Timeout { byUs: true, forfeited: false }` |
| `opponent-timed-out` | `Timeout { byUs: false, forfeited: false }` |
| `we-slashed-opponent` | `GameError` |
| `opponent-slashed-us` | `GameError` |
| `opponent-successfully-cheated` | `GameError` |
| `ended-cancelled` | `GameError` |
| `game-error` | `GameError` |
| `insufficient-balance` | `GameError` |

Non-terminal events (`OpponentMoved`, `GameMessage`, `ProposalAccepted`) are
unchanged and forwarded directly.

**Key code:** `front-end/src/hooks/useGameSession.ts` (`terminalEventForInfo`,
`gameplayEventsForGameStatus`)
