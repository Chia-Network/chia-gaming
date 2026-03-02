# Architecture: Chia Gaming State Channels

This document explains the architecture of the `chia_gaming` codebase — a system
for playing two-player games over Chia state channels. It is written to give a
future reader (human or AI) the conceptual foundation needed to work on this code.

For debugging and testing operational guidance, see `DEBUGGING_GUIDE.md`.

## Table of Contents

- [Overview](#overview)
- [State Channels: The Core Idea](#state-channels-the-core-idea)
- [Coin Hierarchy](#coin-hierarchy)
  - [Channel Coin](#channel-coin)
  - [Unroll Coin](#unroll-coin)
  - [Game Coin (Referee)](#game-coin-referee)
- [The Potato Protocol](#the-potato-protocol)
- [Game Proposals](#game-proposals)
- [Off-Chain Game Flow](#off-chain-game-flow)
- [Going On-Chain: Dispute Resolution](#going-on-chain-dispute-resolution)
- [Clean Shutdown (Advisory)](#clean-shutdown-advisory)
- [Preemption](#preemption)
- [Stale Unroll Handling](#stale-unroll-handling)
- [The Referee](#the-referee)
  - [Referee Puzzle Args](#referee-puzzle-args)
  - [On-Chain Referee Actions](#on-chain-referee-actions)
  - [Referee State Model](#referee-state-model)
  - [Reward Payout Signatures](#reward-payout-signatures)
  - [previous_validation_info_hash and the Initial State](#previous_validation_info_hash-and-the-initial-state)
- [Calpoker: The Reference Game](#calpoker-the-reference-game)
  - [Commit-Reveal Protocol](#commit-reveal-protocol)
  - [On-Chain Steps (a through e)](#on-chain-steps-a-through-e)
- [Code Organization](#code-organization)
- [Key Types](#key-types)
- [Timeouts](#timeouts)
- [Peer Disconnect Invariant](#peer-disconnect-invariant)
- [cached_last_actions and the Redo Mechanism](#cached_last_actions-and-the-redo-mechanism)
- [ResyncMove and the Simulation Loop](#resyncmove-and-the-simulation-loop)
- [On-Chain Game State Tracking (our_turn)](#on-chain-game-state-tracking-our_turn)
- [UX Notifications](#ux-notifications)
- [Accept-Timeout Lifecycle](#accept-timeout-lifecycle)
- [Simulator Strictness](#simulator-strictness)
- [Test Infrastructure](#test-infrastructure)

---

## Overview

Two players fund a **state channel** on the Chia blockchain. Once the channel is
open, they play games entirely off-chain, exchanging signed messages. The
blockchain is only needed in two cases:

1. **Clean shutdown** — both players agree the channel is done, and they split
   the funds.
2. **Dispute** — one player misbehaves (sends an invalid move, goes offline,
   etc.), and the other player forces the game state on-chain for the blockchain
   to resolve.

This design means most games never touch the blockchain at all. The on-chain
path exists purely as a **threat** that keeps both players honest: if you cheat,
your opponent can prove it on-chain and take your money.

---

## State Channels: The Core Idea

The channel coin must be spent by **mutual agreement** of both parties — they
always sign it getting spent to an **unroll coin**.

An unroll coin has a **sequence number** and knowledge of what it will be spent
to if it manages to unroll to its state (i.e., if nobody challenges it before
the timeout).

Sequence numbers enable **preemption**: the opposing player can challenge an
unroll attempt by presenting a **later sequence number**, which immediately
causes a spend to a more up-to-date state. This prevents a player from trying
to unroll to a stale (advantageous-to-them) state.

The key insight: every off-chain move produces a new mutually-signed unroll
commitment with an incremented sequence number. Both players always hold the
latest signed state. If either player tries to cheat by publishing an old state,
the other can preempt with the newer one.

---

## Coin Hierarchy

```
Funding coins (one per player)
    │
    ▼  (both players co-sign)
Channel Coin ── 2-of-2 multisig (aggregate channel keys)
    │
    ▼  (spend to unroll)
Unroll Coin ── unroll_puzzle.clsp (sequence number, default conditions)
    │
    ▼  (timeout / preemption)
┌───┴───────────────────────┐
│                           │
▼                           ▼
Reward Coins (balances)     Game Coins ── referee puzzle (curried with RefereePuzzleArgs)
                                │
                                ▼  (move / timeout / slash)
                            New Game Coin or Payout Coins
```

### Channel Coin

- Created from both players' funding transactions.
- Controlled by a **2-of-2 aggregate signature** — neither player can spend it
  alone.
- Every off-chain state update produces a new signed commitment for how this
  coin would be spent (to the unroll coin). The actual coin on-chain doesn't
  move until someone initiates a dispute or shutdown.
- On clean shutdown, both players agree to spend the channel coin directly to
  payout coins (no unroll needed).

**Key code:** `src/channel_handler/types/channel_coin.rs`,
`ChannelHandler` in `src/channel_handler/mod.rs`

### Unroll Coin

The unroll coin implements the **optimistic rollback** mechanism:

- **Curried parameters:** `SHARED_PUZZLE_HASH`, `OLD_SEQUENCE_NUMBER`,
  `DEFAULT_CONDITIONS_HASH`
- **Timeout path** (no challenge): After `unroll_timeout` blocks pass, the
  default conditions are revealed and applied. These conditions create the game
  coins and reward coins reflecting the last agreed state.
- **Preemption path** (challenge): The opponent provides a solution with a
  **higher sequence number** (with correct parity). The unroll puzzle verifies
  the new sequence number is greater than the old one and has the right parity
  bit, then applies the challenger's conditions instead.

**Parity rule.** Each player only ever sends half-signed states of one parity
to the opponent (based on `started_with_potato`), so each player can only
fully sign states of the parity they *receive*. The unroll puzzle requires
that a preempting state has the opposite parity from the published unroll.
This prevents a rollback attack: without the rule, a malicious player could
publish a very old unroll and immediately preempt it with a less-old-but-still-
stale state of the same parity — one they can fully sign — effectively rolling
back to a favorable earlier state. The parity constraint means you cannot both
publish and preempt; only your opponent can preempt your unroll.

**Key code:** `src/channel_handler/types/unroll_coin.rs`,
`clsp/unroll/unroll_puzzle.clsp`

### Game Coin (Referee)

Each active game in the channel becomes a separate **game coin** when forced
on-chain. The game coin's puzzle is the **referee puzzle** curried with the
current game state (`RefereePuzzleArgs`).

The referee enforces game rules on-chain:
- **Move:** Advance the game state (creates a new game coin with updated args)
- **Timeout:** If the current mover doesn't act within `game_timeout` blocks,
  the waiter claims the pot based on `mover_share`
- **Slash:** If a previous move was provably invalid, the opponent can slash and
  take the funds

**Key code:** `src/referee/mod.rs`, `src/referee/types.rs`,
`clsp/referee/onchain/referee.clsp`

---

## The Potato Protocol

Off-chain communication uses a **"potato"** — a turn-taking token that grants
the holder permission to update state. Only the player holding the potato can:
- Propose a new game
- Accept or cancel a game proposal
- Make a move
- Accept a game result (accept_timeout)
- Initiate clean shutdown

When a player wants to act but doesn't have the potato, they **request** it.
The other player passes it (along with any pending state updates) in their next
message.

Each potato pass includes a re-signed unroll commitment, ensuring both players
always have the latest co-signed state.

The potato prevents race conditions: since only one player can update state at a
time, there's no ambiguity about move ordering.

### Batch Protocol

Every potato pass is a single `PeerMessage::Batch` containing:

1. **`actions: Vec<BatchAction>`** — one or more game operations to apply
   sequentially:
   - `ProposeGame` — propose a new game
   - `AcceptProposal` — accept a pending game proposal
   - `CancelProposal` — cancel a pending proposal
   - `Move` — make a game move
   - `AcceptTimeout` — accept a game result (end game)

2. **`signatures: PotatoSignatures`** — one set of signatures covering the final
   channel state after all actions in the batch have been applied.

3. **`clean_shutdown: Option<...>`** — optional clean shutdown initiation,
   always positioned logically after all other actions.

The receiver processes actions sequentially and rejects the entire batch if any
action fails validation. The sender is responsible for ordering actions correctly
(e.g., game acceptances before proposal acceptances to ensure funds are available).

Only one move per game is allowed per batch, enforced by the existing turn-taking
rules (you can't move on your opponent's turn).

The `current_state_number` increments once per batch, not per action.

### Local Action Queueing

When a local action is requested (move, proposal, accept, etc.), it follows a
unified pattern:

1. The action is placed on an internal queue
2. `flush_or_request_potato` is called:
   - If we hold the potato: drain all queued actions into a single batch and send
   - If we don't hold the potato: send a `RequestPotato` message

This ensures that multiple user actions between potato receives are
automatically batched together.

### Non-Potato Messages

`PeerMessage::Message` (for in-game readable messages) remains a separate type
that does not carry the potato and can be sent at any time.

**Key code:** `src/potato_handler/mod.rs` (`PotatoHandler`, `PotatoState`)

### Handshake

Before play begins, the two players execute a multi-step handshake
(steps A through F) to:
1. Exchange public keys (channel keys, unroll keys, referee keys)
2. Agree on channel parameters (timeout, amounts)
3. Co-sign the initial channel coin creation
4. Reach `ChannelState::Finished`

**Key code:** `src/potato_handler/handshake.rs`, `src/potato_handler/start.rs`

---

## Game Proposals

Games are initiated through a propose/accept flow:

1. **Propose:** The potato holder sends a `BatchAction::ProposeGame` containing
   the `GameStart` descriptor (game type, contributions, timeout, parameters).
   Both sides record the game in `pre_game_ids` as a pending proposal. The
   receiver gets a `GameProposed` notification; the proposer does not (the
   proposer tracks the proposal via the `propose_game` API call itself).

2. **Accept:** The receiver (or proposer on a subsequent potato) sends
   `BatchAction::AcceptProposal`. Both sides instantiate the referee and game
   handler, moving the game into `live_games`. Both receive
   `GameProposalAccepted`.

3. **Cancel:** Either side can send `BatchAction::CancelProposal` to withdraw.
   Both receive `GameProposalCancelled`. If a channel goes on-chain while a
   proposal is still pending, proposals not reflected in the unroll are
   automatically cancelled.

Multiple proposals and acceptances can be batched in a single potato pass.
Acceptances should be ordered before proposals in the batch to ensure funds
freed by accepted games are available for new proposals.

### Race Conditions in Proposal Lifecycle

Because cancel and accept requests are queued and only sent when the potato is
held, several race conditions can occur:

- **Stale cancel:** A player queues `CancelProposal` but the proposal was
  already accepted or cancelled by the peer before the cancel is sent. The
  cancel is silently discarded — `drain_queue_into_batch` checks
  `is_game_proposed()` and skips the cancel if the proposal is gone.

- **Stale accept:** A player queues `AcceptProposal` but the proposal was
  already cancelled by the peer before the accept is sent. A `GameCancelled`
  notification is emitted to inform the acceptor that the game will not happen.

- **Insufficient balance on accept:** When the potato arrives and
  `drain_queue_into_batch` processes a `QueuedAcceptProposal`, it pre-checks
  both players' available balances. If either player's contribution exceeds
  their `out_of_game_balance`, an `InsufficientBalance` notification is emitted,
  the proposal is automatically cancelled (`CancelProposal` is sent to the
  peer and `GameProposalCancelled` is emitted locally), and the accept is
  skipped. `InsufficientBalance` is a terminal condition for the accept-call
  invariant.

### WASM Accept-and-Move Convenience

The WASM layer exposes an `accept_proposal_and_move` function that atomically accepts
a proposal and makes the first move. Internally this translates into two
distinct `BatchAction`s (`AcceptProposal` followed by `Move`) in the same
batch.

**Key code:** `src/potato_handler/mod.rs` — `propose_game`, `accept_proposal`,
`cancel_proposal`; `wasm/src/mod.rs` — `accept_proposal_and_move`

---

## Off-Chain Game Flow

Once the channel is open:

```
1. Player proposes a game (BatchAction::ProposeGame)
   → queued and sent with the next potato pass

2. Other player accepts the proposal (BatchAction::AcceptProposal)
   → both sides instantiate referee + game handler

3. Potato holder makes a move (BatchAction::Move)
   → signs the move, updates the unroll commitment, passes potato

4. Other player receives potato, processes move via referee
   → validates the move, updates their own state
   → when ready, makes their move and passes potato back

5. Repeat until game ends

6. Potato holder calls accept_timeout (BatchAction::AcceptTimeout)
   → balances are updated, game moves to pending_accept_timeouts
   → when the potato comes back, WeTimedOut fires for the accepter
```

Each batch increments the `state_number` once and produces a new signed unroll
commitment. The `ChannelHandler` tracks `live_games`, `pending_accept_timeouts`,
player balances (`my_allocated_balance`, `their_allocated_balance`), and the
current `state_number`. See [Accept-Timeout Lifecycle](#accept-timeout-lifecycle) for details
on what happens when accept_timeout hasn't been confirmed before going on-chain.

---

## Going On-Chain: Dispute Resolution

When something goes wrong (opponent offline, invalid move detected, explicit
`GoOnChain` action), the flow is:

### Unified Path

A key design principle is that **self-initiated and opponent-initiated on-chain
transitions follow the same code path**. When a player calls `go_on_chain`, it
submits the pre-signed channel coin spend (`hs.spend`) and sets a flag to stop
sending peer messages — but from that point on, the actual state machine
progression is driven entirely by **coin-watching events**. The player detects
its own channel coin spend the same way it would detect the opponent's: by
observing the coin disappear from the blockchain. This means there is no
separate "I started this" vs "they started this" logic for the state
transitions themselves.

### Step 1: Channel → Unroll

`go_on_chain` submits the single `SpendBundle` stored in `hs.spend`. This
spend is maintained by `update_channel_coin_after_receive` on every potato
exchange, so it always reflects the latest co-signed state. The spend creates
the unroll coin on-chain.

When the channel coin spend is detected (by either player), `ChannelCoinSpent`
is emitted as a notification and the state number of the unroll is extracted
from the on-chain conditions.

### Step 2: Preempt or Wait

The player compares the on-chain unroll state number against their own latest
state to decide whether to preempt or wait for the timeout path (see
[Preemption](#preemption)). Both outcomes produce the same result: the unroll
coin is spent, creating game coins and reward coins.

When the unroll coin spend is detected, `UnrollCoinSpent` is emitted.

### Step 3: Forward-Align State

`ChannelHandler::set_state_for_coins` matches each created game coin's puzzle
hash against known states. It searches both `live_games` and
`pending_accept_timeouts` (see [Accept-Timeout Lifecycle](#accept-timeout-lifecycle) below). All
state tracking is **forward-only** — there is no rewind logic. Two cases:

1. **Coin PH matches `last_referee_puzzle_hash`** (the outcome/post-move PH):
   The game coin is at the latest known state. `our_turn` is set based on
   `is_my_turn()`. No redo needed.

2. **Coin PH matches a `cached_last_actions` entry's `match_puzzle_hash`**: The
   game coin is at the state *before* our cached move. A redo is needed to
   replay that move on-chain (see [Redo Mechanism](#cached_last_actions-and-the-redo-mechanism)).

Games that existed off-chain but don't match any created coin are reported as
`GameError` (these were accepted games that should have appeared on-chain).

### Step 4: Redo (if needed)

If the game coin landed at the pre-move state, `get_redo_action` returns a
`RedoMove` that replays the cached move on-chain. The redo uses the cached
move data and the actual on-chain coin ID to construct the transaction. After
the redo, the game is at the latest known state.

### Step 5: Accept-Timeout

Once all moves are replayed, `coin_timeout_reached` generates a timeout
transaction that ends the game and distributes funds based on `mover_share`.
Timeout transactions are submitted as soon as the `game_timeout` relative
timelock allows. The `WeTimedOut` notification is emitted only at this point
— not when accept_timeout is first called.

### Step 6: Clean Shutdown

After all games resolve, `CleanShutdownComplete` is emitted and the channel can
be closed.

**Key code:**
- `src/potato_handler/mod.rs` — `go_on_chain`, `handle_channel_coin_spent`,
  `finish_on_chain_transition`
- `src/potato_handler/on_chain.rs` — `OnChainPotatoHandler`
- `src/channel_handler/mod.rs` — `set_state_for_coins`,
  `accept_or_timeout_game_on_chain`, `game_coin_spent`

---

## Clean Shutdown (Advisory)

Clean shutdown is the cooperative channel closure path: both players agree to
spend the channel coin directly to reward coins, bypassing the unroll/game-coin
mechanism entirely.

### Why "Advisory"

A clean shutdown attempt is **advisory, not authoritative**. Both players
exchange messages agreeing to close and submit a clean shutdown transaction,
but a race condition exists: one player might simultaneously submit an unroll
transaction that spends the same channel coin. Only one of these conflicting
transactions can land on-chain.

Because of this race, the system **never blindly trusts** that a clean shutdown
succeeded. Instead, it always inspects the actual spend of the channel coin to
determine what really happened.

### State Machine

When the channel coin is detected as spent during a clean shutdown attempt, the
handler transitions to `CleanShutdownWaitForConditions` and requests the
puzzle and solution of the spent coin via `RequestPuzzleAndSolution`. The
spend conditions are then inspected:

1. **Clean shutdown succeeded:** The conditions contain a `CreateCoin` matching
   the expected reward coin (puzzle hash and amount). The handler transitions
   to `Completed` and emits `CleanShutdownComplete`.

2. **An unroll landed instead:** The conditions do not contain the expected
   reward coin (or, when the player's expected reward is zero, the conditions
   contain a `Rem` — which clean shutdown conditions never include). The
   handler falls through to the standard unroll handling path: extract the
   unroll coin from the conditions, determine preempt vs timeout, and proceed
   with on-chain dispute resolution.

### Fallback to Unroll Handling

When an unroll is detected during a clean shutdown attempt, the same code path
used for normal on-chain dispute resolution handles it. The
`handle_unroll_from_channel_conditions` helper (shared with the normal
`handle_channel_coin_spent` path) compares the on-chain state number against
the channel handler's current state to determine whether to preempt or wait
for timeout.

Since clean shutdown only happens when no games are active, the unroll
resolution creates only reward coins (no game coins). When
`finish_on_chain_transition` finds an empty game map, it skips the
`OnChainPotatoHandler` entirely and transitions directly to `Completed`.

### Key Code

- `src/potato_handler/mod.rs` — `handle_clean_shutdown_conditions`,
  `handle_unroll_from_channel_conditions`
- `src/potato_handler/handshake.rs` — `CleanShutdownWaitForConditions` variant

---

## Preemption

Preemption is the mechanism that prevents stale unrolls from succeeding. When
a player sees the channel coin being spent to an unroll coin, they compare the
on-chain sequence number against their own latest state:

| On-chain SN vs ours | Action | Explanation |
|---------------------|--------|-------------|
| On-chain < ours | **Preempt** (immediate) | Spend the unroll coin immediately with our higher SN and more up-to-date conditions |
| On-chain == ours | **Wait for timeout** | The unroll is at the state we expect; wait for it to resolve |
| On-chain > ours | **Error** | We've been hacked or something went very wrong |

Preemption is **immediate** — no timelock. This is by design: the preempting
player gets first-mover advantage because they're correcting an out-of-date
unroll. Timeouts require waiting for `unroll_timeout` blocks.

### After Preemption or Timeout

(See the **Parity rule** in the Unroll Coin section above for why only the
opponent can preempt a given unroll.)

Regardless of which path resolved the unroll coin, the result is the same: game
coins and reward coins are created. The game code then uses
`set_state_for_coins` to determine if a redo is needed (see Step 3 above).

**Key code:** `src/channel_handler/mod.rs` — `channel_coin_spent`,
`make_preemption_unroll_spend`

## Stale Unroll Handling

When preemption fails (e.g. the preemption transaction is not mined in time)
and the opponent's stale unroll succeeds via timeout, the system enters
**stale unroll handling** rather than treating it as an unrecoverable error.

### Staleness Detection

Staleness is determined by comparing the `on_chain_state` (the sequence number
extracted from the channel coin's `REM` conditions when the unroll coin was
created) against `last_received_state` (the sequence number at which we last
received the potato — i.e. the state we know the opponent acknowledged).

| Condition | Classification |
|-----------|----------------|
| `on_chain_state >= last_received_state` (or `== last_sent_state` without potato) | **Current or Redo** — use existing logic |
| `on_chain_state < last_received_state` | **Stale** — opponent unrolled to an outdated state |

The `last_received_state` field is maintained on `ChannelHandler`, initialized
to 0, and updated in `received_potato_verify_signatures` just before the state
number is incremented.  The special case of never having received a potato
(state 0 right after handshake) is handled by the initial value: state 0 is
never considered stale.

### Three-Way Dispatch in `finish_on_chain_transition`

When the unroll coin is spent and conditions are available, `finish_on_chain_transition`
dispatches based on the classification above:

1. **Current state** (`on_chain_state` matches our latest state): All games
   are assumed active at their current state.  Pending proposal acceptances
   are assumed to have gone through.  The normal `set_state_for_coins` path
   applies.

2. **Redo state** (`on_chain_state == last_received_state` and we don't have
   the potato): Exactly one unacknowledged send is outstanding.  The normal
   `set_state_for_coins` path applies, and `get_redo_action` publishes
   on-chain transactions from `cached_last_actions`.  Pending proposal
   acceptances are cancelled.

3. **Stale state** (`on_chain_state < last_received_state`):
   - An `OpponentStaleUnroll` notification is emitted, reporting the actual
     amount in our reward coin (found by scanning the unroll output conditions
     for our reward puzzle hash).
   - Each on-chain game coin is matched against live games strictly by puzzle
     hash **and** amount:
     - If `coin_ph == live_game.last_referee_puzzle_hash` and amounts match →
       game is alive at its current state.
     - If `coin_ph` matches a `cached_last_actions` entry's
       `match_puzzle_hash` for the same game and amounts match → game needs a
       redo move.
     - Otherwise → `GameError` for that game (unrecoverable).
   - Any live game or accepted proposal not found in the unroll outputs
     receives a `GameCancelled` notification.
   - The channel handler does **not** enter `Failed` state; remaining games
     continue on-chain.

### Notifications

| Notification | When |
|-------------|------|
| `OpponentStaleUnroll { our_reward, reward_coin }` | Always emitted when `is_stale` is true |
| `GameError { id, reason }` | Per-game, when a stale game coin can't be matched |
| `GameCancelled { id }` | Per-game, when an accepted game is absent from stale outputs |

### Key Invariant: `match_puzzle_hash`

When a player makes a move via `send_potato_move`, the `puzzle_hash_for_unroll`
in the move result is the curried referee puzzle hash of the **pre-move** state
(computed from `self.spend_this_coin()` before updating the referee).  This
value is stored as `match_puzzle_hash` in `cached_last_actions`.  It matches
the puzzle hash that an unroll at the pre-move state would create for that
game coin — which is exactly the puzzle hash that appears in an opponent's
stale unroll at that state.

**Key code:** `src/potato_handler/mod.rs` — `finish_on_chain_transition`,
`src/channel_handler/mod.rs` — `set_state_for_coins`, `get_redo_action`

---

## The Referee

The referee is the on-chain puzzle that enforces game rules. Each game coin is
curried with `RefereePuzzleArgs` that encode the full game state.

### Referee Puzzle Args

```rust
RefereePuzzleArgs {
    mover_pubkey,           // public key of the player whose turn it is
    waiter_pubkey,          // public key of the player waiting
    timeout,                // blocks before timeout can be claimed
    amount,                 // total amount in the game
    game_move: GameMoveDetails {
        basic: GameMoveStateInfo {
            move_bytes,     // the actual move data
            max_move_size,  // maximum allowed move size
            mover_share,    // how much the mover gets if timeout occurs
        },
        validation_info_hash,  // hash of the validation program + state
    },
    previous_validation_info_hash,  // hash from the prior move (None for initial state)
    validation_program,     // the chialisp program that validates moves
    nonce,                  // unique identifier for this game instance
    referee_coin_puzzle_hash, // puzzle hash of the referee puzzle itself
}
```

Players are identified by **public keys** (not puzzle hashes) in the referee
args. The reward destination puzzle hashes are not curried into the referee —
instead they are revealed at timeout via `AGG_SIG_UNSAFE` (see
[Reward Payout Signatures](#reward-payout-signatures)).

### On-Chain Referee Actions

The referee puzzle (`referee.clsp`) accepts three types of solutions:

1. **Timeout** (`args = (mover_payout_ph, waiter_payout_ph)`):
   - Requires `ASSERT_HEIGHT_RELATIVE >= TIMEOUT`
   - Creates a coin of `MOVER_SHARE` to `mover_payout_ph` (if nonzero)
   - Creates a coin of `AMOUNT - MOVER_SHARE` to `waiter_payout_ph` (if nonzero)
   - Requires `AGG_SIG_UNSAFE` from each player for their respective
     `"x" || payout_ph` (only for nonzero shares)
   - Used when the current mover fails to act in time
   - **Both players' reward coins are created in a single transaction** —
     whichever player submits the timeout spend creates coins for both sides

2. **Move** (`args = (new_move, infohash_c, new_mover_share, mover_puzzle, solution)`):
   - Runs the mover's puzzle to authorize the spend
   - Creates a new game coin with swapped mover/waiter and updated state
   - Requires `ASSERT_BEFORE_HEIGHT_RELATIVE` (must move before timeout)

3. **Slash** (`args = (previous_state, previous_validation_program, evidence, mover_payout_ph)`):
   - Proves a previous move was invalid by running the validation program
   - If validation raises, the slash succeeds: creates `CREATE_COIN mover_payout_ph AMOUNT`
     (the slasher takes the full game amount)
   - Requires `AGG_SIG_UNSAFE MOVER_PUBKEY ("x" || mover_payout_ph)` — the same
     pre-signed payout authorization used by timeouts, so no additional signing
     is needed at slash time

### Referee State Model

The referee maintains two sets of args at all times:

- **`args_for_this_coin()`** (`create_this_coin` field) — the args that were
  used to curry the puzzle of the **current** coin. This is what
  `on_chain_referee_puzzle_hash()` computes.
- **`spend_this_coin()`** (`spend_this_coin` field) — the args that will be
  used to curry the puzzle of the **next** coin (created when this coin is
  spent). This is what `outcome_referee_puzzle_hash()` computes.

**Off-chain**, these stay in sync because the unroll commitment is updated at
each move.

**On-chain after moves**, the actual coin's puzzle hash may correspond to
`outcome_referee_puzzle_hash()` rather than `on_chain_referee_puzzle_hash()`.
This happens because on-chain moves create coins with the "next state" args,
but the referee's internal `create_this_coin` may still reflect the "unroll
state" args.

The `get_transaction_for_timeout` function handles this by checking the coin's
actual puzzle hash against both accessors and using whichever matches.

`last_referee_puzzle_hash` on `LiveGame` always tracks
`outcome_referee_puzzle_hash()` — the post-move puzzle hash. This is the
expected "latest state" puzzle hash used by `set_state_for_coins` to determine
whether the game coin is at the latest state or needs a redo.

### Reward Payout Signatures

Reward destination puzzle hashes are **not** curried into the referee puzzle.
Instead, they are revealed at timeout as solution arguments, and each player
proves they authorized their payout destination via `AGG_SIG_UNSAFE`.

**How it works:**

1. During the **handshake**, each player signs `"x" || reward_puzzle_hash`
   (a 33-byte message: the ASCII byte `'x'` followed by their 32-byte reward
   puzzle hash) and sends the signature to the other player.

2. The `RMFixed` struct stores both `reward_puzzle_hash` (ours) and
   `their_reward_puzzle_hash` along with `their_reward_payout_signature`.

3. When a **timeout** is submitted, the solution provides both payout puzzle
   hashes. The referee puzzle emits `AGG_SIG_UNSAFE` conditions requiring the
   mover's signature on `"x" || mover_payout_ph` and the waiter's signature
   on `"x" || waiter_payout_ph` (only for nonzero shares).

4. `get_transaction_for_timeout` in `src/referee/mod.rs` assembles the
   aggregate signature:
   - If our share is nonzero: sign our own `reward_puzzle_hash` with our
     private key
   - If their share is nonzero: include the pre-exchanged
     `their_reward_payout_signature`
   - Shares of zero are omitted from both the conditions and the aggregate
     signature

This design means reward puzzle hashes don't need to be curried into every
game coin — they're only revealed once, in the final timeout or slash spend.

Both players' reward payout signatures are **cached** in `RMFixed` at game
creation time: `my_reward_payout_signature` (signed by us) and
`their_reward_payout_signature` (received during handshake). This avoids
redundant BLS signing during timeout and slash construction — the cached
signatures are simply aggregated into the spend bundle.

The slash path also uses `AGG_SIG_UNSAFE` with the same `"x" || payout_ph`
format, so the pre-exchanged reward signature covers both timeout and slash
payouts.

**Key code:** `src/common/standard_coin.rs` — `sign_reward_payout`,
`reward_payout_message`, `verify_reward_payout_signature`;
`src/referee/types.rs` — `RMFixed` (caches both signatures)

### previous_validation_info_hash and the Initial State

`RefereePuzzleArgs` contains a `previous_validation_info_hash` field. For
**on-chain** use (stored in state, used for slash evidence), this is always
`Some(hash)`. However, some game validators (e.g., the debug game) expect this
field to be `None` during the **initial** game state when validating off-chain.

To handle this, `make_move` (in `my_turn.rs`) and `their_turn_move_off_chain`
(in `their_turn.rs`) construct **two** sets of puzzle args:

- `offchain_puzzle_args`: Has `previous_validation_info_hash = None` when the
  game state is `Initial`, used for running the off-chain validator.
- `rc_puzzle_args`: Always has `previous_validation_info_hash = Some(hash)`,
  used for on-chain state persistence via `accept_this_move` /
  `accept_their_move`.

**Key code:** `src/referee/mod.rs`, `src/referee/my_turn.rs`,
`src/referee/their_turn.rs`, `src/referee/types.rs`

---

## Calpoker: The Reference Game

Calpoker is a poker variant used as the primary test game. Two players are dealt
cards from a shared random deck and select hands through a commit-reveal
protocol that prevents either player from cheating.

### Commit-Reveal Protocol

The protocol ensures **fair randomness** — neither player can bias the card deal:

```
Step a: Alice → commit(preimage)          Alice commits to her randomness
Step b: Bob   → bob_seed                  Bob reveals his randomness
Step c: Alice → preimage + commit(salt‖discards)   Alice reveals hers; cards are derived
Step d: Bob   → bob_discards              Bob discards 4 cards
Step e: Alice → salt‖discards‖selects     Alice reveals her discards and selects
```

**Card derivation:** `cards = make_cards(sha256(preimage ‖ bob_seed ‖ amount))`.
Since Alice committed to her preimage before seeing Bob's seed, and Bob sent his
seed before seeing Alice's preimage, neither can influence the randomness.

**Card representation:** Integers 0–51 (`rank * 4 + suit`), called "mod-52"
format.

**Discard commitment:** Alice commits to her discards (with a salt) before seeing
Bob's discards. This prevents Alice from choosing discards strategically based on
what Bob discards.

**Hand evaluation:** After both players discard and select, final hands are
evaluated using `handcalc` (a chialisp hand evaluator). The player with the
better hand wins `mover_share` of the pot.

### On-Chain Steps (a through e)

Each step is a chialisp **validation program** that enforces the rules of that
step of the commit-reveal protocol:

| Step | Mover | Move | State After | Validates |
|------|-------|------|-------------|-----------|
| **a** | Alice (commits) | `sha256(preimage)` (32 bytes) | `alice_commit` | Move is exactly 32 bytes |
| **b** | Bob (seeds) | `bob_seed` (16 bytes) | `(alice_commit, bob_seed)` | Move is exactly 16 bytes |
| **c** | Alice (reveals) | `preimage ‖ sha256(salt‖discards)` (48 bytes) | `(new_commit, cards)` | `sha256(preimage) == alice_commit`; derives cards |
| **d** | Bob (discards) | `bob_discards` (1 byte) | `(bob_discards, cards, alice_commit)` | Valid discard bitmask (popcount = 4) |
| **e** | Alice (final) | `salt‖discards‖selects` (18 bytes) | Game over | `sha256(salt‖discards) == alice_commit`; valid popcounts; hand eval; correct split |

At step **e**, Bob can submit his card selections as **evidence** for a slash
if Alice misclaims the split.

**Key code:**
- `clsp/games/calpoker/onchain/a.clsp` through `e.clsp`
- `clsp/games/calpoker/calpoker_generate.clinc` — off-chain handlers
- `src/games/calpoker.rs` — Rust-side decoding

---

## Code Organization

### Core layers (bottom to top)

| Layer | Directory | Responsibility |
|-------|-----------|----------------|
| **Types & Utilities** | `src/common/` | `CoinString`, `PuzzleHash`, `Amount`, `Hash`, `AllocEncoder`, etc. |
| **Referee** | `src/referee/` | Per-game state machine: moves, timeouts, slashes |
| **Channel Handler** | `src/channel_handler/` | Channel/unroll/game coin management, balance tracking |
| **Potato Handler** | `src/potato_handler/` | Turn-taking protocol, handshake, on-chain transitions |
| **Peer Container** | `src/peer_container.rs` | Synchronous test adapter (`GameCradle` trait) |
| **Simulator** | `src/simulator/` | Block-level simulation for integration tests |

### Chialisp puzzles

| File | Purpose |
|------|---------|
| `clsp/unroll/unroll_puzzle.clsp` | Unroll coin: timeout vs challenge with sequence numbers |
| `clsp/referee/onchain/referee.clsp` | Game coin: move / timeout / slash enforcement |
| `clsp/games/calpoker/onchain/a-e.clsp` | Calpoker validation programs (one per protocol step) |
| `clsp/games/calpoker/calpoker_generate.clinc` | Off-chain calpoker handlers (Alice & Bob sides) |

### Test infrastructure

| File | Purpose |
|------|---------|
| `src/test_support/calpoker.rs` | Calpoker test registration and helpers |
| `src/test_support/debug_game.rs` | Debug game: minimal game with controllable `mover_share` |
| `src/simulator/tests/potato_handler_sim.rs` | Integration tests including notification suite |
| `src/test_support/peer/potato_handler.rs` | Test peer helper |
| `src/test_support/game.rs` | `GameAction` enum and simulation loop driver |
| `run-js-tests.sh` | Local JS/WASM integration test runner |

---

## Key Types

| Type | Location | Purpose |
|------|----------|---------|
| `CoinString` | `common/types/coin_string.rs` | Serialized coin: `parent_id ‖ puzzle_hash ‖ amount` |
| `PuzzleHash` | `common/types/puzzle_hash.rs` | 32-byte hash identifying a puzzle |
| `SpendBundle` | (chia types) | Collection of `CoinSpend`s forming an atomic transaction |
| `RefereePuzzleArgs` | `referee/types.rs` | All args curried into the referee puzzle |
| `Referee` | `referee/mod.rs` | Enum: `MyTurn` / `TheirTurn` |
| `ChannelHandler` | `channel_handler/mod.rs` | Manages channel state, unroll, live games |
| `PotatoHandler` | `potato_handler/mod.rs` | Turn-taking protocol over the wire |
| `OnChainPotatoHandler` | `potato_handler/on_chain.rs` | Drives on-chain dispute flow |
| `LiveGame` | `channel_handler/types/live_game.rs` | Wraps referee for a single active game |
| `UnrollCoin` | `channel_handler/types/unroll_coin.rs` | Unroll coin state and puzzle construction |
| `GameCradle` | `peer_container.rs` | Trait for synchronous game interaction (tests/UI) |
| `ValidationInfo` | `channel_handler/types/validation_info.rs` | Game validation program + state |
| `BatchAction` | `potato_handler/types.rs` | Peer-level batch action variants: `ProposeGame`, `AcceptProposal`, `CancelProposal`, `Move`, `AcceptTimeout` |
| `GameAction` | `potato_handler/types.rs` | Actions: `Move`, `AcceptTimeout`, `GoOnChain`, `CleanShutdown`, etc. |
| `SynchronousGameCradleState` | `peer_container.rs` | Per-peer mutable state: queues, flags, `peer_disconnected` |
| `OnChainGameState` | `channel_handler/types/on_chain_game_state.rs` | Per-game-coin tracking: `our_turn`, `puzzle_hash`, `accepted`, `pending_slash_amount`, `game_timeout` |
| `GameNotification` | `potato_handler/effects.rs` | Notifications to the UI: `ChannelCoinSpent`, `UnrollCoinSpent`, `WeTimedOut`, etc. |
| `Effect` | `potato_handler/effects.rs` | All side effects returned by handler methods (notifications, transactions, coin registrations) |

---

## Timeouts

There are three distinct timeouts in the system:

| Timeout | Purpose | Typical test value |
|---------|---------|-------------------|
| `channel_timeout` | Safety timeout for the watcher to detect channel coin spends. Not an on-chain timelock. | 100 blocks |
| `unroll_timeout` | On-chain `ASSERT_HEIGHT_RELATIVE` on the unroll coin. Controls how long the opponent has to preempt before the timeout path succeeds. Passed to `ChannelHandler::new`. | 5 blocks |
| `game_timeout` | On-chain `ASSERT_HEIGHT_RELATIVE` on each game coin (referee). Controls how long the current mover has before the opponent can claim a timeout. Stored in `OnChainGameState.game_timeout`. | 10 blocks |

**Important:** Game coins are registered with the watcher using their specific
`game_timeout` (from the referee), not the `channel_timeout`. The
`channel_timeout` is only used for watching channel and unroll coins.

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
- `PacketSender::send_message` silently drops outbound messages when
  `peer_disconnected` is true.
- `GameCradle::deliver_message` silently drops inbound messages when
  `peer_disconnected` is true.

After disconnection, all state updates come from coin-watching events. The
disconnected peer's own unroll transaction is detected via the same
`handle_channel_coin_spent` path that handles opponent-initiated unrolls (see
[Unified Path](#unified-path)).

The `initiated_on_chain` flag in `ChannelHandler` serves two purposes:
1. **Duplicate prevention**: Avoids submitting a second unroll transaction when
   we detect our own channel coin spend.
2. **Action queuing**: When `initiated_on_chain` is true, `do_game_action`
   places user-initiated actions (moves, accepts) directly on
   `game_action_queue` without executing them off-chain. Incoming peer messages
   are also dropped (`process_incoming_message` returns early). The queued
   actions are drained during `finish_on_chain_transition`, where `CleanShutdown`
   actions are discarded (on-chain path supersedes the clean shutdown path).
   Remaining actions (moves, accepts) are forwarded to the
   `OnChainPotatoHandler` for on-chain replay.

**Key code:** `src/peer_container.rs` — `go_on_chain`, `send_message`,
`deliver_message`

---

## cached_last_actions and the Redo Mechanism

### Design Principle

All state transitions are **forward-only**. There is no rewind logic. When a
game goes on-chain, the system either recognizes that the game coin is already
at the latest state, or it replays cached moves to advance to the latest state.
This is the "redo" mechanism.

### Lifecycle

`cached_last_actions` on the `ChannelHandler` is a `Vec` that stores data for
unacknowledged outgoing actions. Because a single batch can contain multiple
moves and game acceptances across different games, multiple entries may need to
be redone on-chain.

There are two kinds of cached entries:

- **`PotatoMove`** — a move we sent but the opponent hasn't acknowledged. Stores
  the move data, the puzzle hash it operates on (`match_puzzle_hash`), and the
  post-move puzzle hash (`saved_post_move_last_ph`).
- **`PotatoAcceptTimeout`** — a game acceptance we sent. Stores the game ID, puzzle
  hash, live game state, and reward amounts. When the potato returns
  (acknowledgment), `drain_cached_accept_timeouts` emits `WeTimedOut` for each cached
  accept.

**Set** in `update_cache_for_potato_send` (moves) and
`send_accept_timeout_no_finalize` (accept-timeouts).

**Cleared** (selectively) when we receive the potato back:
- `PotatoMove` entries are cleared in `verify_received_batch_signatures` and
  `received_empty_potato` (the opponent's response acknowledges our moves).
- `PotatoAcceptTimeout` entries are **retained** across those clears and only drained
  later by `drain_cached_accept_timeouts` during `update_channel_coin_after_receive` or
  clean shutdown, when `WeTimedOut` notifications are emitted.

### How Redo Works

When game coins are created after an unroll, `set_state_for_coins` checks each
coin's puzzle hash against all entries in `cached_last_actions`:

1. **Coin PH matches a `PotatoMove.match_puzzle_hash`**: The game coin is at
   the state our cached move operates on. Queue a `RedoMove` to replay it.
   Set `our_turn = true` (we need to submit the redo transaction).

2. **Coin PH == `last_referee_puzzle_hash`**: The game coin is at the latest
   state. No redo needed. Set `our_turn` based on `is_my_turn()`.

3. **Neither matches**: Error condition (game disappeared or unexpected state).

Multiple games may need redos simultaneously if the batch contained moves for
different games.

The `RedoMove` action is processed by `OnChainPotatoHandler::do_redo_move`,
which calls `get_transaction_for_move` using the cached move data and the
actual on-chain coin ID. After the redo succeeds, the game coin advances to the
latest state and normal play/timeout continues.

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
[Peer Disconnect Invariant](#peer-disconnect-invariant)). If we sent moves
(adding to `cached_last_actions`) but the peer's response — which would normally
clear the move entries — arrives *after* the disconnect, the entries remain.
This is expected and correct: the stale cache causes `set_state_for_coins` to
detect redos are needed, which replays our unacknowledged moves on-chain.

### Redo and User-Queued Moves Can Coexist

When a user calls `make_move` after `go_on_chain`, the move is placed directly
on `game_action_queue` without touching the potato or channel handler (since
`initiated_on_chain` is true). During `finish_on_chain_transition`, stale
`cached_last_actions` entries may also produce `RedoMove`s that are pushed to
the *front* of the queue. This is correct: the redos replay previous
unacknowledged moves, and the user's new move follows once the game state has
caught up. They are different moves for different game states.

---

## ResyncMove and the Simulation Loop

### What ResyncMove Does

`Effect::ResyncMove { id, state_number, is_my_turn }` is emitted by
`OnChainPotatoHandler::handle_game_coin_spent` when a game coin is spent with
a result that carries redo data. It is internal plumbing — not a UX
notification. `SynchronousGameCradle::process_effects` intercepts it before
`apply_effects` runs and stores `(state_number, is_my_turn)` in
`SynchronousGameCradleState.resync`, which the simulation loop reads via
`CradleResult.resync`.

### How the Simulation Handles It

In the simulation loop (`run_calpoker_container_with_action_list`), when
`result.resync` is `Some((_, true))` (i.e., it's our turn after the resync):

1. `can_move` is set to `true`
2. `move_number` walks backward to find the last `GameAction::Move` or
   `GameAction::Cheat` in the action list
3. **Player check**: If the found action is for a *different* player than the
   one whose resync triggered the walkback, `move_number` is restored to its
   original value. This prevents the simulation from trying to replay a stale
   move for the wrong player.

The player check is critical: without it, the simulation would find a Move for
player B when player A resynced, try to execute it, fail (wrong player's turn),
decrement `move_number`, and stall in an infinite loop.

### Test Design: Turn Alignment After Redo

Because the redo mechanism automatically replays the last cached move, tests
must account for the turn advancing one step beyond what the unroll produces.

For calpoker with `prefix_test_moves()` returning 5 moves (alternating
Alice/Bob):

| Moves taken | Last move by | After redo, whose turn | Use for |
|-------------|-------------|----------------------|---------|
| 2 (a,b) | Bob | Alice | `ForceDestroyCoin`, `OurTurnCoinSpentUnexpectedly` |
| 3 (a,b,c) | Alice | Bob | `Cheat(1)`, `ForceDestroyCoin` (opponent's turn) |
| 4 (a,b,c,d) | Bob | Alice | `Cheat(0)`, `AcceptTimeout(0)` |

When designing tests with `Cheat(N)` or `AcceptTimeout(N)`, ensure the number of
off-chain moves results in the correct player's turn after the redo completes.

---

## On-Chain Game State Tracking (our_turn)

The `OnChainPotatoHandler` maintains a `game_map: HashMap<CoinString,
OnChainGameState>` that tracks each game coin's state, including an `our_turn`
flag.

### How our_turn is Set

- **Initial game coin** (from unroll): Set by `set_state_for_coins`. If a redo
  is needed, `our_turn = true` (we need to submit the redo). Otherwise,
  `our_turn = is_my_turn()` based on the referee state.
- **After opponent's move** (`TheirSpend::Expected` or `TheirSpend::Moved`):
  `our_turn = true` — the opponent just moved, so now it's our turn.

### our_turn Correction for Pending Redos

In the `TheirSpend(Expected)` path of `handle_game_coin_spent`, the channel
handler's referee may be one step ahead of the on-chain state (because we
already processed the next move off-chain but the response was dropped). In
this case, `game_is_my_turn()` returns `false` (the referee thinks it is the
opponent's turn), but on-chain it is actually *our* turn to submit the redo.

When a redo is generated via `take_cached_move_for_game`, `our_turn` is set to
`true` to reflect the on-chain reality. Without this correction, a timeout on
the intermediate redo coin would emit `OpponentTimedOut` instead of
`WeTimedOut`, producing wrong notifications.

### How our_turn Determines Timeout Notifications

When `coin_timeout_reached` fires on a game coin:

```
if old_definition.our_turn →  GameNotification::WeTimedOut
else                        →  GameNotification::OpponentTimedOut
```

So the notification depends entirely on `our_turn` in the `game_map` entry for
the coin that timed out. Both players maintain independent `game_map`s, and
both should have complementary values of `our_turn` for the same game coin.

### Moves for Finished Games Are Discarded

When a game coin times out, the game is removed from `game_map` and
`live_games`. If a user-queued `Move` for that game is still on the
`game_action_queue`, it is discarded when popped: `do_on_chain_action` checks
`get_current_coin` and falls through to `next_action` if the game is gone, and
`do_on_chain_move` checks `my_move_in_game` — returning `None` (game absent)
causes a discard, while `Some(false)` (game alive, not our turn) causes a
requeue. This prevents stale moves from crashing or looping after a legitimate
timeout.

---

## UX Notifications

The UI layer receives events via the `ToLocalUI` trait callbacks. These include
both game lifecycle callbacks and `GameNotification` variants (delivered through
`game_notification`).

### Game Lifecycle Callbacks

| Callback | Parameters | Meaning |
|----------|------------|---------|
| `opponent_moved` | `id, state_number, readable, mover_share` | Opponent made a move; `mover_share` is their declared share. |
| `game_message` | `id, readable` | Informational message from the game (e.g., revealed data). |
| `going_on_chain` | `reason: &str` | We are automatically going on-chain due to an error. |
| `clean_shutdown_started` | (none) | Clean shutdown sequence has begun. |
| `clean_shutdown_complete` | `reward_coin_string` | Channel fully closed; optional reward coin. |

### Game Notifications

The `GameNotification` enum is the sole mechanism for reporting game outcomes to
the UI layer. All notifications are emitted as `Effect::Notification(...)` values
returned from the `PotatoHandler` and `OnChainPotatoHandler` methods.

**There is no separate `GameFinished` effect.** Terminal `GameNotification`
variants are the "game is done" signal — the frontend uses them to trigger UI
cleanup and game-over transitions.

### Proposal Notifications

| Notification | When | Meaning |
|--------------|------|---------|
| `GameProposed { id, my_contribution, their_contribution }` | Game proposal received from opponent | A new game has been proposed by the peer. Only fires for the receiver — the proposer does not get this notification. |
| `GameProposalAccepted { id }` | Proposal accepted by either side | The game is now live and play can begin |
| `GameProposalCancelled { id, reason }` | Proposal cancelled or invalidated | The proposal was cancelled explicitly, or automatically due to going on-chain |

### On-Chain Transition Notifications

| Notification | When | Meaning |
|--------------|------|---------|
| `ChannelCoinSpent` | Channel coin spend detected on-chain | The channel is being unrolled (by either player) |
| `UnrollCoinSpent { reward_coin }` | Unroll coin spend detected on-chain | Game coins and reward coins are now live; `reward_coin` is `Some(CoinString)` for our change/reward coin from the unroll, `None` if our balance is zero |
| `GoingOnChain { reason }` | Error detected in peer message | We are automatically going on-chain due to an error; `reason` describes what went wrong (e.g., invalid peer message, opponent requested clean shutdown while games are active) |

`ChannelCoinSpent` and `UnrollCoinSpent` fire regardless of who initiated the
unroll. A player who called `go_on_chain` will see `ChannelCoinSpent` when
their own transaction is mined, exactly as if the opponent had initiated it.

### Acceptance Notifications

| Notification | When | Meaning |
|--------------|------|---------|
| `InsufficientBalance { id, our_balance_short, their_balance_short }` | Accept attempted with insufficient funds | The potato holder tried to accept a proposal but one or both players' contributions exceed available balance. The proposal is automatically cancelled (`CancelProposal` sent to peer, `GameProposalCancelled` emitted locally). This is a terminal condition for the accept-call invariant. |

### Game Outcome Notifications (Terminal)

These are the terminal notifications — each signals that a game is finished.
The frontend should treat any of these as the "game ended" signal.

| Notification | When | Meaning |
|--------------|------|---------|
| `WeTimedOut { id, our_reward, reward_coin }` | Game resolved in our favor | Includes off-chain accept-timeout (fires when potato returns) and on-chain timeout; `our_reward` is the amount we received; `reward_coin` is `Some(CoinString)` when on-chain and reward is nonzero, `None` for off-chain resolution |
| `OpponentTimedOut { id, our_reward, reward_coin }` | Game resolved in opponent's favor | Includes receiving opponent's off-chain accept-timeout; `our_reward` is the amount we received; `reward_coin` is `Some(CoinString)` when on-chain and reward is nonzero, `None` for off-chain |
| `GameCancelled { id }` | Stale accept of already-cancelled proposal | Emitted when a queued `AcceptProposal` finds the proposal already gone. Post-acceptance game disappearance uses `GameError`, not `GameCancelled`. |
| `WeSlashedOpponent { id, reward_coin }` | Slash transaction confirmed | Opponent's illegal move was proven on-chain; `reward_coin` is the `CoinString` of the reward we received |
| `OpponentSlashedUs { id }` | Opponent slashed us | Our move was proven illegal on-chain |
| `OpponentSuccessfullyCheated { id, our_reward }` | Slash coin timed out | Opponent cheated and we failed to challenge in time; `our_reward` is the mover_share from their cheating move (what we actually ended up with) |
| `OpponentStaleUnroll { our_reward, reward_coin }` | Opponent's unroll resolved to an outdated state | Emitted when `on_chain_state < last_received_state`; `our_reward` is the amount in our change coin, `reward_coin` is the coin if nonzero. Individual games then get their own terminal notifications (still active, redo, or `GameError`). |
| `GameError { id, reason }` | A single game coin is in an unrecoverable state | Something went wrong with one game |
| `ChannelError { reason }` | The channel or unroll coin is unrecoverable | Everything is lost |

### Key Invariants

The system enforces four notification lifecycle invariants. All four hold even
through `ChannelError` — when the channel enters `Failed` state, cleanup
notifications (`GameProposalCancelled` for pending proposals, `GameError` for
live games) are emitted before `ChannelError`, ensuring every open item is
explicitly resolved.

1. **Proposal-sent invariant.** Every `propose_game` call yields exactly one
   `GameProposalAccepted` or `GameProposalCancelled` for the proposer. The
   `cancel_all_proposals()` call on every exit path (go-on-chain, clean
   shutdown, channel error) is the catch-all that ensures no proposal is left
   unresolved. Enforced by the simulation loop's post-test assertion.

2. **Proposal-received invariant.** Every `GameProposed` notification (received
   from the opponent) yields exactly one `GameProposalAccepted` or
   `GameProposalCancelled` for the receiver. Enforced by the simulation loop's
   post-test assertion.

3. **Accept-call invariant.** Every `AcceptProposal` call yields exactly one
   terminal game notification: `InsufficientBalance`, `GameCancelled` (stale
   accept where the proposal was already cancelled), `WeTimedOut`,
   `OpponentTimedOut`, `WeSlashedOpponent`, `OpponentSlashedUs`,
   `OpponentSuccessfullyCheated`, or `GameError`. Note:
   `InsufficientBalance` is terminal (it auto-cancels the proposal).
   Enforced by the simulation loop's post-test assertion.

4. **Post-acceptance invariant.** Every `GameProposalAccepted` notification
   yields exactly one terminal game notification: `WeTimedOut`,
   `OpponentTimedOut`, `WeSlashedOpponent`, `OpponentSlashedUs`,
   `OpponentSuccessfullyCheated`, or `GameError`. Note: `GameCancelled` is
   **not** in this list — once a proposal is accepted, it cannot be cancelled;
   any disappearance is a `GameError`. Enforced by the simulation loop's
   post-test assertion.

### Additional Design Rules

These are not lifecycle invariants but important rules enforced in the code:

- **Accept only on our turn.** Calling `accept_timeout()` when it is not our
  turn is an assert failure. Accept-timeout is an alternative to moving.

- **Accepted + opponent move is an untested path.** Since accept_timeout only
  happens on our turn, and only the mover can advance a game coin, the opponent
  cannot move on a coin where we already accepted. The `accept_proposal_and_move` API exists but has
  not been tested end-to-end; Calpoker's move direction may prevent it from
  triggering in practice. This path emits `GameError`.

- **No phantom game-map entries.** During the on-chain transition,
  `finish_on_chain_transition` filters out both our and the opponent's reward
  puzzle hashes from the created-coins list before calling
  `set_state_for_coins`. This prevents reward coins from being incorrectly
  matched to live games and generating spurious terminal notifications.

- **Three-way unroll dispatch.** After the unroll coin resolves,
  `finish_on_chain_transition` classifies the situation based on the on-chain
  state number vs. `last_received_state`:
  - **Current:** `on_chain_state >= last_received_state`.
  - **Redo:** `on_chain_state == last_received_state` and we don't have the
    potato.
  - **Stale:** `on_chain_state < last_received_state`.
  See [Stale Unroll Handling](#stale-unroll-handling) for details.

**Key code:** `src/potato_handler/effects.rs`, `src/potato_handler/mod.rs`
(`emit_failure_cleanup`)

---

## Accept-Timeout Lifecycle

Calling `accept_timeout()` off-chain does **not** immediately finalize the
game. The full lifecycle is:

### Off-Chain Accept-Timeout

1. `send_accept_timeout_no_finalize` moves the game from `live_games` to
   `pending_accept_timeouts` in the `ChannelHandler` and updates balances.
2. A `PotatoAcceptTimeout` entry is added to `cached_last_actions` storing the game ID
   and reward amounts.
3. The accept-timeout data is bundled into the next potato pass (batch).
4. When the potato comes back (acknowledgment), `drain_cached_accept_timeouts` processes
   the `PotatoAcceptTimeout` entries in `cached_last_actions`, emitting `WeTimedOut` for
   each accepted game. The opponent who receives the accept-timeout gets
   `OpponentTimedOut` immediately upon processing the batch.

Multiple game acceptances in a single batch each get their own `PotatoAcceptTimeout`
entry, and all fire `WeTimedOut` when the potato returns.

If the channel goes on-chain **before** the round-trip completes, the game
is still in `pending_accept_timeouts`. The `set_state_for_coins` function
searches both `live_games` and `pending_accept_timeouts` when matching game
coins, so accepted-but-unconfirmed games are correctly tracked on-chain.

On clean shutdown, any remaining `PotatoAcceptTimeout` entries in `cached_last_actions`
are drained, emitting `WeTimedOut` before the `CleanShutdownComplete`
notification.

### On-Chain Accept-Timeout

When a game is already on-chain and the player calls `AcceptTimeout(game_id)`:

1. `OnChainPotatoHandler` asserts it is our turn, then sets `accepted = true`
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

The key invariant: **`WeTimedOut` is never emitted at the time of the
accept_timeout call itself** — only when the game actually resolves (via potato round-trip,
on-chain timeout, or clean shutdown).

**Key code:**
- `src/channel_handler/mod.rs` — `send_accept_timeout_no_finalize`,
  `pending_accept_timeouts`, `drain_cached_accept_timeouts`
- `src/potato_handler/on_chain.rs` — `GameAction::AcceptTimeout`, `handle_game_coin_spent`,
  `coin_timeout_reached`

---

## Cheat Support

**This feature is for testing and demonstration purposes only.**

The `cheat(game_id, mover_share)` call submits a move containing illegal data
to the game, allowing tests and demos to exercise the slashing and timeout
paths. Cheating is a first-class action that flows through the normal
queue/redo pipeline — there is no separate "enable cheating" step.

### How It Works

When `cheat()` is called on a `GameCradle`:

1. A `GameAction::Cheat(game_id, mover_share, entropy)` is queued internally.
2. Like a normal `Move`, the `Cheat` action is deferred until it is the
   player's turn.
3. When processed (off-chain in `drain_queue_into_batch` or on-chain in
   `do_on_chain_action`), the handler atomically:
   - Enables cheating on the `ChannelHandler`'s referee for that game,
     substituting `0x80` (nil) as the move bytes and the given `mover_share`.
   - Executes the move through the normal referee path. The referee bypasses
     validation and produces a game-move with the fake data.
4. The resulting move is sent to the opponent, who detects the invalid data and
   can slash on-chain.

### Outcomes

| Scenario | Notification (cheater) | Notification (victim) |
|----------|------------------------|-----------------------|
| Opponent detects and slashes | `OpponentSlashedUs` | `WeSlashedOpponent` |
| Opponent fails to slash in time | `OpponentTimedOut` (with the cheat's `mover_share`) | `OpponentSuccessfullyCheated` |

### WASM Binding

`cheat(cid, id, mover_share)` — `cid` is the cradle ID, `id` is the game ID
hex string, and `mover_share` is the amount string. Parses and delegates to
`GameCradle::cheat`.

**Key code:**
- `src/peer_container.rs` — `SynchronousGameCradle::cheat`
- `src/potato_handler/types.rs` — `GameAction::Cheat`
- `src/potato_handler/mod.rs` — `cheat_game`, `drain_queue_into_batch` (Cheat arm)
- `src/potato_handler/on_chain.rs` — `do_on_chain_action` (Cheat arm)
- `wasm/src/mod.rs` — WASM `cheat` binding

---

## Simulator Strictness

The simulator (`src/simulator/mod.rs`) enforces several invariants that the
real blockchain would enforce, catching bugs early in tests:

| Check | Behavior |
|-------|----------|
| **Puzzle hash mismatch** | If a coin spend's puzzle hashes to a different value than the coin record's puzzle hash, the simulator **panics**. This catches incorrect puzzle reconstruction immediately. |
| **Aggregate signature verification** | All `AGG_SIG_ME` and `AGG_SIG_UNSAFE` conditions are collected and verified against the spend bundle's aggregate signature. Invalid signatures cause the transaction to be rejected (code 3). |
| **Relative timelock** | `ASSERT_HEIGHT_RELATIVE` is checked against the coin's creation height. Transactions submitted too early are rejected. |
| **Double-spend** | Attempting to spend a coin that doesn't exist (already spent or never created) is rejected. |
| **Balance** | Total input amounts must equal total output amounts plus reserve fees. |

**Key code:** `src/simulator/mod.rs` — `push_tx`

---

## Test Infrastructure

### Debug Game

The debug game (`b"debug"`, defined in `src/test_support/debug_game.rs`) is a
minimal game used for tests that need precise control over `mover_share`. A
`DebugGameTestMove::new(mover_share, slash)` creates a single-move game where
Alice moves and Bob must accept_timeout, with the specified `mover_share` split. This
avoids the complexity of Calpoker's commit-reveal protocol when testing
channel/on-chain mechanics.

### Simulation Test Actions

Tests drive the simulation loop with a sequence of `GameAction` values (defined
in `src/test_support/game.rs`):

| Action | Effect |
|--------|--------|
| `ProposeNewGame(player)` | Player proposes a new game |
| `GoOnChain(player)` | Player initiates on-chain transition |
| `AcceptTimeout(player)` | Player accepts the current game result |
| `WaitBlocks(n, players_bitmask)` | Advance `n` blocks; `players_bitmask` controls whose coin reports are backlogged (0 = nobody blocked, 1 = player 0 blocked, 2 = player 1 blocked, 3 = both blocked) |
| `NerfTransactions(player)` | Silently drop all outbound transactions for `player` |
| `UnNerfTransactions(replay)` | Stop dropping transactions; if `replay` is true, replay the backlog to the simulator; if false, discard it |
| `Cheat(player, mover_share)` | Queue a move with illegal data and the specified `mover_share` (see [Cheat Support](#cheat-support)) |
| `ForceDestroyCoin(player)` | Inject a fake coin deletion to test error handling |
| `CleanShutdown(player, conditions)` | Initiate clean channel shutdown |
| `ForceUnroll(player)` | Submit a unroll transaction using the player's cached spend info, bypassing state checks. Simulates a malicious peer unrolling after agreeing to clean shutdown. |
| `AcceptProposal(player)` | Player accepts a pending game proposal |
| `SaveUnrollSnapshot(player)` | Save the player's current `ChannelCoinSpendInfo` for later use by `ForceStaleUnroll` |
| `ForceStaleUnroll(player)` | Submit an unroll using a previously saved snapshot (from `SaveUnrollSnapshot`), creating an outdated unroll on-chain |
| `NerfMessages(player)` | Silently drop all outbound peer messages for `player` |
| `UnNerfMessages` | Stop dropping peer messages |

`NerfTransactions` is particularly useful for testing asymmetric scenarios —
e.g., one player's unroll transaction gets dropped (simulating network issues)
while the other player proceeds normally. Multiple players can be nerfed
simultaneously (the implementation uses a bitmask).

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
- `src/test_support/debug_game.rs` — `DebugGameHandler`, `DebugGameTestMove`
- `src/test_support/game.rs` — `GameAction` enum (sim-tests variant)
- `src/simulator/tests/potato_handler_sim.rs` — integration test suite
