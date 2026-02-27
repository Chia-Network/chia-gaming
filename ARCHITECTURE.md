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
- [Off-Chain Game Flow](#off-chain-game-flow)
- [Going On-Chain: Dispute Resolution](#going-on-chain-dispute-resolution)
- [Clean Shutdown (Advisory)](#clean-shutdown-advisory)
- [Preemption](#preemption)
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
- [cached_last_action and the Redo Mechanism](#cached_last_action-and-the-redo-mechanism)
- [ResyncMove and the Simulation Loop](#resyncmove-and-the-simulation-loop)
- [On-Chain Game State Tracking (our_turn)](#on-chain-game-state-tracking-our_turn)
- [UX Notifications](#ux-notifications)
- [Accept Lifecycle](#accept-lifecycle)
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
  bit (determined by which player published), then applies the challenger's
  conditions instead.

The **parity rule** (odd/even sequence numbers) ensures that each player can
only preempt with states they legitimately signed. Player A uses even numbers,
player B uses odd (or vice versa) — so player A can't replay player B's
signatures.

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
- Start a new game
- Make a move
- Accept a game result
- Initiate clean shutdown

When a player wants to act but doesn't have the potato, they **request** it.
The other player passes it (along with any pending state updates) in their next
message.

Each potato pass includes a re-signed unroll commitment, ensuring both players
always have the latest co-signed state.

The potato prevents race conditions: since only one player can update state at a
time, there's no ambiguity about move ordering.

**Key code:** `src/potato_handler/mod.rs` (`PotatoHandler`, `PotatoState`)

### Handshake

Before play begins, the two players execute a multi-step handshake
(steps A through F) to:
1. Exchange public keys (channel keys, unroll keys, referee keys)
2. Agree on channel parameters (timeout, amounts)
3. Co-sign the initial channel coin creation
4. Reach `HandshakeState::Finished`

**Key code:** `src/potato_handler/handshake.rs`, `src/potato_handler/start.rs`

---

## Off-Chain Game Flow

Once the channel is open:

```
1. Potato holder calls send_potato_start_game
   → proposes a game, both sides instantiate referee + game handler

2. Potato holder calls send_potato_move
   → signs the move, updates the unroll commitment, passes potato

3. Other player receives potato, processes move via referee
   → validates the move, updates their own state
   → when ready, makes their move and passes potato back

4. Repeat until game ends

5. Potato holder calls send_potato_accept
   → balances are updated, game moves to pending_accept_games
   → when the potato comes back, the accept is confirmed
```

Each move increments the `state_number` and produces a new signed unroll
commitment. The `ChannelHandler` tracks `live_games`, `pending_accept_games`,
player balances (`my_allocated_balance`, `their_allocated_balance`), and the
current `state_number`. See [Accept Lifecycle](#accept-lifecycle) for details
on what happens when accept hasn't been confirmed before going on-chain.

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
`pending_accept_games` (see [Accept Lifecycle](#accept-lifecycle) below). All
state tracking is **forward-only** — there is no rewind logic. Two cases:

1. **Coin PH matches `last_referee_puzzle_hash`** (the outcome/post-move PH):
   The game coin is at the latest known state. `our_turn` is set based on
   `is_my_turn()`. No redo needed.

2. **Coin PH matches `cached_last_action.match_puzzle_hash`**: The game coin
   is at the state *before* our last cached move. A redo is needed to replay
   that move on-chain (see [Redo Mechanism](#cached_last_action-and-the-redo-mechanism)).

Games that existed off-chain but don't match any created coin are reported as
`GameCancelled`.

### Step 4: Redo (if needed)

If the game coin landed at the pre-move state, `get_redo_action` returns a
`RedoMove` that replays the cached move on-chain. The redo uses the cached
move data and the actual on-chain coin ID to construct the transaction. After
the redo, the game is at the latest known state.

### Step 5: Accept / Timeout

Once all moves are replayed, `coin_timeout_reached` generates a timeout
transaction that ends the game and distributes funds based on `mover_share`.
Timeout transactions are submitted as soon as the `game_timeout` relative
timelock allows. The `WeTimedOut` notification is emitted only at this point
— not when accept is first called.

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

### Parity

Each player "owns" state numbers of a particular parity (odd or even), based on
`started_with_potato`. A player can only preempt with a state number of the
correct parity. This prevents replay attacks where a player submits the
opponent's signatures.

### After Preemption or Timeout

Regardless of which path resolved the unroll coin, the result is the same: game
coins and reward coins are created. The game code then uses
`set_state_for_coins` to determine if a redo is needed (see Step 3 above).

**Key code:** `src/channel_handler/mod.rs` — `channel_coin_spent`,
`make_preemption_unroll_spend`

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

3. **Slash** (`args = (previous_state, previous_validation_program, mover_puzzle, solution, evidence)`):
   - Proves a previous move was invalid by running the validation program
   - If validation raises, the slash succeeds and the slasher takes the funds

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
game coin — they're only revealed once, in the final timeout spend.

**Key code:** `src/common/standard_coin.rs` — `sign_reward_payout`,
`reward_payout_message`, `verify_reward_payout_signature`

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
| `GameAction` | `potato_handler/types.rs` | Actions: `Move`, `Accept`, `GoOnChain`, `CleanShutdown`, etc. |
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
   actions are discarded (on-chain path supersedes the clean shutdown path) and
   `LocalStartGame` actions emit `GameCancelled`. Remaining actions (moves,
   accepts) are forwarded to the `OnChainPotatoHandler` for on-chain replay.

**Key code:** `src/peer_container.rs` — `go_on_chain`, `send_message`,
`deliver_message`

---

## cached_last_action and the Redo Mechanism

### Design Principle

All state transitions are **forward-only**. There is no rewind logic. When a
game goes on-chain, the system either recognizes that the game coin is already
at the latest state, or it replays a single cached move to advance to the
latest state. This is the "redo" mechanism.

### Lifecycle

`cached_last_action` on the `ChannelHandler` stores the data for the most
recent move that we sent but the opponent has not yet acknowledged:

- **Set** in `update_cache_for_potato_send` — when we send a move, we cache
  the move data, the puzzle hash it operates on (`match_puzzle_hash`), and the
  post-move puzzle hash (`saved_post_move_last_ph`).
- **Cleared** in `received_potato_move` — when we receive any opponent move,
  the cache is cleared because the opponent's move implicitly acknowledges
  receipt of ours (the potato changed hands).
- **Cleared** in `received_empty_potato` — when we receive an explicit
  acknowledgment (empty potato pass).

### How Redo Works

When game coins are created after an unroll, `set_state_for_coins` checks each
coin's puzzle hash:

1. **Coin PH == `cached_last_action.match_puzzle_hash`**: The game coin is at
   the state our cached move operates on. Queue a `RedoMove` to replay it.
   Set `our_turn = true` (we need to submit the redo transaction).

2. **Coin PH == `last_referee_puzzle_hash`**: The game coin is at the latest
   state. No redo needed. Set `our_turn` based on `is_my_turn()`.

3. **Neither matches**: Error condition (game disappeared or unexpected state).

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
[Peer Disconnect Invariant](#peer-disconnect-invariant)). If we sent a move
(setting `cached_last_action`) but the peer's response — which would normally
clear the cache — arrives *after* the disconnect, the cache remains set. This
is expected and correct: the stale cache causes `set_state_for_coins` to
detect a redo is needed, which replays our unacknowledged move on-chain. The
redo is legitimate because the unroll resolves to the pre-move state (the last
mutually signed state was before our unacknowledged move).

### Redo and User-Queued Moves Can Coexist

When a user calls `make_move` after `go_on_chain`, the move is placed directly
on `game_action_queue` without touching the potato or channel handler (since
`initiated_on_chain` is true). During `finish_on_chain_transition`, the stale
`cached_last_action` may also produce a `RedoMove` that is pushed to the
*front* of the queue. This is correct: the redo replays the previous
unacknowledged move, and the user's new move follows once the game state has
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
| 4 (a,b,c,d) | Bob | Alice | `Cheat(0)`, `Accept(0)` |

When designing tests with `Cheat(N)` or `Accept(N)`, ensure the number of
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
| `game_start` | `games: &[GameStartInfo]` | One or more games have started. Each `GameStartInfo` contains `game_id`, `my_turn` (whether we move first), `my_contribution`, and `their_contribution`. |
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

### On-Chain Transition Notifications

| Notification | When | Meaning |
|--------------|------|---------|
| `ChannelCoinSpent` | Channel coin spend detected on-chain | The channel is being unrolled (by either player) |
| `UnrollCoinSpent { reward_coin }` | Unroll coin spend detected on-chain | Game coins and reward coins are now live; `reward_coin` is `Some(CoinString)` for our change/reward coin from the unroll, `None` if our balance is zero |
| `GoingOnChain { reason }` | Error detected in peer message | We are automatically going on-chain due to an error; `reason` describes what went wrong (e.g., invalid peer message, opponent requested clean shutdown while games are active) |

`ChannelCoinSpent` and `UnrollCoinSpent` fire regardless of who initiated the
unroll. A player who called `go_on_chain` will see `ChannelCoinSpent` when
their own transaction is mined, exactly as if the opponent had initiated it.

### Game Outcome Notifications (Terminal)

These are the terminal notifications — each signals that a game is finished.
The frontend should treat any of these as the "game ended" signal.

| Notification | When | Meaning |
|--------------|------|---------|
| `WeTimedOut { id, our_reward, reward_coin }` | Game resolved in our favor | Includes off-chain accept (fires when potato returns) and on-chain timeout; `our_reward` is the amount we received; `reward_coin` is `Some(CoinString)` when on-chain and reward is nonzero, `None` for off-chain resolution |
| `OpponentTimedOut { id, our_reward, reward_coin }` | Game resolved in opponent's favor | Includes receiving opponent's off-chain accept; `our_reward` is the amount we received; `reward_coin` is `Some(CoinString)` when on-chain and reward is nonzero, `None` for off-chain |
| `GameCancelled { id }` | Unroll resolved without this game | Game existed off-chain but wasn't in the unroll conditions |
| `WeSlashedOpponent { id, reward_coin }` | Slash transaction confirmed | Opponent's illegal move was proven on-chain; `reward_coin` is the `CoinString` of the reward we received |
| `OpponentSlashedUs { id }` | Opponent slashed us | Our move was proven illegal on-chain |
| `OpponentSuccessfullyCheated { id, our_reward }` | Slash coin timed out | Opponent cheated and we failed to challenge in time; `our_reward` is the mover_share from their cheating move (what we actually ended up with) |
| `GameError { id, reason }` | A single game coin is in an unrecoverable state | Something went wrong with one game |
| `ChannelError { reason }` | The channel or unroll coin is unrecoverable | Everything is lost |

### Key Invariants

- **Accept only on our turn.** Calling `accept()` when it is not our turn is an
  assert failure. Accept is an alternative to moving.
- **Only our redos after unroll.** After an unroll, game coins always land at
  either our latest state or one step behind (needing OUR redo). We always
  preempt any stale opponent unroll or timeout at the correct state. If the
  opponent unrolled to an old state that we could not preempt, that is a
  `ChannelError`. The opponent never needs to make moves on game coins after an
  unroll we participated in.
- **Accepted + opponent move is unreachable.** Since accept only happens on our
  turn, and only the mover can advance a game coin, the opponent cannot move on
  a coin where we already accepted. This path is a `debug_assert!` / `GameError`.

**Key code:** `src/potato_handler/effects.rs`

---

## Accept Lifecycle

Calling `accept()` off-chain does **not** immediately finalize the game. The
full lifecycle is:

### Off-Chain Accept

1. `send_potato_accept` moves the game from `live_games` to
   `pending_accept_games` in the `ChannelHandler` and updates balances.
2. The accept data is bundled into the next potato pass.
3. When the potato comes back (acknowledgment), `pending_accept_completions` is
   drained, emitting `WeTimedOut` for the accepter. The opponent who receives
   the accept gets `OpponentTimedOut` immediately.

If the channel goes on-chain **before** the round-trip completes, the game
is still in `pending_accept_games`. The `set_state_for_coins` function
searches both `live_games` and `pending_accept_games` when matching game
coins, so accepted-but-unconfirmed games are correctly tracked on-chain.

### On-Chain Accept

When a game is already on-chain and the player calls `Accept(game_id)`:

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

The key invariant: **`WeTimedOut` is never emitted at the time of the accept
call itself** — only when the game actually resolves on-chain. This makes the
notification reliable regardless of whether the game finishes via potato
round-trip or on-chain timeout.

**Key code:**
- `src/channel_handler/mod.rs` — `send_potato_accept`, `pending_accept_games`
- `src/potato_handler/on_chain.rs` — `GameAction::Accept`, `handle_game_coin_spent`,
  `coin_timeout_reached`

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
Alice moves and Bob must accept, with the specified `mover_share` split. This
avoids the complexity of Calpoker's commit-reveal protocol when testing
channel/on-chain mechanics.

### Simulation Test Actions

Tests drive the simulation loop with a sequence of `GameAction` values (defined
in `src/test_support/game.rs`):

| Action | Effect |
|--------|--------|
| `GoOnChain(player)` | Player initiates on-chain transition |
| `Accept(player)` | Player accepts the current game result |
| `WaitBlocks(n, player)` | Advance `n` blocks, processing coin events for `player` |
| `NerfTransactions(player)` | Silently drop all outbound transactions for `player` |
| `UnNerfTransactions` | Stop dropping transactions |
| `Cheat(player)` | Submit an illegal on-chain move |
| `EnableCheating(player, bytes)` | Set up a fake move for the next on-chain action |
| `ForceDestroyCoin(player)` | Inject a fake coin deletion to test error handling |
| `CleanShutdown(player, conditions)` | Initiate clean channel shutdown |
| `ForceUnroll(player)` | Submit a unroll transaction using the player's cached spend info, bypassing state checks. Simulates a malicious peer unrolling after agreeing to clean shutdown. |

`NerfTransactions` is particularly useful for testing asymmetric scenarios —
e.g., one player's unroll transaction gets dropped (simulating network issues)
while the other player proceeds normally. Multiple players can be nerfed
simultaneously (the implementation uses a bitmask).

**Important:** Nerfing only drops a player's *outbound transactions*. It does
not prevent coins from being created for that player's puzzle hash by another
player's transaction. In particular, the referee timeout creates reward coins
for **both** mover and waiter in a single spend, so a nerfed player still
receives their reward coin when the non-nerfed player submits the timeout.

**Key code:**
- `src/test_support/debug_game.rs` — `DebugGameHandler`, `DebugGameTestMove`
- `src/test_support/game.rs` — `GameAction` enum (sim-tests variant)
- `src/simulator/tests/potato_handler_sim.rs` — integration test suite
