# Game Lifecycle

For the conceptual overview (state channels, coin hierarchy, potato protocol),
see `OVERVIEW.md`. For on-chain dispute resolution, see `ON_CHAIN.md`.

## Table of Contents

- [Game Proposals](#game-proposals)
- [Off-Chain Game Flow](#off-chain-game-flow)
- [AcceptSettlement Lifecycle](#acceptsettlement-lifecycle)

---

## Game Proposals

Games are initiated through a propose/accept flow:

1. **Propose:** The caller submits one group request containing `game_type`,
   game-specific `parameters`, and one shared `timeout`. Both peers run the same
   deterministic factory, which produces the ordered game records for the
   group. The potato holder sends one `BatchAction::ProposeGroup`; both sides
   record all produced games in `proposed_games`. The receiver gets one
   `ProposalMade` notification for the group, with the member IDs in factory
   order; the proposer does not.
2. **Accept:** The receiver (or proposer on a subsequent potato) sends
   `BatchAction::AcceptProposal` actions for every member in the same batch.
   Both sides instantiate every referee and game handler, moving the group into
   `live_games`. Partial group acceptance is invalid.
3. **Cancel:** Either side can cancel using any member ID; the higher layer
   expands the request to every member, and all cancellation actions travel in
   the same batch. If a channel goes on-chain while a proposal is still
   pending, the whole unresolved group is cancelled.

### Receiver-Side Proposal Validation

When an incoming `ProposeGroup` is processed, the receiver first runs its
registered factory with the request's `game_type` and exact `parameters`. The
wire member list must be non-empty and have the same ordered cardinality as the
factory result. Each wire member must match the corresponding canonical factory
record: sender/receiver contributions, amount, `sender_goes_first`, initial
commitments, fixed handlers' derived role, and validator commitment. Any
failure rejects the batch (triggering rollback and go-on-chain).

The normal per-game checks are then applied while recording each member:

- **Nonce parity:** The proposal's `game_id` nonce must have the correct parity
for the sender's role (even for initiator, odd for responder).
- **Nonce monotonicity:** The nonce must be >= the expected minimum (nonces may
skip due to cancelled proposals, but cannot go backwards).
- **Nonce gap cap:** The nonce must not jump more than `MAX_NONCE_GAP` (1000)
ahead of the expected value. Prevents a malicious peer from claiming an
absurdly high nonce.
- **Amount consistency:** Each member's `amount` must equal its sender and
receiver contributions. Prevents the peer from creating games where money
appears or disappears.
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
- **Insufficient balance on accept:** Before any group member is accepted, the
  handler sums all local contributions and all peer contributions and compares
  both aggregates with the available balances. If either total is short, no
  member is accepted; the entire group is cancelled and
  `InsufficientBalance` identifies the failed group request.

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

Every proposal uses the same atomic-group path, including factories that
produce only one game. The API accepts exactly one request with `game_type`,
`parameters`, and a timeout shared by all produced games. Factory cardinality
is part of the registered game contract:

- Calpoker: 1 game
- Space Poker: 1 game
- Krunk: 2 games, one with each player in each role

**Atomic proposal construction:** The sender runs the factory first and sums
all sender contributions and all receiver contributions. Both aggregate totals
must fit the corresponding out-of-game balances before IDs are allocated or
any proposal is queued. The group is then represented by one
`BatchAction::ProposeGroup` containing the shared request and the ordered member
metadata. Multi-game groups use the first ordered ID as `group_id`; singleton
groups do not need one.

**Receiver derivation:** The receiver runs the same factory and compares the
entire ordered wire group with its local result. It does not parse one member
at a time to discover peer-specific handlers. The higher layer selects the
appropriate fixed handler and swaps sender/receiver contributions into its
local perspective.

**Accept/cancel expansion:** Calling `accept_proposal` or `cancel_proposal`
with any member ID expands to the complete group. Acceptance performs another
aggregate balance preflight before queuing any member. Accept or cancel actions
for all members are sent together; a received partial acceptance is a protocol
violation that rejects the batch. Thus proposal creation, acceptance, and
cancellation are all-or-none at group scope.

**Notification:** The receiver gets exactly one `ProposalMade` for the group.
Its `id` is the first game ID, and `group_ids` contains all member IDs in
factory order for multi-game groups (empty for a singleton). Contributions in
the notification are aggregate totals from the receiver's local perspective.

### WASM Accept-and-Move Convenience

The WASM layer exposes an `accept_proposal_and_move` function that atomically accepts
a proposal and makes the first move. Internally this translates into two
distinct `BatchAction`s (`AcceptProposal` followed by `Move`) in the same
batch.

**Key code:** `src/session_phases/mod.rs` — `propose_games`,
`accept_proposal`, `cancel_proposal`;
`wasm/src/mod.rs` — `propose_games`, `accept_proposal_and_move`

---

## Off-Chain Game Flow

For details on how game handlers and validation programs work (parameters,
return formats, chaining), see `HANDLER_GUIDE.md`.

A single game's lifecycle, independent of other concurrent games:

```
1. Propose  (BatchAction::ProposeGroup)
   → all factory-produced games enter proposed_games on both sides

2. Accept   (BatchAction::AcceptProposal)
   → referee + game handler instantiated, game moves to live_games
   → both sides receive ProposalAccepted

3. Play     (BatchAction::Move, alternating turns)
   → each move updates the referee state and mover_share

4. Finish   (BatchAction::AcceptSettlement)
   → balances updated, game moves to pending_settlements
   → GameSettled { outcome: accept_settlement, our_share } emitted once confirmed
```

All of these actions are delivered via the
[potato batch protocol](OVERVIEW.md#the-potato-protocol): they are queued locally and sent
when the potato is held, potentially alongside actions for other games. Multiple
games can be in flight simultaneously, and any potato pass may carry actions
for several of them.

The `ChannelState` tracks `live_games`, `pending_settlements`,
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

See [AcceptSettlement Lifecycle](#acceptsettlement-lifecycle) for details on what
happens when accept_settlement hasn't been confirmed before going on-chain.

---

## AcceptSettlement Lifecycle

`AcceptSettlement` is the protocol action for voluntarily accepting the current
`mover_share` split. Off-chain it is always intentional. Poker UIs may expose
this as **Fold**, but Fold is a game-local UX label only — not a protocol or
session status name. On-chain, the same intent is carried by a **timeout
claim** spend after the timelock (see [ON_CHAIN.md](ON_CHAIN.md)); the
mechanism is "timeout claim", the intent is settlement. Other on-chain settled
outcomes (#1–#11 in the [settlement glossary](NAMING_AUDIT.md#settlement-glossary-ux))
also arrive as `GameSettled`, not as separate slash/timeout notification
families.

Calling `accept_settlement()` off-chain does **not** immediately finalize the
game. The full lifecycle is:

### Off-Chain AcceptSettlement

1. `send_accept_settlement_no_finalize` moves the game from `live_games` to
  `pending_settlements` in the `ChannelState` and updates balances.
2. A `CachedAcceptSettlement` entry is added to `cached_redo_actions` storing the game ID
  and reward amounts.
3. The accept-settlement data is bundled into the next potato pass (batch).
4. When the potato comes back (acknowledgment), `drain_cached_accept_settlements` processes
  the `CachedAcceptSettlement` entries in `cached_redo_actions`, emitting
  `GameSettled { outcome: accept_settlement, our_share }` for each accepted game.
  The opponent who receives `BatchAction::AcceptSettlement` gets
  `GameSettled { outcome: accept_settlement, our_share }` immediately upon
  processing the batch — the receiver computes `our_share` locally via
  `get_our_current_share()` rather than trusting the peer's claimed amount.

Multiple game acceptances in a single batch each get their own `CachedAcceptSettlement`
entry, and all emit `GameSettled` when the potato returns.

If the channel goes on-chain **before** the round-trip completes, the game
is still in `pending_settlements`. The `set_state_for_coins` function
searches both `live_games` and `pending_settlements` when matching game
coins, so accepted-but-unconfirmed games are correctly tracked on-chain.

When preemption resolves to the post-AcceptSettlement state (the newer state
already incorporated the accept), no game coin is created — its value is folded
into the reward coin. In this case `drain_preempt_resolved_accept_settlements`
checks `cached_redo_actions` for `CachedAcceptSettlement` entries whose game is
absent from the on-chain game set. If an entry is found, the potato never came
back (otherwise `drain_cached_accept_settlements` would have removed it), so
`GameSettled { outcome: accept_settlement, our_share }` is emitted now. This
avoids both missed notifications and duplicates: if the potato had returned,
the entry would already be gone.

On clean shutdown, any remaining `CachedAcceptSettlement` entries in `cached_redo_actions`
are drained, emitting `GameSettled` before the terminal `ChannelStatus`
(`ResolvedClean`) notification.

### On-Chain AcceptSettlement

When a game is already on-chain and the player calls `AcceptSettlement(game_id)`:

1. `OnChainPhase` asserts it is our turn, then sets `accepted = true`
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
  puzzle hash): `GameSettled` is emitted with `we_accepted` or `settled_cleanly`
  depending on whether the game was already terminal.
  - If the spend creates another **game coin**, the accepted intent is carried
  forward and the new coin is tracked. This can happen when the chain coin is
  the version materialized by the unroll rather than the locally most advanced
  potato state; redo/forward-alignment must still finish before timeout
  finality.
  - Other unrecognized spends are treated as game errors (`GameStatus` with
  `EndedError`).

**Note:** Off-chain `accept_settlement` does not emit `GameSettled` at call
time; it emits on later resolution (potato round-trip, observed on-chain timeout
spend, preempt-resolved accept, or clean shutdown). On-chain `AcceptSettlement`
also defers until the resolving spend is observed, but has zero-share early-out
paths that emit `GameSettled` immediately with a forfeit outcome (#3–#5).

**Key code:**

- `src/channel_state/mod.rs` — `send_accept_settlement_no_finalize`,
`pending_settlements`, `drain_cached_accept_settlements`,
`drain_preempt_resolved_accept_settlements`
- `src/session_phases/on_chain.rs` — `GameAction::AcceptSettlement`,
`handle_game_coin_spent`, `build_timeout_claim`
- `src/transaction_manager.rs` — `TransactionManager` (eager claim submission)

### Automatic AcceptSettlement

When a move arrives whose next handler/validator is nil (the game is over) and
there are no slashing conditions, `OffChainPhase` automatically queues
`GameAction::AcceptSettlement` for that game. The frontend does **not** need to
call `acceptSettlement()` explicitly after a game ends.

Detection uses `ChannelState::is_game_finished(game_id)`, which returns true
when `is_my_turn()` and `is_game_over()` (nil next handler on the `Referee`).

This auto-queue happens in two places:

1. **Off-chain:** In `process_received_batch`, after processing a
   `BatchAction::Move` that leaves the game finished
   (`src/session_phases/mod.rs`).
2. **On-chain:** In `handle_game_coin_spent`, when the expected spend arrives
   and the resulting game state is finished
   (`src/session_phases/on_chain.rs`).

The UX consequence is that the receiver of the final move sees
`OpponentMoved` followed shortly by `GameSettled { outcome: accept_settlement, … }`
— both are emitted in sequence without any user interaction required.

Because the game is removed from `live_games` by the automatic accept, an
explicit `AcceptSettlement` call on an already-finished game will fail (no
matching live game). Test code that previously called `accept_settlement()`
after the last move no longer needs to do so.
