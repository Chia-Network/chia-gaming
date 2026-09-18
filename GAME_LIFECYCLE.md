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

1. **Propose:** The caller submits one group request containing `game_type`
   (the first generated member's first validation-program hash, not a factory
   hash or package name), game-specific `parameters`, and one shared `timeout`.
   The factory is not run and no games, contributions, referees, or member IDs
   exist yet. The potato holder sends one `BatchAction::ProposeGroup` containing
   a canonical proposal ID and the requested terms. Both endpoints use that
   same ID. The receiver gets one
   `ProposalMade` notification; the proposer does not.
   `ProposalMade` includes the structured Bencodex parameters so the UI can
   decode terms through the selected package without handling CLVM.
2. **Accept:** The receiver sends one
   `BatchAction::AcceptProposalGroup(origin_proposal_id)`. At execution time,
   both sides run the factory with the current proposer reserve, current
   accepter reserve, and requested parameters. They assign shared sequential
   game IDs to the returned members and instantiate every referee and handler.
3. **Cancel:** Either side cancels using the canonical proposal ID. If a
   channel goes on-chain while a
   proposal is still pending, the unresolved proposal is cancelled.

### Receiver-Side Proposal Validation

When an incoming `ProposeGroup` is processed, the receiver validates and stores
only the requested terms. Factory execution and all game-owned decoding are
deferred until acceptance.

- **Proposal ID parity and sequence:** Each origin has a strict parity sequence
  for canonical proposal IDs. The next ID must match exactly; gaps, reuse, and
  wrong parity are protocol errors.
- **Game timeout:** The proposal's `timeout` must be between 3 and 100
  blocks inclusive. The UX defaults to 15 blocks, but peers can propose
  different values within that safe range.
- **Proposal count limit:** The total number of outstanding proposals must not
exceed `MAX_PROPOSALS` (100). Prevents a peer from flooding proposals to
exhaust memory or starve resources.

Multiple actions can be batched in one potato pass. They execute strictly in
bundle order; each successful acceptance immediately reduces out-of-game
reserves before the next action is evaluated.

### Receiver-Side Acceptance Validation

When an incoming `AcceptProposalGroup` is processed, its ID must identify a
proposal made by this endpoint. The factory receives
`(proposer_reserve accepter_reserve parameters)`, with reserves taken from the
current out-of-game balances at that exact point in the ordered batch.
Contributions and first-turn ownership are proposal-relative factory outputs;
Rust maps them to stable player A/B fields using `sender_is_player_a`.

Each successful factory member receives the next value from the shared
sequential game-ID counter. IDs are not sent on the wire. Contributions are
deducted immediately so later acceptances see the new reserves. Notifications
are deferred until every action and signature validates. Any error rolls back
the complete batch, including balances and game-ID allocation.

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
proposer's cancel evaporates and a `ProposalAcceptedGroup` arrives instead.
- **Stale accept:** A player queues `AcceptProposal` but the proposal was
already cancelled by the peer before the accept is sent. The accept silently
evaporates — the `ProposalCancelled` from the peer's cancel already resolved
the proposal lifecycle (Rule A). Acceptance is advisory; no notification is
emitted for the stale accept.
- **Insufficient balance on accept:** Before any group member is accepted, the
  factory may return proposer/accepter shortage flags. Rust also sums all
  returned proposer and accepter contributions and compares both aggregates
  with current reserves. Locally, failure emits `InsufficientBalance`, removes
  the proposal, and sends an explicit `CancelProposalGroup`; it does not emit a
  second local `ProposalCancelled`.

### Proposal Collision Handling

When both players try to propose simultaneously, the proposals collide. Because
the potato protocol serializes all state updates, these collisions are always
resolved deterministically by WASM — but the frontend needs to handle the
resulting cancellations gracefully so the user's intent is preserved.

**How collisions manifest:** Both `SupersededByIncoming` and
`PeerProposalPending` cancel the local proposal and emit
`ProposalCancelled`. The frontend stashes the cancelled proposal's terms in
`pendingRetryHandProposal`. When the peer's `ProposalMade` notification arrives
(which it will, since the peer successfully proposed), the handler checks
`pendingRetryHandProposal` and takes one of two paths:

- **Terms match the previous hand** — auto-reject the peer's proposal and
  re-send ours. The user never sees the collision.
- **Terms differ** — surface the peer's proposal in the review UI so the user
  can decide. The stashed retry terms are discarded.

