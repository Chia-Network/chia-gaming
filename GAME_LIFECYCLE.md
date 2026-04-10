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
- **Timeout cap:** The proposal's `timeout` must not exceed `MAX_GAME_TIMEOUT`
(10000 blocks). Prevents a peer from locking funds in unreasonably long games.
- **Proposal count limit:** The total number of outstanding proposals must not
exceed `MAX_PROPOSALS` (100). Prevents a peer from flooding proposals to
exhaust memory or starve resources.

Multiple proposals and acceptances can be batched in a single potato pass.
Acceptances should be ordered before proposals in the batch to ensure funds
freed by accepted games are available for new proposals.

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

### WASM Accept-and-Move Convenience

The WASM layer exposes an `accept_proposal_and_move` function that atomically accepts
a proposal and makes the first move. Internally this translates into two
distinct `BatchAction`s (`AcceptProposal` followed by `Move`) in the same
batch.

**Key code:** `src/potato_handler/mod.rs` — `propose_game`, `accept_proposal`,
`cancel_proposal`; `wasm/src/mod.rs` — `accept_proposal_and_move`

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
2. When the game coin is spent on-chain, `handle_game_coin_spent` checks the
  `accepted` flag. For accepted games:
  - If the spend creates a **reward coin** (matching the player's reward
  puzzle hash): `WeTimedOut` is emitted.
  - Any other spend is unreachable (opponent cannot move on our accepted
  coin) and triggers a `GameError`.
3. When `coin_timeout_reached` fires, the timeout transaction is submitted and
  `WeTimedOut` is emitted.

**Note:** Off-chain `accept_timeout` does not emit `WeTimedOut` at call time;
it emits on later resolution (potato round-trip, on-chain timeout, or clean
shutdown). On-chain `AcceptTimeout` is also usually deferred, but has a
zero-share early-out path that can emit terminal timeout status immediately.

**Key code:**

- `src/channel_handler/mod.rs` — `send_accept_timeout_no_finalize`,
`pending_accept_timeouts`, `drain_cached_accept_timeouts`,
`drain_preempt_resolved_accept_timeouts`
- `src/potato_handler/on_chain.rs` — `GameAction::AcceptTimeout`, `handle_game_coin_spent`,
`coin_timeout_reached`

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
