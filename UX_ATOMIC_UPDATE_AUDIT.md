# Atomic UX Update Audit

Audit date: 2026-07-21

This audit identifies UI-visible transitions in which one logical protocol or
user action is delivered as multiple independently rendered updates. It is
evidence-based: every recommended item was traced through the current Rust
effect stream, WASM event FIFO, and React state handling. It does not propose
changing deliberate protocol progress states merely because they are separate
events.

## Baseline

The Rust engine returns ordered `Effect` values. `GameSession::process_effects`
maps them to queued `GameSessionEvent`s and may append a `ChannelStatus` after a
phase transition. `SessionController` appends each result to a FIFO and dispatches
one event per `setTimeout(0)` macrotask.

The macrotask boundary is intentional: a notification handler may make a
re-entrant WASM call and later handlers must see committed React state. The
recommended fixes therefore preserve FIFO ordering and this yield point. They
make the *projection of one logical action* atomic, either by emitting one
semantic notification or committing related view state together.

### Quiescent UI transactions

`SessionController` now drains the complete synchronous FIFO transaction inside
React's external-update batch. If a notification handler calls back into WASM,
the resulting effects are appended and drained before React can paint.
Asynchronous work such as coin-ID hashing remains a later metadata enrichment;
it must not control transition order or overwrite a newer state.

This is the preferred foundation for the findings below. Add a new wire shape
only when a game needs richer semantic data, not merely to avoid intermediate
session renders.

## Fixes recommended

### P0 — Serialize asynchronous notification projection

**Confidence:** high

**Path:** `front-end/src/hooks/SessionController.ts` now drains synchronous
FIFO work in one React batch. `front-end/src/hooks/useGameSession.ts` still
starts asynchronous coin-ID enrichment from `handleNotification`.

Several notification branches await `coinIdHex()` before committing session
state, including `ChannelStatus`, terminal `GameStatus`, normal `GameStatus`,
and the final enrichment step of `GameSettled`. A later event therefore starts
while an earlier handler is awaiting crypto. The earlier continuation can then
write an older channel status, turn status, or terminal projection after the
newer notification has already updated the UI.

**Atomic boundary:** keep immediate game payload delivery
(`OpponentMoved` / `Settled`) within the controller transaction. Late
enrichment must only fill data for the same state version; it must not overwrite
a newer state. Do not reintroduce a per-notification timer or turn enrichment
into a new protocol transition.

**Regression tests:**

- Delay the first `coinIdHex` call, deliver two different `ChannelStatus`
  notifications, then resolve the first call; assert the later status remains
  displayed.
- Deliver `GameStatus` followed by `GameSettled` while the first coin lookup is
  pending; assert terminal state cannot be overwritten by the older turn.
- Verify re-entrant events remain FIFO after the serialized handler completes.

### P0 — Do not announce a proposal as accepted when balance preflight fails

**Confidence:** high

**Path:** `src/session_phases/mod.rs`, `OffChainPhase::accept_proposal`.

When aggregate balance preflight fails, the function emits
`ProposalAccepted` for every group member, then `InsufficientBalance`, then
silently queues cancellation. The frontend's `ProposalAccepted` handler mounts
and starts the hand; the next macrotask's `InsufficientBalance` handler removes
its IDs and instances and returns to the proposal UI. A user can therefore see
a hand briefly start and disappear even though acceptance never succeeded.

This contradicts the grouped-proposal UX invariant: a group must never appear
partly live.

**Atomic boundary:** emit a failure notification only. Prefer a typed
`ProposalAcceptFailed { group_ids, reason: InsufficientBalance, ... }`, or make
`InsufficientBalance` itself the sole notification for the failed group. Do not
emit `ProposalAccepted` before the full aggregate preflight succeeds.

**Regression tests:**

- Attempt acceptance of a two-member group with insufficient aggregate balance.
- Assert the notification sequence has no `ProposalAccepted`.
- Render the frontend sequence and assert neither a hand mount nor `handKey`
  increment occurs before the insufficient-balance notice.

### P1 — Commit settlement display state once, not before and after coin hashing

**Confidence:** high

**Path:** `front-end/src/hooks/useGameSession.ts`, `GameSettled` handling.

The handler immediately sets a terminal with no reward-coin hex, publishes the
semantic `Settled` event, awaits `coinIdHex`, and then writes the terminal and
game instance again. Immediate delivery of `Settled` is correct: it prevents a
live board from outlasting a terminal protocol state. The duplicate
session-level terminal commit is not required for that guarantee and can make
the status bar or terminal detail redraw from a missing coin ID to a populated
one.

