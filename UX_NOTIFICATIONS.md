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
- [Gameplay Notifications](#gameplay-notifications)
- [Proposal Notifications](#proposal-notifications)
- [Game Outcome Notifications (Terminal)](#game-outcome-notifications-terminal)
- [Key Invariants](#key-invariants)
- [Additional Design Rules](#additional-design-rules)

---

## WASM Event FIFO and Async Drain

Every communication from the WASM cradle to the JS frontend is a `CradleEvent`
delivered through a single FIFO queue. There are no side-channel flags or polled
getters — wallet requests (`NeedCoinSpend`, `NeedLauncherCoin`), outbound
messages, transactions, notifications, and puzzle/solution requests all flow
through the same event stream.

Flow:

1. `processResult()` appends `result.events` to `eventQueue` and calls
   `scheduleDrain()`.
2. `scheduleDrain()` is a no-op if a drain is already scheduled or the queue
   is empty. Otherwise it schedules a `setTimeout(0)` callback that dispatches
   **one** event, saves state, and calls `scheduleDrain()` again for the next.

Each event is dispatched exactly once by `dispatchEvent()`, in a separate
macrotask. Event types and their handlers:

- `OutboundMessage` — send to peer via tracker
- `OutboundTransaction` — submit spend bundle to blockchain
- `Notification` — surface game/channel state to the UI
- `ReceiveError` — peer message decode failure
- `CoinSolutionRequest` — fetch puzzle/solution from blockchain
- `Log` — diagnostic output
- `NeedLauncherCoin` — request the wallet to provide the launcher coin
- `NeedCoinSpend` — request the wallet to create and sign a spend bundle
- `WatchCoin` — register a coin for wallet/watch tracking

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
| `CancelledByPeer` | The peer explicitly sent `BatchAction::CancelProposal` for our proposal. | **User-facing popup:** "Your proposal was rejected by the other side." |
| `CancelledByUs` | We explicitly cancelled the peer's proposal (via `cancel_proposal`). | **Silent.** We initiated the cancellation; nothing to tell the user. |
| `CleanShutdown` | The channel is shutting down cooperatively. All outstanding proposals are cancelled. | **Silent.** The shutdown UI handles this. |
| `WentOnChain` | The channel transitioned to on-chain resolution. Proposals not reflected in the unroll are cancelled. | **Silent.** The on-chain UI handles this. |
| `ChannelError` | An unrecoverable channel error occurred. All proposals are cancelled as cleanup. | **Silent.** The error UI handles this. |

The `is_local()` method on `CancelReason` returns `true` for
`SupersededByIncoming`, `PeerProposalPending`, and `GameActive`. The frontend
uses this to decide whether to stash terms for retry (local + terms available)
or show a user-facing notification (only `CancelledByPeer`).

---

## Game Outcome Notifications (Terminal)

These are the terminal notifications — each signals that a game is finished.
The frontend should treat any of these as the "game ended" signal.


| Conceptual UX label | Actual wire shape | When | Meaning |
| --- | --- | --- | --- |
| InsufficientBalance | `InsufficientBalance { id, our_balance_short, their_balance_short }` | Accept attempted with insufficient funds | Preceded by `ProposalAccepted`; the game is immediately terminated. The peer sees `ProposalCancelled`. |
| WeTimedOut | `GameStatus { status: EndedWeTimedOut, my_reward, coin_id }` | Game resolved in our favor | Off-chain accept-timeout completion or on-chain timeout/slash resolution path |
| OpponentTimedOut | `GameStatus { status: EndedOpponentTimedOut, my_reward, coin_id }` | Game resolved in opponent's favor | Includes receiving opponent accept-timeout and on-chain opponent-favor outcomes |
| EndedCancelled | `GameStatus { status: EndedCancelled, ... }` | In-flight accept lost during stale unroll | The game was accepted but no moves were made; the unroll predates the acceptance |
| WeSlashedOpponent | `GameStatus { status: EndedWeSlashedOpponent, my_reward, coin_id }` | Slash confirmed in our favor | Opponent's illegal move was proven on-chain |
| OpponentSlashedUs | `GameStatus { status: EndedOpponentSlashedUs, ... }` | Opponent slashed us | Our move was proven illegal on-chain |
| OpponentSuccessfullyCheated | `GameStatus { status: EndedOpponentSuccessfullyCheated, my_reward, coin_id }` | Illegal move timed out before slash | Opponent kept timeout path before we slashed |
| GameError | `GameStatus { status: EndedError, reason }` | Unrecoverable game-level issue | One game reached an error terminal condition |

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
5. **Channel state monotonicity.** `ChannelState` ordinals must never
   decrease: `Handshaking/WaitingForHeightToOffer/WaitingForHeightToAccept(0) <
   OfferSent(1) < TransactionPending(2) < Active(3) <
   ShuttingDown/GoingOnChain(4) < ShutdownTransactionPending/Unrolling(5) <
   ResolvedClean/ResolvedUnrolled/ResolvedStale/Failed(6)`. `Active` may
   repeat at the same ordinal (balance changes from potato firings), and
   terminal states (ordinal 6) may repeat (e.g. advisory changes).
   Enforced by the simulation loop's post-test assertion.

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
| `game-terminal` | `GameStatus` ended during on-chain flow | Shows reward amount and coin info. |
| `proposal-rejected` | `ProposalCancelled` with `CancelledByPeer` | Cleared when a `ProposalAccepted` arrives. |
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
