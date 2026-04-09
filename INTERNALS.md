# Internals

Protocol mechanisms and internal invariants. For the conceptual overview, see
`OVERVIEW.md`. For on-chain dispute resolution, see `ON_CHAIN.md`.

## Table of Contents

- [Timeouts](#timeouts)
- [Peer Disconnect Invariant](#peer-disconnect-invariant)
- [cached_last_actions and the Redo Mechanism](#cached_last_actions-and-the-redo-mechanism)
- [Cheat Support](#cheat-support)
- [Simulator Strictness](#simulator-strictness)
- [Test Infrastructure](#test-infrastructure)
- [Invariant Assertions: game_assert! / game_assert_eq!](#invariant-assertions-game_assert--game_assert_eq)

---

## Timeouts

There are three distinct timeouts in the system:


| Timeout           | Purpose                                                                                                                                                                                    | Typical test value |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `channel_timeout` | Safety timeout for the watcher to detect channel coin spends. Not an on-chain timelock.                                                                                                    | 100 blocks         |
| `unroll_timeout`  | On-chain `ASSERT_HEIGHT_RELATIVE` on the unroll coin. Controls how long the opponent has to preempt before the timeout path succeeds. Passed to `ChannelHandler::new`.                     | 5 blocks           |
| `game_timeout`    | On-chain `ASSERT_HEIGHT_RELATIVE` on each game coin (referee). Controls how long the current mover has before the opponent can claim a timeout. Stored in `OnChainGameState.game_timeout`. | 10 blocks          |


**Important:** Game coins are registered with the watcher using their specific
`game_timeout` (from the referee), not the `channel_timeout`. The
`channel_timeout` is the normal channel/unroll watcher timeout configuration.
One bootstrap exception exists in the initiator handshake path, where channel
coin registration currently uses a fixed large timeout (`Timeout::new(1_000_000)`).

**Timeout transactions** should be submitted as soon as the relative timelock
allows (i.e., at the exact block height where the coin's creation height +
timeout = current height). The simulator enforces this by panicking if a
transaction with an unsatisfied `ASSERT_HEIGHT_RELATIVE` is submitted to the
mempool.

---

## Peer Disconnect Invariant

When a peer calls `go_on_chain`, its peer connection is **immediately severed**.
No further peer messages are sent or received by that peer. The other peer is
**not notified directly** — it only discovers the on-chain transition when it
sees the channel coin being spent on the blockchain.

This is enforced in `SynchronousGameCradleState`:

- A `peer_disconnected: bool` flag is set to `true` at the start of
`GameCradle::go_on_chain`, before any on-chain logic runs.
- The same flag is also set from channel status transitions in
`emit_channel_status_if_changed` when state becomes `GoingOnChain`,
`Unrolling`, or (`ResolvedUnrolled`/`ResolvedStale` while already on-chain).
- `PacketSender::send_message` silently drops outbound messages when
`peer_disconnected` is true.
- `GameCradle::deliver_message` silently drops inbound messages when
`peer_disconnected` is true.

After disconnection, all state updates come from coin-watching events. The
disconnected peer's own unroll transaction is detected via the same
`handle_channel_coin_spent` path that handles opponent-initiated unrolls (see
[Unified Path](ON_CHAIN.md#unified-path)).

Historically, `ChannelHandler` had an `initiated_on_chain` field intended for
transition bookkeeping. In current code, the behavior above is enforced by
peer disconnection and handler replacement (`PotatoHandler -> UnrollWatchHandler`)
rather than by checking `initiated_on_chain` at runtime.

**Key code:** `src/peer_container.rs` — `go_on_chain`,
`emit_channel_status_if_changed`, `send_message`, `deliver_message`;
`src/potato_handler/mod.rs` — `go_on_chain`, `take_unroll_watch_replacement`

---

## cached_last_actions and the Redo Mechanism

### Design Principle

All state transitions are **forward-only**. There is no rewind logic. When a
game goes on-chain, the system either recognizes that the game coin is already
at the latest state, or it replays cached moves to advance to the latest state.
This is the "redo" mechanism.

### Lifecycle

`cached_last_actions` on the `ChannelHandler` is a
`Vec<CachedPotatoRegenerateLastHop>` (defined in
`src/channel_handler/types/potato.rs`) that stores data for unacknowledged
outgoing actions. Because a single batch can contain multiple moves and game
acceptances across different games, multiple entries may need to be redone
on-chain.

There are three kinds of cached entries:

- `**PotatoMoveHappening`** — a move we sent but the opponent hasn't acknowledged.
Stores the move data, the puzzle hash it operates on (`match_puzzle_hash`),
and the post-move puzzle hash (`saved_post_move_last_ph`).
- `**PotatoAcceptTimeout`** — a game acceptance we sent. Stores the game ID, puzzle
hash, live game state, and reward amounts. When the potato returns
(acknowledgment), `drain_cached_accept_timeouts` emits `WeTimedOut` for each cached
accept.
- `**ProposalAccepted**` — a proposal acceptance we sent. Stores the game ID.
Used during stale unroll handling to distinguish in-flight proposal accepts
(which get `EndedCancelled`) from fully established games (which get
`GameError`).

**Set** in `send_move_no_finalize` (moves) and
`send_accept_timeout_no_finalize` (accept-timeouts).

**Cleared** (selectively) when we receive the potato back:

- `PotatoMoveHappening` entries are cleared in `verify_received_batch_signatures`
and `received_empty_potato` (the opponent's response acknowledges our moves).
- `ProposalAccepted` entries are also cleared on potato receive.
- `PotatoAcceptTimeout` entries are **retained** across those clears and only drained
later by `drain_cached_accept_timeouts` during `update_channel_coin_after_receive` or
clean shutdown, when `WeTimedOut` notifications are emitted.

### How Redo Works

When game coins are created after an unroll, `set_state_for_coins` checks each
coin's puzzle hash against all entries in `cached_last_actions`:

1. **Coin PH matches a `PotatoMoveHappening.match_puzzle_hash`**: The game coin is at
   the state our cached move operates on. A redo is needed to replay that move
   on-chain. Set `our_turn = true`.
2. **Coin PH == `last_referee_puzzle_hash`**: The game coin is at the latest
   state. No redo needed. Set `our_turn` based on `is_my_turn()`.
3. **Neither matches**: Error condition (game disappeared or unexpected state).

**Why `match_puzzle_hash` is the right value.** When a player makes a move via
`send_potato_move`, the `puzzle_hash_for_unroll` in the move result is the
curried referee puzzle hash of the **pre-move** state (computed from
`self.spend_this_coin()` before updating the referee). This value is stored as
`match_puzzle_hash` in `cached_last_actions`. It corresponds to the puzzle
hash the unroll coin would create for this game coin if the unroll resolved
at the state *before* our move — which is exactly the puzzle hash that
appears on-chain in both the non-stale redo case and in a stale unroll at
that state.

Multiple games may need redos simultaneously if the batch contained moves for
different games. Redo transactions are emitted in parallel during
`finish_on_chain_transition`, with a `PendingMoveSavedState` entry inserted into
the handler's `pending_moves` map for each one.

**In-flight proposal acceptances** (`ProposalAccepted` entries in
`cached_last_actions`) don't trigger a redo — if the game coin never
materialized on-chain, the game is cancelled (`EndedCancelled`).

### When Redo Happens (and When It Doesn't)

A redo is triggered when:

- We sent a move that wasn't acknowledged before going on-chain
- The unroll/preemption resolved to the state *before* that move

A redo is NOT needed when:

- The preemption or timeout resolved to the latest state (our move was already
included in the unroll data)
- We were the *receiver* of the last move (nothing to replay)

### Stale Cache After Peer Disconnect

When `go_on_chain` is called, all incoming peer messages are black-holed (see
[Peer Disconnect Invariant](#peer-disconnect-invariant)). If we sent actions
(adding to `cached_last_actions`) but the peer's response — which would normally
clear the entries — arrives *after* the disconnect, the entries remain.
This is expected and correct: the stale cache causes `set_state_for_coins` to
detect that redos or cancellations are needed, replaying our unacknowledged
moves and timeout claims on-chain.

### Redo and User-Queued Moves Can Coexist

There are two sources of on-chain actions after `go_on_chain`:

- **Redo actions** (from `cached_last_actions`): moves or accept-timeouts we
already sent with the last potato but that weren't acknowledged before going
on-chain. These apply to games where **it was our turn and we acted**.
- **User-queued actions** (from `game_action_queue`): moves the user queued
(via `make_move`) while waiting for the potato or after going on-chain. These
apply to games where **it was the opponent's turn** (so we couldn't have sent
anything yet), or actions queued after the transition.

Because moves alternate, a single game cannot have entries in both lists — you
can't have an unacknowledged move you sent (it was your turn) and a queued move
waiting to send (it was their turn) for the same game. But with multiple games
running simultaneously, some games may need redos while others have queued
moves. Both are placed on `game_action_queue` and processed independently; any
sequencing within a single game (e.g. redo a move then claim a timeout) is
enforced by on-chain coin dependencies, not queue order.

---

## Cheat Support

**This feature is for testing and demonstration purposes only.**

The `cheat(game_id, mover_share)` call submits a move containing illegal data
to the game, allowing tests and demos to exercise the slashing and timeout
paths. The `mover_share` parameter is what the cheater leaves for the victim on
timeout (zero to take everything). Cheating is a first-class action that flows
through the normal queue/redo pipeline — there is no separate "enable cheating"
step.

### How It Works

When `cheat()` is called on a `GameCradle`:

1. A `GameAction::Cheat(game_id, mover_share, entropy)` is queued internally.
2. Like a normal `Move`, the `Cheat` action is deferred until it is the
  player's turn.
3. When processed (off-chain in `drain_queue_into_batch` or on-chain in
  `do_on_chain_action`), the handler atomically:
  - Enables cheating on the `ChannelHandler`'s referee for that game,
  substituting `0x80` (nil) as the move bytes and the given `mover_share`
  (which becomes the victim's share on timeout).
  - Executes the move through the normal referee path. The referee bypasses
  validation and produces a game-move with the fake data.
4. The resulting move is sent to the opponent, who detects the invalid data and
  can slash on-chain.

### Outcomes


| Scenario                        | Notification (cheater)                                       | Notification (victim)                                         |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| Opponent detects and slashes    | `OpponentSlashedUs`                                          | `WeSlashedOpponent`                                           |
| Opponent fails to slash in time | `OpponentTimedOut` (cheater receives `amount - mover_share`) | `OpponentSuccessfullyCheated` (victim receives `mover_share`) |


**Key code:**

- `src/peer_container.rs` — `SynchronousGameCradle::cheat`
- `src/potato_handler/types.rs` — `GameAction::Cheat`
- `src/potato_handler/mod.rs` — `cheat_game`, `drain_queue_into_batch` (Cheat arm)
- `src/potato_handler/on_chain.rs` — `do_on_chain_action` (Cheat arm)
- `wasm/src/mod.rs` — WASM `cheat` binding

---

## Simulator Strictness

The simulator (`src/simulator/mod.rs`) can run in strict mode
(`Simulator::new_strict()`), which panics on conditions the real blockchain
would silently reject or ignore. The main potato-handler integration suite uses
strict mode; some simulator tests also run explicitly in non-strict mode. In
non-strict mode the simulator behaves like a normal blockchain, returning rejection codes
instead of panicking. The point of strict-mode panics is that in a correct
implementation none of these conditions should ever occur — hitting one means
there is a bug.

**Strict-mode panics** (non-strict mode returns rejection codes instead):


| Check                           | What it catches                                                                                                                |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| **Puzzle hash mismatch**        | Computed puzzle hash differs from the coin record's puzzle hash. Indicates incorrect puzzle reconstruction.                    |
| **Premature timelock**          | `ASSERT_HEIGHT_RELATIVE` not yet satisfied at submission time. The real chain silently drops these.                            |
| **Conflicting mempool spends**  | Two different transactions spending the same coin. The real chain picks one.                                                   |
| **CLVM execution error**        | Puzzle/solution fails to run. Means the code submitted a malformed transaction.                                                |
| **Aggregate signature failure** | Spend bundle's aggregate signature does not verify. Means signing logic has a bug.                                             |
| **Implicit fee mismatch**       | Implicit fee differs from declared `RESERVE_FEE`. In strict mode this now panics to enforce explicit fee accounting.             |
| **Coin not found**              | Spending a coin that doesn't exist. Means stale state or a logic error in coin tracking.                                       |
| **Already spent**               | Spending a coin that was spent in a prior block. Means stale timeout or duplicate submission.                                  |
| **Minting**                     | Outputs exceed inputs (creating value from nothing). Means incorrect amount calculation.                                       |
| **RESERVE_FEE not satisfied**   | Declared fee exceeds available implicit fee. Means the fee arithmetic is wrong.                                                  |


**Key code:** `src/simulator/mod.rs` — `push_tx`

---

## Test Infrastructure

### Debug Game

The debug game (`b"debug"`) is a minimal game used for tests that need precise
control over `mover_share`. Its core handler/curry wiring lives in
`src/test_support/debug_game.rs`, while `DebugGameTestMove::new(mover_share, slash)`
is defined in `src/simulator/tests/potato_handler_sim.rs`. It creates a single-move game where
Alice moves and Bob must accept_timeout. The `mover_share` value is what Bob
(the new mover after Alice's move) receives on timeout; Alice receives
`amount - mover_share`. This avoids the complexity of Calpoker's commit-reveal
protocol when testing channel/on-chain mechanics.

### Simulation Test Actions

Tests drive the simulation loop with a sequence of `GameAction` values (defined
in `src/test_support/game.rs`):


| Action                              | Effect                                                                                                                                                              |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ProposeNewGame(player, trigger)`   | Player proposes a new game when `trigger` fires (`Channel` or `AfterGame(game_id)`)                                                                               |
| `ProposeNewGameTheirTurn(player, trigger)` | Same as `ProposeNewGame`, but proposed with receiver moving first                                                                                           |
| `GoOnChain(player)`                 | Player initiates on-chain transition                                                                                                                                |
| `GoOnChainThenMove(player)`         | Player goes on-chain, then immediately queues the next move action for replay testing                                                                              |
| `Timeout(player)`                   | Trigger timeout processing for the player's pending state                                                                                                           |
| `AcceptTimeout(player)`             | Player accepts the current game result                                                                                                                              |
| `WaitBlocks(n, players_bitmask)`    | Advance `n` blocks; `players_bitmask` controls whose coin reports are backlogged (0 = nobody blocked, 1 = player 0 blocked, 2 = player 1 blocked, 3 = both blocked) |
| `NerfTransactions(player)`          | Silently drop all outbound transactions for `player`                                                                                                                |
| `UnNerfTransactions(replay)`        | Stop dropping transactions; if `replay` is true, replay the backlog to the simulator; if false, discard it                                                          |
| `Cheat(player, mover_share)`        | Queue a move with illegal data; `mover_share` is the victim's share on timeout (see [Cheat Support](#cheat-support))                                                |
| `Move(player, game_id, readable, was_received)` | Submit a normal move with explicit game ID and move payload                                                                                                 |
| `FakeMove(player, game_id, readable, sabotage_bytes)` | Submit a move with custom sabotage bytes for validation/error-path testing                                                                               |
| `ForceDestroyCoin(player)`          | Inject a fake coin deletion to test error handling                                                                                                                  |
| `CleanShutdown(player)`             | Initiate clean channel shutdown                                                                                                                                     |
| `ForceUnroll(player)`               | Submit a unroll transaction using the player's cached spend info, bypassing state checks. Simulates a malicious peer unrolling after agreeing to clean shutdown.    |
| `AcceptProposal(player)`            | Player accepts a pending game proposal                                                                                                                              |
| `CancelProposal(player, game_id)`   | Player cancels a pending proposal for a specific game                                                                                                               |
| `SaveUnrollSnapshot(player)`        | Save the player's current `ChannelCoinSpendInfo` for later use by `ForceStaleUnroll`                                                                                |
| `ForceStaleUnroll(player)`          | Submit an unroll using a previously saved snapshot (from `SaveUnrollSnapshot`), creating an outdated unroll on-chain                                                |
| `NerfMessages(player)`              | Silently drop all outbound peer messages for `player`                                                                                                               |
| `UnNerfMessages`                    | Stop dropping peer messages                                                                                                                                         |
| `CorruptStateNumber(player, new_sn)` | Corrupt local state number for edge-case testing                                                                                                                   |
| `InjectRawMessage(player, bytes)`   | Inject raw inbound bytes to test message validation/error handling                                                                                                   |


`NerfTransactions` is particularly useful for testing asymmetric scenarios —
e.g., one player's unroll transaction gets dropped (simulating network issues)
while the other player proceeds normally.

**Important:** `NerfTransactions` only drops a player's *outbound transactions*.
It does not prevent coins from being created for that player's puzzle hash by
another player's transaction. In particular, the referee timeout creates reward
coins for **both** mover and waiter in a single spend, so a nerfed player still
receives their reward coin when the non-nerfed player submits the timeout.

`NerfMessages` similarly drops a player's *outbound peer messages*, preventing
potato exchanges. Combined with `NerfTransactions`, this can fully isolate a
player to set up stale unroll scenarios where the opponent's state advances
without the nerfed player's knowledge.

**Key code:**

- `src/test_support/debug_game.rs` — `DebugGameHandler` and debug game registration
- `src/simulator/tests/potato_handler_sim.rs` — `DebugGameTestMove` and integration scenarios
- `src/test_support/game.rs` — `GameAction` enum (sim-tests variant)

---

## Invariant Assertions: `game_assert!` / `game_assert_eq!`

Production code must never crash on bad data from peers or the blockchain.
At the same time, internal invariant violations are bugs that should be caught
loudly during development and testing.

The `game_assert!` and `game_assert_eq!` macros (defined in
`src/common/types/macros.rs`) bridge these two needs:

- **Debug / test builds:** the macro panics immediately (via `debug_assert!`),
making invariant violations impossible to miss during development.
- **Release builds:** the macro returns `Err(Error::StrErr(...))`, allowing the
caller to handle the failure gracefully (typically by emitting a `GameError`
notification and continuing).

### Usage

```rust
game_assert!(self.have_potato, "must have potato to send accept");
game_assert_eq!(expected_ph, actual_ph, "puzzle hash mismatch");
```

The calling function must return `Result<_, Error>` — the compiler enforces
this because the macro contains a `return Err(...)`.

### When to use each pattern


| Situation                                     | Pattern                                           |
| --------------------------------------------- | ------------------------------------------------- |
| Internal invariant (own logic)                | `game_assert!` / `game_assert_eq!`                |
| Data from peer or blockchain                  | Return `Err` directly (never trust external data) |
| Deserialization of wire data                  | `map_err(serde::de::Error::custom)?`              |
| Infallible conversions (e.g. `0.to_bigint()`) | `.unwrap()` is acceptable                         |
| Test-only code                                | Standard `assert!` / `assert_eq!`                 |


### Rationale

Before these macros, the codebase used a mix of `assert!`, `.expect()`, and
`.unwrap()` for invariant checks — all of which panic unconditionally, crashing
the process even in production when a trusted full node sends bad data. The
macros replace these with a single consistent pattern that is strict during
development but graceful in production.

**Key code:** `src/common/types/macros.rs`