**Atomic boundary:** publish the early game-hook `Settled` event immediately,
but represent terminal UI as one stable terminal record with optional,
independently loading coin metadata. Alternatively, resolve the coin ID and
perform a single terminal-model commit when terminal presentation requires it.
The later coin lookup must enrich, not replace, the terminal state.

**Regression tests:**

- Delay reward-coin hashing and assert terminal label/outcome and per-game
  terminal state are each committed once.
- Assert the coin ID field transitions from loading to resolved without
  remounting the hand or replaying terminal animations.

### P1 — Emit one usable on-chain opponent-move notification

**Confidence:** high

**Path:** `src/session_phases/on_chain.rs`, the
`TheirTurnCoinSpentResult::Moved` branch.

One opponent move emits `GameStatus::OnChainMyTurn` with the new coin, followed
by a separate `GameStatus::MyTurn` with the readable move and mover share.
Those arrive in two macrotasks. The frontend deliberately forwards the readable
payload before it updates dashboard state, so game content and hand/dashboard
state can briefly describe different points in the same move.

**Atomic boundary:** use one status payload containing the new `coin_id`,
on-chain turn classification, readable move, and mover share. If compatibility
requires the two backend notifications temporarily, coalesce that exact
adjacent pair in the frontend before publishing either state to the game and
dashboard projections.

**Regression tests:**

- Deliver an opponent's on-chain move and assert the hand turn, coin ID,
  readable move, and mover share become visible in one render commit.
- Preserve the existing guard that prevents a local on-chain move from
  regressing to “Your turn” while it is being submitted.

### P1 — Make loser-forfeit terminal delivery a single semantic transition

**Confidence:** high

**Path:** `src/session_phases/on_chain.rs`,
`emit_loser_forfeit_terminal`.

For a terminal opponent move that leaves the local player with zero share, the
backend first emits `GameStatus::MyTurn` with the final readable move and then
emits `GameSettled::ForfeitedOpponentWon`. The first event is intentionally used
to show the final board, but it creates a temporary playable-looking turn
before the next macrotask settles the game.

**Atomic boundary:** extend the terminal settlement payload with optional final
readable-move data, and have the game hook apply the final board and terminal
state in one reducer/action. The frontend should never expose an actionable
turn in this path.

**Regression tests:**

- Deliver a readable terminal opponent move with zero local share.
- Assert the final board is updated and controls are disabled in the same
  render; no intermediate “your turn” state may be observable.

### P1 — Make Krunk group acceptance seed all game instances

**Confidence:** high

**Path:** `front-end/src/hooks/useGameSession.ts`, `ProposalAccepted` handling.

The handler correctly puts all group IDs in `currentHandGameIds` on the first
acceptance, but `replaceGameInstances` creates only the currently notified
member. Rust emits one `ProposalAccepted` per member, so a two-game Krunk hand
can render with both IDs known while one board has no instance until the next
macrotask.

**Atomic boundary:** on the first notification for a group, create an instance
for every group ID in one `replaceGameInstances` call. If member amounts differ
in a future factory, carry an amounts-by-ID map in a group-level acceptance
notification rather than synthesizing amounts.

**Regression tests:**

- Deliver only the first acceptance notification for a two-member Krunk group.
- Assert both boards receive active instances before React renders.
- Deliver the second notification and assert it is an idempotent update with no
  remount or animation reset.

### P2 — Avoid React state updates during Krunk render

**Confidence:** high

**Path:** `front-end/src/features/krunk/Krunk.tsx`.

The component detects an additional resolved clue during render and calls
`setAnimateIndex`. This forces a second render and risks replaying or briefly
mis-targeting a flip animation when the parent renders at the same time.

**Atomic boundary:** derive the pending animation index during render, then
commit it in an effect or layout effect keyed by `resolvedCount`. Preserve the
existing frozen-board initialization so recovered clues never replay.

**Regression tests:**

- Render a new clue while the parent rerenders; assert exactly one row receives
  the flip flag and no render-phase state-update warning is produced.
- Mount a frozen board with historical clues and assert no flip begins.

### P2 — Keep the finished hand mounted while proposal dialogs are open

**Confidence:** high

**Path:** `front-end/src/components/GameSession.tsx` and
`front-end/src/lib/session/model.ts`.

`selectHideGameInterfaceForBetweenHandDialog` hides the entire `GameHandHost`
when a compose or review dialog is displayed between hands. Closing the dialog
mounts it again. This is a visible board disappearance and can replay
game-specific visual state despite the frozen-hand design.

**Atomic boundary:** leave the completed hand mounted and place the proposal
dialog above it, optionally marking the hand inert or visually de-emphasized.
Do not use conditional removal of `GameHandHost` as dialog presentation state.

