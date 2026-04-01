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

- dedicated variants: `GameProposed`, `GameProposalAccepted`,
  `GameProposalCancelled`, `InsufficientBalance`, `ActionFailed`, `ChannelStatus`
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

- [WASM Event FIFO and Reentrancy Safety](#wasm-event-fifo-and-reentrancy-safety)
- [Channel Lifecycle Notifications](#channel-lifecycle-notifications)
- [Gameplay Notifications](#gameplay-notifications)
- [Proposal Notifications](#proposal-notifications)
- [Game Outcome Notifications (Terminal)](#game-outcome-notifications-terminal)
- [Key Invariants](#key-invariants)
- [Additional Design Rules](#additional-design-rules)

---

## WASM Event FIFO and Reentrancy Safety

Every communication from the WASM cradle to the JS frontend is a `CradleEvent`
delivered through a single FIFO queue. There are no side-channel flags or polled
getters — wallet requests (`NeedCoinSpend`, `NeedLauncherCoin`), outbound
messages, transactions, notifications, and puzzle/solution requests all flow
through the same event stream.

Flow:

1. `processResult()` appends `result.events` to `eventQueue`.
2. If a drain is already in progress (`draining == true`), it returns
   immediately — the new events will be picked up by the active loop.
3. Otherwise it sets `draining = true` and processes events in order with
   `shift()` until the queue is empty, then clears `draining`.

Each event is dispatched exactly once by `dispatchEvent()`. Event types and
their handlers:

- `OutboundMessage` — send to peer via tracker
- `OutboundTransaction` — submit spend bundle to blockchain
- `Notification` — surface game/channel state to the UI
- `ReceiveError` — peer message decode failure
- `CoinSolutionRequest` — fetch puzzle/solution from blockchain
- `DebugLog` — diagnostic output
- `NeedLauncherCoin` — request the wallet to provide the launcher coin
- `NeedCoinSpend` — request the wallet to create and sign a spend bundle
- `WatchCoin` — register a coin for wallet/watch tracking

Why this exists:

- Some event handlers trigger additional WASM calls that produce more
  `CradleEvent`s (for example puzzle/solution fulfillment calls
  `report_puzzle_and_solution`, which returns a new drain result).
- Without a single FIFO and the `draining` guard, those nested results could
  re-enter dispatch while the current event list is mid-iteration, leading to
  out-of-order effects, dropped work, or duplicated processing.
- With the current design, nested or concurrent `processResult()` calls only
  enqueue more events; one active drain loop owns dispatch order.

This makes frontend event processing deterministic and avoids JS-side
reentrancy bugs during handshake and normal gameplay.

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
| `GameProposed { id, my_contribution, their_contribution }` | Game proposal received from opponent | A new game has been proposed by the peer. Only fires for the receiver — the proposer does not get this notification. |
| `GameProposalAccepted { id }`                              | Proposal accepted by either side     | The game is now live and play can begin                                                                              |
| `GameProposalCancelled { id, reason }`                     | Proposal cancelled or invalidated    | The proposal was cancelled explicitly, or automatically due to going on-chain                                        |

---

## Game Outcome Notifications (Terminal)

These are the terminal notifications — each signals that a game is finished.
The frontend should treat any of these as the "game ended" signal.


| Conceptual UX label | Actual wire shape | When | Meaning |
| --- | --- | --- | --- |
| InsufficientBalance | `InsufficientBalance { id, our_balance_short, their_balance_short }` | Accept attempted with insufficient funds | Proposal auto-cancels and accept fails terminally |
| WeTimedOut | `GameStatus { status: EndedWeTimedOut, my_reward, coin_id }` | Game resolved in our favor | Off-chain accept-timeout completion or on-chain timeout/slash resolution path |
| OpponentTimedOut | `GameStatus { status: EndedOpponentTimedOut, my_reward, coin_id }` | Game resolved in opponent's favor | Includes receiving opponent accept-timeout and on-chain opponent-favor outcomes |
| GameCancelled | `GameStatus { status: EndedCancelled, ... }` | Stale accept of already-cancelled proposal | Queued `AcceptProposal` found proposal already gone |
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

The system enforces seven notification lifecycle invariants. All seven hold even
through `Failed` — when the channel enters `Failed` state, cleanup
notifications (`GameProposalCancelled` for pending proposals, `GameError` for
live games) are emitted before the terminal `ChannelStatus`, ensuring every
open item is explicitly resolved.

1. `**propose_game` invariant.** Every `propose_game` call yields exactly one
  `GameProposalAccepted` or `GameProposalCancelled` for the proposer. The
   `cancel_all_proposals()` call on every exit path (go-on-chain, clean
   shutdown, channel error) is the catch-all that ensures no proposal is left
   unresolved. Enforced by the simulation loop's post-test assertion.
2. `**GameProposed` invariant.** Every `GameProposed` notification (received
  from the opponent) yields exactly one `GameProposalAccepted` or
   `GameProposalCancelled` for the receiver. Enforced by the simulation loop's
   post-test assertion.
3. `**accept_proposal` invariant.** Every `AcceptProposal` call yields exactly one
  terminal game notification: `InsufficientBalance`, `GameCancelled` (stale
   accept where the proposal was already cancelled), `WeTimedOut`,
   `OpponentTimedOut`, `WeSlashedOpponent`, `OpponentSlashedUs`,
   `OpponentSuccessfullyCheated`, or `GameError`. Note:
   `InsufficientBalance` is terminal (it auto-cancels the proposal).
   Enforced by the simulation loop's post-test assertion.
4. `**GameProposalAccepted` invariant.** Every `GameProposalAccepted` notification
  yields exactly one terminal game notification: `WeTimedOut`,
   `OpponentTimedOut`, `WeSlashedOpponent`, `OpponentSlashedUs`,
   `OpponentSuccessfullyCheated`, or `GameError`. Note: `GameCancelled` is
   **not** in this list — once a proposal is accepted, it cannot be cancelled;
   any disappearance is a `GameError`. Enforced by the simulation loop's
   post-test assertion.
5. **`GameOnChain` invariant.** Every `GameOnChain` notification references a
   game that has a preceding `GameProposalAccepted` in the same player's
   notification stream. A cancelled or never-accepted game must never produce
   `GameOnChain`. Enforced by the simulation loop's post-test assertion.
6. **First post-unroll status classification.** For each game that is still
   live when `ChannelState::Unrolling` is first observed, the first subsequent
   `GameStatus` for that game must be one of:
   `OnChainMyTurn`, `OnChainTheirTurn`, `Replaying`, `EndedCancelled`,
   `EndedError`, or `EndedWeTimedOut`. This ensures every live game is
   immediately classified into a valid unroll-resolution bucket.
7. **Channel state monotonicity.** `ChannelState` ordinals must never
   decrease: `Handshaking/WaitingForHeightToOffer/WaitingForHeightToAccept(0) <
   OfferSent(1) < TransactionPending(2) < Active(3) <
   ShuttingDown/GoingOnChain(4) < ShutdownTransactionPending/Unrolling(5) <
   ResolvedClean/ResolvedUnrolled/ResolvedStale/Failed(6)`. `Active` may
   repeat at the same ordinal (balance changes from potato firings), and
   terminal states (ordinal 6) may repeat (e.g. advisory changes).
   Enforced by the simulation loop's post-test assertion.

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
