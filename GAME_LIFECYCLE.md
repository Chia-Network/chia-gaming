# Game Lifecycle

For the conceptual overview (state channels, coin hierarchy, potato protocol),
see `OVERVIEW.md`. For on-chain dispute resolution, see `ON_CHAIN.md`.

## Table of Contents

- [Game Proposals](#game-proposals)
- [Off-Chain Game Flow](#off-chain-game-flow)
- [AcceptTimeout Lifecycle](#accepttimeout-lifecycle)

---

## Game Proposals

Games are initiated through a propose/accept flow:

1. **Propose:** The potato holder sends a `BatchAction::ProposeGame` containing
  the `GameStart` descriptor (game type, contributions, timeout, parameters).
   Both sides record the game in `proposed_games` as a pending proposal. The
   receiver gets a `ProposalMade` notification; the proposer does not (the
   proposer tracks the proposal via the `propose_game` API call itself).
2. **Accept:** The receiver (or proposer on a subsequent potato) sends
  `BatchAction::AcceptProposal`. Both sides instantiate the referee and game
   handler, moving the game into `live_games`. Both receive
   `ProposalAccepted`.
3. **Cancel:** Either side can send `BatchAction::CancelProposal` to withdraw.
  Both receive `ProposalCancelled`. If a channel goes on-chain while a
   proposal is still pending, proposals not reflected in the unroll are
   automatically cancelled.

### Receiver-Side Proposal Validation

When `apply_received_proposal` processes an incoming `ProposeGame`, it enforces
several checks before recording the proposal. Any failure rejects the batch
(triggering rollback and go-on-chain):

- **Nonce parity:** The proposal's `game_id` nonce must have the correct parity
for the sender's role (even for initiator, odd for responder).
- **Nonce monotonicity:** The nonce must be >= the expected minimum (nonces may
skip due to cancelled proposals, but cannot go backwards).
- **Nonce gap cap:** The nonce must not jump more than `MAX_NONCE_GAP` (1000)
ahead of the expected value. Prevents a malicious peer from claiming an
absurdly high nonce.
- **Amount consistency:** The proposal's `amount` must equal
`my_contribution + their_contribution`. Prevents the peer from creating games
where money appears or disappears.
- **Game timeout:** The proposal's `timeout` must be positive. The UX defaults
  to 15 blocks, but peers can propose different positive game timeouts.
- **Proposal count limit:** The total number of outstanding proposals must not
exceed `MAX_PROPOSALS` (100). Prevents a peer from flooding proposals to
exhaust memory or starve resources.

Multiple proposals and acceptances can be batched in a single potato pass.
Acceptances should be ordered before proposals in the batch to ensure funds
freed by accepted games are available for new proposals.

### Receiver-Side Acceptance Validation

When `apply_received_accept_proposal` processes an incoming `AcceptProposal`,
it verifies that the game_id has **our** nonce parity — meaning it was a
proposal we made that the peer is legitimately accepting. If the game_id has
the peer's parity, the peer is attempting to accept their own proposal
(self-accept attack), which is rejected as a protocol violation triggering
rollback and go-on-chain.

### Race Conditions in Proposal Lifecycle

Because cancel and accept requests are queued and only sent when the potato is
held, several race conditions can occur:

- **Stale cancel:** A player queues `CancelProposal` but by the time they hold
the potato the proposal is already gone (accepted or cancelled by the peer).
The cancel is silently discarded — `drain_queue_into_batch` checks
`is_game_proposed()` and skips it. Note: cancellation by the **receiver** is
authoritative (they are the only one who can accept, so deciding to cancel
resolves it). Cancellation by the **proposer** is best-effort: the receiver
may have already accepted on a previous potato pass, in which case the
proposer's cancel evaporates and a `ProposalAccepted` arrives instead.
- **Stale accept:** A player queues `AcceptProposal` but the proposal was
already cancelled by the peer before the accept is sent. The accept silently
evaporates — the `ProposalCancelled` from the peer's cancel already resolved
the proposal lifecycle (Rule A). Acceptance is advisory; no notification is
emitted for the stale accept.
- **Insufficient balance on accept:** When the potato arrives and
`drain_queue_into_batch` processes a `QueuedAcceptProposal`, it pre-checks
both players' available balances. If either player's contribution exceeds
their `out_of_game_balance`, `ProposalAccepted` is emitted followed
immediately by `InsufficientBalance` (the terminal). `CancelProposal` is sent
to the peer (who sees `ProposalCancelled`). The game satisfies both Rule A
(accepted) and Rule B (terminal follows acceptance).

### Proposal Collision Handling

When both players try to propose simultaneously, the proposals collide. Because
the potato protocol serializes all state updates, these collisions are always
resolved deterministically by WASM — but the frontend needs to handle the
resulting cancellations gracefully so the user's intent is preserved.

**How collisions manifest:** Both `SupersededByIncoming` and
`PeerProposalPending` cancel the local proposal and emit
`ProposalCancelled`. The frontend stashes the cancelled proposal's terms in
`pendingRetryTermsRef`. When the peer's `ProposalMade` notification arrives
(which it will, since the peer successfully proposed), the handler checks
`pendingRetryTermsRef` and takes one of two paths:

- **Terms match the previous hand** — auto-reject the peer's proposal and
  re-send ours. The user never sees the collision.
- **Terms differ** — surface the peer's proposal in the review UI so the user
  can decide. The stashed retry terms are discarded.

This means a simple "play again at the same stakes" interaction is seamless
even when both players click "New Hand" at the same moment. Only genuinely
conflicting terms (different amounts) require user intervention.

See `UX_NOTIFICATIONS.md` for the full `CancelReason` table and frontend
behavior for each variant.

### Grouped (Atomic) Proposals

Multiple games can be proposed as a single atomic group by calling
`propose_games` (plural) instead of `propose_game`. All games in the group
share a `group_id` equal to the first game's nonce. This is used by Krunk,
which always proposes two games as a pair (one where each player is Alice).

**Wire format:** Each `ProposeGame` in the batch carries a `group_id` field.
`ProposedGame` records in `proposed_games` store the same field.

**Accept/cancel expansion:** When `accept_proposal` or `cancel_proposal` is
called with a game ID that belongs to a group, the potato handler
automatically expands the operation to all group members. The individual
`AcceptProposal` / `CancelProposal` batch actions remain per-ID on the wire;
the expansion happens in the potato handler before serialization.

**Receive-side validation:** When a peer batch contains `AcceptProposal` for
one member of a group we proposed, all other members of that group must also
be accepted in the same batch. Partial group acceptance is a protocol
violation that triggers batch rejection and go-on-chain.

**Notification:** `ProposalMade` includes a `group_ids` field listing all game
IDs in the group. The frontend uses this to present grouped proposals as one
logical proposal and to skip duplicate `ProposalMade` notifications for
secondary group members.

### WASM Accept-and-Move Convenience

The WASM layer exposes an `accept_proposal_and_move` function that atomically accepts
a proposal and makes the first move. Internally this translates into two
distinct `BatchAction`s (`AcceptProposal` followed by `Move`) in the same
batch.

**Key code:** `src/potato_handler/mod.rs` — `propose_game`, `propose_games`,
`accept_proposal`, `cancel_proposal`;
`wasm/src/mod.rs` — `propose_games`, `accept_proposal_and_move`

---

## Off-Chain Game Flow

For details on how game handlers and validation programs work (parameters,
return formats, chaining), see `HANDLER_GUIDE.md`.

A single game's lifecycle, independent of other concurrent games:

```
1. Propose  (BatchAction::ProposeGame)
   → game enters proposed_games on both sides

2. Accept   (BatchAction::AcceptProposal)
   → referee + game handler instantiated, game moves to live_games
   → both sides receive ProposalAccepted

3. Play     (BatchAction::Move, alternating turns)
   → each move updates the referee state and mover_share

4. Finish   (BatchAction::AcceptTimeout)
   → balances updated, game moves to pending_accept_timeouts
   → WeTimedOut / OpponentTimedOut emitted once confirmed
```

All of these actions are delivered via the
[potato batch protocol](OVERVIEW.md#the-potato-protocol): they are queued locally and sent
when the potato is held, potentially alongside actions for other games. Multiple
games can be in flight simultaneously, and any potato pass may carry actions
for several of them.

The `ChannelHandler` tracks `live_games`, `pending_accept_timeouts`,
player balances (`my_allocated_balance`, `their_allocated_balance`), and the
current `state_number`. Each batch increments the `state_number` once and
produces a new signed unroll commitment.

### Receiver-Side Move Validation

When `apply_received_move` processes an incoming `BatchAction::Move`, it checks:

- `**mover_share` <= game amount:** The peer cannot claim a timeout share larger
than the pot.
- **Move size <= `max_move_size`:** The move bytes must not exceed the limit set
by the previous move's validator. The limit is read from `spend_this_coin()`
(the post-move referee args), which reflects the constraint the validator
declared for the *next* move.

Both failures reject the batch (rollback and go-on-chain).

See [AcceptTimeout Lifecycle](#accepttimeout-lifecycle) for details on what
happens when accept_timeout hasn't been confirmed before going on-chain.

---

## AcceptTimeout Lifecycle

`AcceptTimeout` is the protocol action for accepting the current game result.
Depending on context this is also described as folding or timing out: all three
settle the current game according to the same `mover_share` value. The
difference is how the settlement is reached (off-chain agreement, local
fold/accept, or an on-chain timeout claim after the timelock).

Calling `accept_timeout()` off-chain does **not** immediately finalize the
game. The full lifecycle is:

### Off-Chain AcceptTimeout

1. `send_accept_timeout_no_finalize` moves the game from `live_games` to
  `pending_accept_timeouts` in the `ChannelHandler` and updates balances.
2. A `PotatoAcceptTimeout` entry is added to `cached_last_actions` storing the game ID
  and reward amounts.
3. The accept-timeout data is bundled into the next potato pass (batch).
4. When the potato comes back (acknowledgment), `drain_cached_accept_timeouts` processes
  the `PotatoAcceptTimeout` entries in `cached_last_actions`, emitting `WeTimedOut` for
   each accepted game. The opponent who receives the accept-timeout gets
   `OpponentTimedOut` immediately upon processing the batch — the receiver
   computes the reward amount locally via `get_our_current_share()` rather than
   trusting the peer's claimed amount.

Multiple game acceptances in a single batch each get their own `PotatoAcceptTimeout`
entry, and all fire `WeTimedOut` when the potato returns.

If the channel goes on-chain **before** the round-trip completes, the game
is still in `pending_accept_timeouts`. The `set_state_for_coins` function
searches both `live_games` and `pending_accept_timeouts` when matching game
coins, so accepted-but-unconfirmed games are correctly tracked on-chain.

When preemption resolves to the post-AcceptTimeout state (the newer state
already incorporated the accept), no game coin is created — its value is folded
into the reward coin. In this case `drain_preempt_resolved_accept_timeouts`
checks `cached_last_actions` for `PotatoAcceptTimeout` entries whose game is
absent from the on-chain game set. If an entry is found, the potato never came
back (otherwise `drain_cached_accept_timeouts` would have removed it), so
`WeTimedOut` is emitted now. This avoids both missed notifications and
duplicates: if the potato had returned, the entry would already be gone.

On clean shutdown, any remaining `PotatoAcceptTimeout` entries in `cached_last_actions`
are drained, emitting `WeTimedOut` before the terminal `ChannelStatus`
(`ResolvedClean`) notification.

### On-Chain AcceptTimeout

When a game is already on-chain and the player calls `AcceptTimeout(game_id)`:

1. `OnChainGameHandler` asserts it is our turn, then sets `accepted = true`
  on the `OnChainGameState` entry. No transaction is submitted and no
   notification is emitted yet.
2. The accepted game's timeout claim is pre-built and registered eagerly, and
  the `TransactionManager` submits it once the coin reaches its relative
   timeout age (see
   [On-Chain Step 5](ON_CHAIN.md#step-5-timeout-resolution)). Setting
   `accepted` only records intent; no transaction is submitted at accept time.
3. When the game coin is spent on-chain, `handle_game_coin_spent` checks the
  `accepted` flag. For accepted games:
  - If the spend creates a **reward coin** (matching the player's reward
  puzzle hash): `WeTimedOut` is emitted.
  - If the spend creates another **game coin**, the accepted intent is carried
  forward and the new coin is tracked. This can happen when the chain coin is
  the version materialized by the unroll rather than the locally most advanced
  potato state; redo/forward-alignment must still finish before timeout
  finality.
  - Other unrecognized spends are treated as game errors.

**Note:** Off-chain `accept_timeout` does not emit `WeTimedOut` at call time;
it emits on later resolution (potato round-trip, observed on-chain timeout
spend, or clean shutdown). On-chain `AcceptTimeout` is also deferred until the
resolving spend is observed, but has a zero-share early-out path that can emit
terminal timeout status immediately.

**Key code:**

- `src/channel_handler/mod.rs` — `send_accept_timeout_no_finalize`,
`pending_accept_timeouts`, `drain_cached_accept_timeouts`,
`drain_preempt_resolved_accept_timeouts`
- `src/potato_handler/on_chain.rs` — `GameAction::AcceptTimeout`,
`handle_game_coin_spent`, `build_timeout_claim`
- `src/transaction_manager.rs` — `TransactionManager` (eager claim submission)

### Automatic AcceptTimeout

When a move arrives whose next handler/validator is nil (the game is over) and
there are no slashing conditions, `PotatoHandler` automatically queues
`GameAction::AcceptTimeout` for that game. The frontend does **not** need to
call `acceptTimeout()` explicitly after a game ends.

Detection uses `ChannelHandler::is_game_finished(game_id)`, which returns true
when `is_my_turn()` and `is_game_over()` (nil next handler on the `Referee`).

This auto-queue happens in two places:

1. **Off-chain:** In `process_received_batch`, after processing a
   `BatchAction::Move` that leaves the game finished
   (`src/potato_handler/mod.rs`).
2. **On-chain:** In `handle_game_coin_spent`, when the expected spend arrives
   and the resulting game state is finished
   (`src/potato_handler/on_chain.rs`).

The UX consequence is that the receiver of the final move sees
`OpponentMoved` followed shortly by `WeTimedOut` — both are emitted in
sequence without any user interaction required.

Because the game is removed from `live_games` by the automatic accept, an
explicit `AcceptTimeout` call on an already-finished game will fail (no
matching live game). Test code that previously called `accept_timeout()`
after the last move no longer needs to do so.