This means a simple "play again at the same stakes" interaction is seamless
even when both players click "New Hand" at the same moment. Only genuinely
conflicting terms (different amounts) require user intervention.

When the user rejects an incoming proposal, a successful cancel returns the UI
to compose immediately. There is no `expectingCounterProposal` state or timer.
If a legitimate crossed proposal is already in flight, compose may flicker
briefly before the normal `ProposalMade` path presents it.

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

**Deferred construction:** A proposal is one pending terms record. At
acceptance, the deterministic factory produces the ordered members, approved
economics, first-turn ownership, validation programs, and one readable CLVM
parameter value per member. The wire carries one accept or cancel action per
proposal and never carries generated game IDs.

**Notification:** The receiver gets exactly one `ProposalMade` for the group.
Its `id` is the canonical proposal ID; pending `group_ids` is `[id]` because
members do not exist yet. On acceptance, both sides receive one
`ProposalAcceptedGroup` containing the same canonical proposal ID plus
the generated members in factory order. Each member contains its generated
game ID, approved player-A/player-B contributions, local turn ownership, and
factory-approved readable parameters for frontend initialization.

### WASM Accept-and-Move Convenience

The WASM layer exposes an `accept_proposal_and_move` function that atomically
accepts a proposal and makes the first move. Internally this translates into
two distinct `BatchAction`s (`AcceptProposalGroup` followed by `Move`) in the
same batch.

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
   → requested terms enter proposed_games on both sides

2. Accept   (one BatchAction::AcceptProposalGroup for the canonical proposal ID)
   → factory runs against current proposer/accepter reserves
   → all referees + game handlers are instantiated atomically
   → each side receives exactly one ProposalAcceptedGroup
     { id: proposal_id,
       members: [{ id, player_a_contribution, player_b_contribution,
                   our_turn, readable_parameters }, ...] }
     in factory order

3. Play     (BatchAction::Move, alternating turns)
   → each move updates the referee state and mover_share

4. Finish   (BatchAction::AcceptSettlement)
   → balances updated, game moves to pending_settlements
   → GameSettled { outcome: accept_settlement, our_share } emitted once confirmed
```

All of these actions are delivered via the
[potato batch protocol](OVERVIEW.md#the-potato-protocol): their durable action
state is queued locally and sent when the potato is held, potentially alongside
actions for other games. A move directive is validated and prepared before that
queue boundary: Rust verifies local turn/duplicate authority and immediately
runs the my-turn handler. A tagged `(tag message)` rejection emits synchronous
`MoveRejected`, and neither the readable input nor any move is queued.

On success the queue stores only the durable uncurried `PreparedMove` outputs
from that handler: move bytes, mover share, waiting handler, and optional
message parser. It does not store validator programs, a maximum move size, the
readable, entropy, transaction, curried referee, or derived puzzle hash. When
the potato arrives, off-chain application runs the current factory-registry
validator with the move and nil evidence, resolves a returned non-nil next
validator hash (or treats nil as terminal), and consumes the prepared output to
advance/curry/sign/send without rerunning the handler. The same split applies
to later on-chain actuation.
Post-application `CachedSendMove` redo state is separate from this
pre-application queue.

Multiple games can be in flight simultaneously, and any potato pass may carry
actions for several of them.

For every accepted member, the two peers report opposite `our_turn` bits.
Insufficient aggregate balance emits `InsufficientBalance`, cancels the group,
and emits no `ProposalAcceptedGroup`; the UI must not synthesize an acceptance.

The `ChannelState` tracks `live_games`, `pending_settlements`,
player balances (`my_allocated_balance`, `their_allocated_balance`), and the
current `state_number`. Each batch increments the `state_number` once and
produces a new signed unroll commitment.

### Receiver-Side Move Validation

When `apply_received_move` processes an incoming `BatchAction::Move`, it checks:

- `**mover_share` <= game amount:** The peer cannot claim a timeout share larger
than the pot.
- **Move size <= `max_move_size`:** The move bytes must not exceed the limit
selected for the current move by the prior validator transition. The limit is
read from `spend_this_coin()` (the post-move referee args).

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

When a move arrives whose next handler and next validator hash are both nil
(the game is over) and
there are no slashing conditions, `OffChainPhase` automatically queues
`GameAction::AcceptSettlement` for that game. The frontend does **not** need to
call `acceptSettlement()` explicitly after a game ends.

The two terminal signals must agree. A nil next validator hash with a non-nil
next handler, or a non-nil next validator hash with a nil next handler, is an
invalid transition.

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
