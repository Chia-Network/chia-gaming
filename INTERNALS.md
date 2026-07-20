# Internals

Protocol mechanisms and internal invariants. For the conceptual overview, see
`OVERVIEW.md`. For on-chain dispute resolution, see `ON_CHAIN.md`.

## Table of Contents

- [Timeouts](#timeouts)
- [Peer Disconnect Invariant](#peer-disconnect-invariant)
- [Peer Error Escalation](#peer-error-escalation)
- [Local Action Errors](#local-action-errors)
- [Batch Rollback Scope](#batch-rollback-scope)
- [Atomic Proposal Factory Invariants](#atomic-proposal-factory-invariants)
- [cached_redo_actions and the Redo Mechanism](#cached_redo_actions-and-the-redo-mechanism)
- [Cheat Support](#cheat-support)
- [Simulator Strictness](#simulator-strictness)
- [Test Infrastructure](#test-infrastructure)
- [Invariant Assertions: game_assert! / game_assert_eq!](#invariant-assertions-game_assert--game_assert_eq)

---

## Timeouts

There are three distinct timeouts in the system:


| Timeout           | Purpose                                                                                                                                                                                    | Typical test value |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| `channel_timeout` | Safety timeout for the watcher to detect channel coin spends. Not an on-chain timelock. The hub accepts values in the 3-30 block range and defaults to 15.                         | 15 blocks          |
| `unroll_timeout`  | On-chain `ASSERT_HEIGHT_RELATIVE` on the unroll coin. Controls how long the opponent has to preempt before the timeout path succeeds. The hub accepts values in the 3-30 block range and defaults to 15. | 15 blocks          |
| `game_timeout`    | On-chain `ASSERT_HEIGHT_RELATIVE` on each game coin (referee). Controls how long the current mover has before the opponent can claim a timeout. Stored in `OnChainGameState.game_timeout`. Proposals may choose any positive value; the UX defaults to 15 blocks. | 15 blocks          |


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

The default 15-block unroll timeout gives honest users enough time to preempt
stale unrolls without making mainnet dispute resolution overly slow. At mainnet
block cadence it is roughly five minutes; in the simulator it is roughly 150
seconds. The hub bounds channel and unroll timeout negotiation to
3-30 blocks so users can make small adjustments without accepting arbitrarily
long or short dispute windows.

### Eager Timeout Submission and Confirmation-Driven Notifications

Timeout handling is split into two decoupled responsibilities: the
`TransactionManager` owns **submission** (and its timing), while the handlers
own **notification**, driven by observing the resulting on-chain spend. There is
no maturity callback into the handlers — `coin_timeout_reached` was removed.

**Eager claim, registered up front.** When a coin that can be claimed on timeout
is registered, the handler pre-builds the claim `SpendBundle` and attaches it to
the registration. The plumbing carries it end to end:
`Effect::RegisterCoin { spend: Option<SpendBundle>, .. }` →
`GameSessionEvent::WatchCoin { spend, .. }` →
`TransactionManager::register_watch(.., spend)`. The manager also returns the
watch registration to the host as a `watchCoins` polling delta. There are three
eager-claim sites:

- the unroll-via-timeout claim, built at `WaitForTimeout` registration
(`build_unroll_timeout_spend`);
- the per-game-coin timeout claim, built when game coins are first registered
(`build_timeout_claim` / `register_initial_game_coins`).

A claim is attached **only when the timeout pays us**; otherwise the field is
`None` and the manager submits nothing on our behalf.

**The manager is the sole submitter.** Each `WatchedCoin` stores the optional
`timeout_spend` plus a reorg-aware `birthday` and a `claim_submitted` flag. On
every block the manager submits a stored claim once the coin reaches
`birthday + timeout_blocks` while it is still unspent, setting `claim_submitted`.
A reorg that rolls back or shifts the coin's birthday re-arms `claim_submitted`,
so the claim is resubmitted. This replaced the old lazy "build and submit at the
moment the timeout fires" logic in the handlers.

**Reorg boundary: leaf logic pretends reorgs do not happen.** Protocol handlers
are intentionally written against a simplified lifecycle: they register coins,
hand the transaction manager any timeout/safety spend that should be submitted
when mature, and then react to the semantic lifecycle events they observe. They
do not own maturity polling, reorg replay, or repeated resubmission decisions.

The transaction manager is the boundary that absorbs chain churn. It tracks
creation and spend heights, detects rollback, re-arms stored timeout claims when
a watched coin's birthday changes, retains submitted transactions across
restore, and resubmits transactions whose output coins vanished because their
creation was rolled back. Handler-level logic should not receive repeated
semantic events merely because a reorg made the same transaction need replaying.

**Retained transaction replay.** When the manager drains a transaction for
submission, it keeps a retained copy for reload/reorg recovery and derives the
output coins that transaction should create from its `CREATE_COIN` conditions.
Those expected outputs are replay/conflict metadata only. They do not become host
poll targets unless a protocol handler separately registers the coin as watched.

The replay rule is deliberately narrow:

- If one of the retained transaction's expected outputs is observed on-chain,
  that transaction is considered to have won. It remains retained so a later
  reload or reorg can replay it if its output vanishes.
- If an input coin is observed spent but the retained transaction's expected
  output does not appear, a conflicting transaction won. The retained local
  intent is forgotten immediately and must not be replayed after reload or
  reorg.

This prevents stale local intentions from being resurrected after the protocol
has already accepted a different chain path. For example, if we were trying to
clean-shutdown but an unroll spend wins the channel coin, the clean-shutdown
transaction is no longer a replay candidate.

**Reorg strategy: replay, not general conflict resolution.** The manager's job is
still not to solve every possible reorg/conflict rabbit hole. It handles
retained transaction replay, output-vanish replay, timeout-claim re-arming, and
the narrow "conflicting spend won, forget our obsolete local intent" cache
pruning above. There is not yet a general recovery mechanism for deeper
**true invalidation** cases where handler state would need to be rebuilt from an
earlier point or a new chain path needs protocol-specific interpretation beyond
the observed coin lifecycle. Those paths are future protocol/error-handling work
rather than part of the current transaction manager replay model.

Coverage for this replay model lives in `src/transaction_manager.rs`: creator
transactions are resubmitted when output coins vanish
(`reorged_out_output_resubmits_creating_transaction`), timeout claims are
re-armed when a watched coin's birthday rolls back
(`eager_timeout_spend_resubmitted_after_birthday_rollback`), conflicting
retained submissions are pruned when their input is spent by another transaction
(`conflicting_spend_prunes_retained_submission_immediately`), winning submissions
remain replayable after their expected output appears
(`winning_spend_retains_submission_for_replay`), and re-mined coins clear stale
vanished flags before later genuine spends are forwarded
(`reorg_remine_in_same_report_clears_vanished_and_allows_later_spend`).

**Per-block rebroadcast for dropped broadcasts.** Reorg-driven replay (above)
only re-submits a transaction when one of its outputs is observed and then
vanishes. That does not cover a broadcast that simply never reached the network
in the first place — e.g. an unroll *preempt*, which has no relative timelock and
no other resubmission path, and would otherwise strand the protocol waiting for a
coin spend that never comes. So on every block `resubmit_pending` rebroadcasts
each retained submission that is

- flagged `auto_resubmit` — it creates an observable output coin (so we can tell
  when it lands) **and** carries no relative timelock (so rebroadcasting it at a
  later height stays valid even after a reorg; `bundle_has_relative_timelock`
  decides this, treating an unanalyzable bundle as timelocked);
- not yet observed to land; and
- still has at least one input coin present (unspent).

The **input-present gate** is what keeps this safe against abandoned intents:
once a transaction's input is spent — whether because our own spend landed or a
conflicting spend won — it is never rebroadcast again. Rebroadcasting an
*identical* bundle is harmless (the mempool de-duplicates by fingerprint), and a
cross-party conflict (the opponent spending the same coin with a *different*
bundle) is expected on a real chain and resolves naturally, since only one spend
of a coin can confirm. Eager timeout claims are deliberately excluded from this
path (they carry a relative timelock) because the ripeness logic above already
resubmits them in a reorg-aware way. Coverage:
`auto_resubmits_dropped_output_bearing_spend_until_it_lands`,
`auto_resubmit_stops_when_input_spent_by_conflict`,
`auto_resubmit_skips_timelocked_spend`,
`auto_resubmit_skips_when_input_not_present`.

**Spends first observed as already-spent are still forwarded.** A watched coin
whose very first observation already carries a spend height (an opponent's coin
that was published and spent before our first poll of it) never enters the live
set, so the present→absent diff cannot surface it. The manager captures these
`first_seen_spent` coins and merges them into the spend report anyway; without
this a handler waiting on such a coin — e.g. an opponent-published unroll coin —
never receives `coin_spent` and stalls forever
(`coin_first_seen_already_spent_is_forwarded_as_spend`).

**Host polling vs semantic coin ownership.** The browser-side poller owns the
active transport queue of coin names to query. It reports raw coin-state
observations to the WASM transaction manager, and it may stop polling a coin
after it has reported a sufficiently buried spend. The transaction manager still
owns the semantic lifecycle: it decides which observed states become
`coin_created`/`coin_spent`, handles first-seen-spent coins, detects reorgs,
re-arms timeout submissions, and prunes retained transactions. In other words,
the poller may forget how to query a terminal coin, but it does not interpret
what that terminal coin means for the channel or game.

**Notifications ride the observed spend.** Terminal notifications are emitted
from `handle_game_coin_spent` (via the `coin_spent` → `coin_puzzle_and_solution`
pipeline) by interpreting what the observed spend created — our reward coin
(we claimed) vs. the opponent's reward coin (they moved or claimed). In the
common opponent-moved case our eager claim simply never confirms and the game
advances; nothing is pre-emptively notified. See
[On-Chain Step 5](ON_CHAIN.md#step-5-timeout-resolution) for the full outcome
table.

---

## Peer Disconnect Invariant

When a peer calls `go_on_chain`, its peer connection is **immediately severed**.
No further peer messages are sent or received by that peer. The other peer is
**not notified directly** — it only discovers the on-chain transition when it
sees the channel coin being spent on the blockchain.

This is enforced in `GameSessionState`:

- A `peer_disconnected: bool` flag is set to `true` at the start of
`GameSession::go_on_chain`, before any on-chain logic runs.
- The same flag is also set from channel status transitions in
`emit_channel_status_if_changed` when state becomes `GoingOnChain`,
`Unrolling`, or (`ResolvedUnrolled`/`ResolvedStale` while already on-chain).
- `PacketSender::send_message` silently drops outbound messages when
`peer_disconnected` is true.
- `GameSession::deliver_message` silently drops inbound messages when
`peer_disconnected` is true.

After disconnection, all state updates come from coin-watching events. The
disconnected peer's own unroll transaction is detected via the same
`handle_channel_coin_spent` path that handles opponent-initiated unrolls (see
[Unified Path](ON_CHAIN.md#unified-path)).

Historically, `ChannelState` had an `initiated_on_chain` field intended for
transition bookkeeping. In current code, the behavior above is enforced by
peer disconnection and handler replacement (`OffChainPhase -> SpendChannelCoinPhase`)
rather than by checking `initiated_on_chain` at runtime.

**Key code:** `src/game_session.rs` — `go_on_chain`,
`emit_channel_status_if_changed`, `send_message`, `deliver_message`;
`src/session_phases/mod.rs` — `go_on_chain`, `take_channel_spend_next_phase`

### Peer Error Escalation

Any error processing a peer message — during handshake or active play — is
treated as a protocol violation. The cradle sets `peer_disconnected = true`,
emits a `ReceiveError` event for diagnostic purposes, and calls
`go_on_chain(true)` on the active handler. The specific behavior depends on
the channel lifecycle stage:

**Before funding transaction is submitted** (early handshake — steps A through
C/D): No money is on-chain. The handshake handler sets an internal `failed`
flag, `channel_status_snapshot()` returns `ChannelStatus::Failed`, and the
session is terminally dead. No dispute is needed because no funds are at risk.

**After funding transaction is submitted but before channel coin confirms**
(steps E/F onward): The funding `SpendBundle` is in the mempool or pending
inclusion. Two outcomes are possible:

1. The funding transaction **times out** (its `ASSERT_BEFORE_HEIGHT_ABSOLUTE`
   expires without inclusion). The `TransactionManager` detects this and
   independently emits a `Failed` channel status. Funds return to the wallets.

2. The channel coin **appears on-chain** despite the peer being hostile.
   `coin_created` fires, the handshake handler transitions to `OffChainPhase`
   via `take_replacement()`. After the swap, `process_effects` sees
   `peer_disconnected && handshake_finished() && !is_on_chain` and immediately
   calls `go_on_chain(true)` on the new `OffChainPhase`, submitting the unroll
   transaction. From this point forward, the normal dispute resolution path
   applies.

**After channel coin is confirmed** (active play in `OffChainPhase`): The
normal `go_on_chain` path runs immediately — cancel proposals, build the
channel-to-unroll spend bundle, submit it, and transition through
`SpendChannelCoinPhase` into `OnChainPhase`.

This means a hostile peer cannot cause silent data loss regardless of when the
attack occurs. Pre-funding errors are cheap (just abort). Post-funding errors
either resolve through timeout (funds return) or through dispute (unroll +
on-chain resolution).

### Local Action Errors

Local actions (moves, proposals, shutdown) queued in `game_action_queue` are
drained by `flush_pending_actions`. Unlike peer errors, local action failures
indicate programming bugs — the queue was populated by our own UI/logic.

Rather than implementing transactional rollback (expensive and masks the bug),
the cradle catches `flush_pending_actions` errors and emits them as
`ActionFailed` notifications shown to the user with the full error string.
The JS-side game action methods (`proposeGame`, `acceptProposal`,
`cancel_proposal`, `makeMove`, `acceptSettlement`, `cheat`) also catch WASM
throws and surface them through the UI error dialog. This makes local bugs
immediately visible and diagnosable without adding rollback complexity.

---

## Batch Rollback Scope

When a `PeerMessage::Batch` is received, `pass_on_channel_state_message`
snapshots both `channel_state` and `game_action_queue` before calling
`process_received_batch` and restores them on error. This makes the peer's batch
actions atomic across the state that matters for later dispute recovery: if any
action in the batch fails validation or signature verification fails, channel
state and queued local actions both revert to the pre-batch state.

The queue snapshot matters even though the peer cannot directly enqueue local
actions. A valid prefix of a malicious peer batch can make our pre-existing
queued local actions stale before a later action or signature check fails. If
that stale queue leaked into `go_on_chain`, the on-chain handler could attempt
local responses that were only stale because the failed peer batch partially ran.
The invariant is therefore:

- **Peer batch failure is atomic.** No `ChannelState` mutations and no
  peer-induced `game_action_queue` changes survive a failed received batch.
- **Bad peer data escalates.** Ordinary `OffChainPhase::received_message` errors
  call `go_on_chain(..., true)` after rollback. That is the protocol response to
  invalid peer data.
- **Local queue drain errors are internal/local problems.**
  `drain_queue_into_batch` processes user/UI actions queued through local APIs.
  Those errors are not a normal peer-message recovery path.

Fields updated after successful signature verification, such as `have_potato`
and `last_channel_coin_spend_info`, are outside the rollback problem because
they are only advanced after the received batch is valid.

**Key code:** `src/session_phases/mod.rs` — `pass_on_channel_state_message`
(snapshot/restore), `process_received_batch`, `update_channel_coin_after_receive`,
`drain_queue_into_batch`; regression:
`failed_final_move_bad_signature_does_not_queue_accept_settlement`

---

## Atomic Proposal Factory Invariants

Proposal construction starts from exactly one group request:
`game_type`, game-specific `parameters`, and one timeout shared by all games in
the result. Both peers run the same registered deterministic factory. Its output
is a non-empty ordered list of canonical 12-field records containing
sender/receiver contributions, amount, `sender_goes_first`, the initial
commitments, fixed my-turn and their-turn handlers, and the initial validator.
The validator hash is checked against the validator program locally.

The result remains sender-oriented until the higher layer constructs local game
state. At that point it selects the fixed handler matching the local initial
turn and swaps sender/receiver contributions into the receiver's
`my_contribution` / `their_contribution` perspective. This avoids peer-specific
factory runs or proposal parsers while ensuring both peers commit to the same
game records. Calpoker and Space Poker factories return one record; Krunk
returns two.

Atomicity is enforced at three boundaries:

1. **Propose:** Derive cardinality, IDs, economics, roles, and wire commitments
   from one factory run. Proposals may exceed current balances; funding is
   checked when the receiver chooses to accept.
2. **Receive:** Re-run the factory and require the group-level wire action's
   ordered members and cardinality to match exactly.
3. **Accept/cancel:** Expand any member ID to the complete group. Acceptance
   repeats the aggregate balance preflight before queueing any member, and the
   receiver rejects a batch that accepts only part of a group. Cancellation
   also queues every member together.

These checks compose with batch rollback: if group hydration, member validation,
or partial-acceptance validation fails, none of the received batch's proposal
mutations survive.

---

## cached_redo_actions and the Redo Mechanism

### Design Principle

All state transitions are **forward-only**. There is no rewind logic. When a
game goes on-chain, the system either recognizes that the game coin is already
at the latest state, or it replays cached moves to advance to the latest state.
This is the "redo" mechanism.

### Lifecycle

`cached_redo_actions` on the `ChannelState` is a
`Vec<CachedRedoActions>` (defined in
`src/channel_state/types/potato.rs`) that stores data for unacknowledged
outgoing actions. Because a single batch can contain multiple moves and game
acceptances across different games, multiple entries may need to be redone
on-chain.

There are three kinds of cached entries:

- `**CachedSendMove`** — a move we sent but the opponent hasn't acknowledged.
Stores the move data, the puzzle hash it operates on (`match_puzzle_hash`),
and the post-move puzzle hash (`saved_post_move_last_ph`).
- `**CachedAcceptSettlement`** — a game acceptance we sent. Stores the game ID, puzzle
hash, live game state, and reward amounts. When the potato returns
(acknowledgment), `drain_cached_accept_settlements` emits `GameSettled` with
`outcome: accept_settlement` for each cached accept.
- `**ProposalAccepted**` — a proposal acceptance we sent. Stores the game ID.
Used during stale unroll handling to distinguish in-flight proposal accepts
(which get `EndedCancelled`) from fully established games (which get
`GameError`).

**Set** in `send_move_no_finalize` (moves) and
`send_accept_settlement_no_finalize` (accept settlements).

**Cleared** (selectively) when we receive the potato back:

- `CachedSendMove` entries are cleared in `verify_received_batch_signatures`
and `received_empty_potato` (the opponent's response acknowledges our moves).
- `ProposalAccepted` entries are also cleared on potato receive.
- `CachedAcceptSettlement` entries are **retained** across those clears and only drained
later by `drain_cached_accept_settlements` during `update_channel_coin_after_receive` or
clean shutdown, when `GameSettled` notifications are emitted.

### How Redo Works

When game coins are created after an unroll, `set_state_for_coins` checks each
coin's puzzle hash against all entries in `cached_redo_actions`:

1. **Coin PH matches a `CachedSendMove.match_puzzle_hash`**: The game coin is at
   the state our cached move operates on. A redo is needed to replay that move
   on-chain. Set `our_turn = true`.
2. **Coin PH == `last_referee_puzzle_hash`**: The game coin is at the latest
   state. No redo needed. Set `our_turn` based on `is_my_turn()`.
3. **Neither matches**: Error condition (game disappeared or unexpected state).

**Why `match_puzzle_hash` is the right value.** When a player makes a move via
`send_potato_move`, the `puzzle_hash_for_unroll` in the move result is the
curried referee puzzle hash of the **pre-move** state (computed from
`self.spend_this_coin()` before updating the referee). This value is stored as
`match_puzzle_hash` in `cached_redo_actions`. It corresponds to the puzzle
hash the unroll coin would create for this game coin if the unroll resolved
at the state *before* our move — which is exactly the puzzle hash that
appears on-chain in both the non-stale redo case and in a stale unroll at
that state.

Multiple games may need redos simultaneously if the batch contained moves for
different games. Redo transactions are emitted in parallel during
`finish_on_chain_transition`, with a `PendingMoveSavedState` entry inserted into
the handler's `pending_moves` map for each one.

**In-flight proposal acceptances** (`ProposalAccepted` entries in
`cached_redo_actions`) don't trigger a redo — if the game coin never
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
(adding to `cached_redo_actions`) but the peer's response — which would normally
clear the entries — arrives *after* the disconnect, the entries remain.
This is expected and correct: the stale cache causes `set_state_for_coins` to
detect that redos or cancellations are needed, replaying our unacknowledged
moves and timeout claims on-chain.

### Redo and User-Queued Moves Can Coexist

There are two sources of on-chain actions after `go_on_chain`:

- **Redo actions** (from `cached_redo_actions`): moves or accept settlements we
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

When `cheat()` is called on a `GameSession`:

1. A `GameAction::Cheat(game_id, mover_share, entropy)` is queued internally.
2. Like a normal `Move`, the `Cheat` action is deferred until it is the
  player's turn.
3. When processed (off-chain in `drain_queue_into_batch` or on-chain in
  `do_on_chain_action`), the handler atomically:
  - Enables cheating on the `ChannelState`'s referee for that game,
  substituting `0x80` (nil) as the move bytes and the given `mover_share`
  (which becomes the victim's share on timeout).
  - Executes the move through the normal referee path. The referee bypasses
  validation and produces a game-move with the fake data.
4. The resulting move is sent to the opponent, who detects the invalid data and
  can slash on-chain.

### Outcomes


| Scenario                        | Notification (cheater)                                       | Notification (victim)                                         |
| ------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- |
| Opponent detects and slashes    | `GameSettled { outcome: opponent_slashed_us, … }`             | `GameSettled { outcome: slashed_opponent, … }`                |
| Opponent fails to slash in time | `GameSettled { outcome: opponent_timed_out, … }`             | `GameSettled { outcome: opponent_cheated, … }`                |


**Key code:**

- `src/game_session.rs` — `GameSession::cheat`
- `src/session_phases/types.rs` — `GameAction::Cheat`
- `src/session_phases/mod.rs` — `cheat_game`, `drain_queue_into_batch` (Cheat arm)
- `src/session_phases/on_chain.rs` — `do_on_chain_action` (Cheat arm)
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


**Conflicting mempool spends are the one exception to "this can only be a bug."**
Two *different* transactions spending the same coin is perfectly normal on a real
chain: it happens whenever both parties go on chain at once, a peer misbehaves, or
the two sides are temporarily disconnected, and the chain resolves it for free
(only one spend of a coin can confirm). Strict mode still fails fast on it because
an *unexpected* conflict is usually a symptom worth investigating, and failing at
the point of conflict is far easier to debug than a divergent outcome many blocks
later. (Resubmitting an *identical* bundle is not a conflict — the mempool
de-duplicates by fingerprint.) The genuine bug this guards against is a single
party putting two different competing transactions on chain itself (e.g. holding a
good clean-shutdown and *also* unrolling). When a test legitimately drives both
sides to spend the same coin, it must designate a winner by nerfing the loser; see
[Strict Mode](SIMULATOR_TESTING.md#strict-mode-why-double-submission-fails-tests)
in the simulator testing reference.

**Key code:** `src/simulator/mod.rs` — `push_transactions`

---

## Test Infrastructure

### Debug Game

The debug game (`b"debug"`) is a minimal game used for tests that need precise
control over `mover_share`. It is registered in the Rust game table for test
infrastructure only, not as a user-facing game. Its core handler/curry wiring
lives in `src/test_support/debug_game.rs`, while `DebugGameTestMove::new(mover_share, slash)`
is defined in `src/simulator/tests/session_phases_sim.rs`.

### Simulation Test Actions

Tests drive the simulation loop with a sequence of `GameAction` values defined
in `src/test_support/sim_script.rs`. The current action catalog, trigger semantics,
two-phase `AcceptProposal` behavior, and stall-detection notes live in
`SIMULATOR_TESTING.md`.

**Key code:**

- `src/test_support/debug_game.rs` — `DebugGameHandler` and debug game registration
- `src/simulator/tests/session_phases_sim.rs` — `DebugGameTestMove` and integration scenarios
- `src/test_support/sim_script.rs` — `GameAction` enum (sim-tests variant)
- `SIMULATOR_TESTING.md` — simulator testing reference

---

## Invariant Assertions: `game_assert!` / `game_assert_eq!`

These macros are the primary tool for the codebase's
[fail-fast philosophy](OVERVIEW.md#design-philosophy-fail-fast): when an internal
invariant is violated, surface it immediately instead of adding a
belt-and-suspenders backstop that tolerates the broken state.

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