**Regression tests:**

- End a hand, open and close both compose and peer-review dialogs.
- Assert the same game subtree remains mounted and its frozen terminal state
  and animation history are retained.

### P2 — Eliminate Space Poker’s optimistic-fold rollback flash

**Confidence:** high

**Path:** `front-end/src/features/spacePoker/useSpacepokerHand.ts`,
`handleFold` and `applySettlement`.

Fold optimistically changes history and terminal state. A later settlement may
restore pot, raise, and history from `lastActionSnapshotRef` before applying a
different terminal result. The UI can show post-fold values, snap back, and then
show a terminal label.

**Atomic boundary:** use one reducer action for settlement reconciliation that
computes final history, chips, and terminal state before one commit. Retain the
optimistic fold only if its state is guaranteed to be the final presentation;
otherwise defer chip/history mutation until settlement classification.

**Regression tests:**

- Exercise an optimistic fold followed by a timeout/forfeit settlement.
- Assert the displayed pot, raise, history, and terminal label transition
  directly to their final values with no intermediate rollback state.

## Architecture follow-ups

### Coalesce a protocol transition before appending its channel snapshot

**Confidence:** medium

`src/game_session.rs` applies a whole effect vector and then emits the channel
snapshot. The unroll transition in
`src/session_phases/spend_channel_coin_phase.rs` can produce many per-game
terminal/on-chain statuses before the later channel snapshot. This is
particularly noticeable for multi-game hands: rows appear one at a time while
the channel bar still reports `Unrolling`.

Do not simply synchronously drain all events: that breaks the documented
re-entrancy contract. Instead, add an explicit frontend transaction/envelope
for an unroll resolution containing the channel snapshot and all initial game
states, or stage these related notifications and commit their view model at the
end of that logical batch.

Test a two-game unroll transition and assert the channel state and all initial
hand rows appear together.

### Separate “channel coin resolved” from “session resolution”

**Confidence:** high

`selectSessionPhase` already recognizes that `ResolvedUnrolled` with active
game IDs is still an on-chain session. The channel label nevertheless says
“resolved” while hand rows may be “Your turn” or “Playing move.” This is a
semantic UX mismatch, not merely a rendering issue.

Add a channel status that means the channel coin has resolved but on-chain games
remain active, or change the display projection so `ResolvedUnrolled` is not
presented as session completion while the game map is non-empty. Keep the
underlying monotonic channel-coin lifecycle unchanged.

## Intentional ordered flows to preserve

- Channel lifecycle progress (`GoingOnChain` → `Unrolling` → terminal channel
  state) represents separate on-chain observations. The dashboard is the
  persistent view; these should not be collapsed into a fake instant result.
- An illegal on-chain move followed by a later slash settlement spans separate
  blockchain confirmations and should remain a distinct “detected” state and
  terminal outcome.
- Handshake height gates and initiator `OfferSent`/`TransactionPending` states
  represent useful wallet/protocol progress. They may be made calmer in display
  copy, but are not correctness-level atomicity bugs.
- Active-channel balance updates are legitimate repeated snapshots and are
  already handled as a replaceable channel-state notification.
- Failure cleanup deliberately resolves game/proposal records before the
  terminal channel failure status. Preserve the lifecycle invariant; batch only
  its presentation if error-event volume becomes noisy.

## Test and observability gaps

- No frontend integration test proves that async notification handlers cannot
  complete out of FIFO order.
- No render test covers the first of a multi-member `ProposalAccepted` group.
- No React-level test covers a readable terminal move followed immediately by
  settlement, nor the two-phase reward-coin enrichment path.
- No integration test verifies the complete unroll burst as a single dashboard
  projection.
- Space Poker lacks a focused optimistic-fold/settlement reconciliation test.
- Cal Poker needs frozen/remount snapshot tests before changing its dual
  hook/presentation state model; the current state planes are a plausible
  one-frame card-staleness risk but not yet verified enough to recommend a
  rewrite.

## Recommended implementation order

1. Build on quiescent UI transactions and add out-of-order completion
   regression tests.
2. Correct failed proposal acceptance so a failed group is never announced live.
3. Make group hand initialization and settlement presentation single commits.
4. Add semantic data to on-chain opponent moves and terminal loser forfeits
   only if game hooks still need information the general transaction cannot
   convey.
5. Address local component transitions: Krunk render-phase animation, Space
   Poker rollback, and between-hand unmounting.
6. Extend the transaction model to full unroll resolution only after the earlier
   local fixes are verified; it has the broadest contract impact.
