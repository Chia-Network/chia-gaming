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
- [The Referee](#the-referee)
  - [Referee Puzzle Args](#referee-puzzle-args)
  - [On-Chain Referee Actions](#on-chain-referee-actions)
  - [Referee State Model](#referee-state-model)
- [Calpoker: The Reference Game](#calpoker-the-reference-game)
  - [Commit-Reveal Protocol](#commit-reveal-protocol)
  - [On-Chain Steps (a through e)](#on-chain-steps-a-through-e)
- [Code Organization](#code-organization)
- [Key Types](#key-types)
- [Peer Disconnect Invariant](#peer-disconnect-invariant)
- [cached_last_action and the Redo Mechanism](#cached_last_action-and-the-redo-mechanism)
- [ResyncMove and the Simulation Loop](#resyncmove-and-the-simulation-loop)
- [On-Chain Game State Tracking (our_turn)](#on-chain-game-state-tracking-our_turn)

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
    ▼  (timeout / reveal default conditions)
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
- **Timeout path** (no challenge): After enough blocks pass, the default
  conditions are revealed and applied. These conditions create the game coins
  and reward coins reflecting the last agreed state.
- **Challenge path** (preemption): The opponent provides a solution with a
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
- **Timeout:** If the current mover doesn't act within the timeout period, the
  waiter claims the pot based on `mover_share`
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
- Initiate shutdown

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
   → both players agree on the final result
   → balances are updated, game is removed from live_games
```

Each move increments the `state_number` and produces a new signed unroll
commitment. The `ChannelHandler` tracks `live_games`, player balances
(`my_allocated_balance`, `their_allocated_balance`), and the current
`state_number`.

---

## Going On-Chain: Dispute Resolution

When something goes wrong (opponent offline, invalid move detected, explicit
`GoOnChain` action), the flow is:

### Step 1: Channel → Unroll

`PotatoHandler::do_channel_spend_to_unroll` submits a `SpendBundle` that spends
the channel coin, creating the unroll coin. The unroll coin is curried with the
last co-signed state.

### Step 2: Unroll → Game Coins

After the unroll timeout, or if the opponent doesn't challenge,
`do_unroll_spend_to_games` spends the unroll coin with the default conditions.
This creates:
- **Reward coins** — the non-game balances for each player
- **Game coins** — one per active game, curried with `RefereePuzzleArgs`

### Step 3: Rewind & Align State

`ChannelHandler::set_state_for_coins` calls `LiveGame::set_state_for_coin` for
each game coin, which calls `Referee::rewind`. The referee walks its ancestor
chain to find the state matching the game coin's puzzle hash. This is necessary
because the unroll coin reflects the last **co-signed** state, which may be
behind the actual game state (if moves were in-flight when the dispute started).

### Step 4: Redo Moves

If the local player had made moves that weren't yet acknowledged (co-signed) by
the opponent, those moves need to be **replayed on-chain**. The
`OnChainPotatoHandler` processes `RedoMove` actions to submit these moves as
on-chain transactions.

### Step 5: Accept / Timeout

Once all moves are replayed, `coin_timeout_reached` generates a timeout
transaction that ends the game and distributes funds based on `mover_share`.

### Step 6: Shutdown

After all games resolve, the players can shut down the channel.

**Key code:**
- `src/potato_handler/mod.rs` — `go_on_chain`, `do_channel_spend_to_unroll`
- `src/potato_handler/on_chain.rs` — `OnChainPotatoHandler`
- `src/channel_handler/mod.rs` — `set_state_for_coins`,
  `accept_or_timeout_game_on_chain`, `game_coin_spent`

---

## The Referee

The referee is the on-chain puzzle that enforces game rules. Each game coin is
curried with `RefereePuzzleArgs` that encode the full game state.

### Referee Puzzle Args

```rust
RefereePuzzleArgs {
    mover_puzzle_hash,      // puzzle hash of the player whose turn it is
    waiter_puzzle_hash,     // puzzle hash of the player waiting
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
    validation_program,     // the chialisp program that validates moves
    nonce,                  // unique identifier for this game instance
}
```

### On-Chain Referee Actions

The referee puzzle (`referee.clsp`) accepts three types of solutions:

1. **Timeout** (`args = nil`):
   - Requires `ASSERT_HEIGHT_RELATIVE >= TIMEOUT`
   - Pays `MOVER_SHARE` to mover, remainder to waiter
   - Used when the current mover fails to act in time

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

**Ancestor chain:** Each referee state has a `parent` pointer. The `rewind`
function walks this chain to find a state matching a given puzzle hash — this
is how the referee aligns with the on-chain coin state after the unroll.

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
| **Referee** | `src/referee/` | Per-game state machine: moves, timeouts, slashes, rewind |
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
| `src/simulator/tests/potato_handler_sim.rs` | Integration tests including piss_off_peer suite |
| `src/test_support/peer/potato_handler.rs` | Test peer helper |
| `docker-sim-tests.sh` | Docker-based test runner |

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
| `GameAction` | `potato_handler/types.rs` | Actions: `Move`, `Accept`, `GoOnChain`, `Shutdown`, etc. |
| `SynchronousGameCradleState` | `peer_container.rs` | Per-peer mutable state: queues, flags, `peer_disconnected` |
| `OnChainGameState` | `potato_handler/on_chain.rs` | Per-game-coin tracking: `our_turn`, `puzzle_hash`, `accepted` |

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

Messages that were already queued in `inbound_messages` before the flag was set
will be popped by `idle()` and passed to `received_message`, but
`process_incoming_message` hits the catch-all (handshake state is no longer
`Finished`) and the message is buffered without being processed as a normal
off-chain potato.

**Key code:** `src/peer_container.rs` — `go_on_chain`, `send_message`,
`deliver_message`

---

## cached_last_action and the Redo Mechanism

### Lifecycle

`cached_last_action` on the `ChannelHandler` stores the data for the most
recent move that we sent but the opponent has not yet acknowledged:

- **Set** in `update_cache_for_potato_send` — when we send a move, we cache it.
- **Cleared** in `received_potato_move` (line ~1162 of `channel_handler/mod.rs`)
  — when we receive *any* opponent move, the cache is cleared because the
  opponent's move implicitly acknowledges receipt of ours (the potato changed
  hands).
- **Cleared** in `received_empty_potato` — when we receive an explicit
  acknowledgment (empty potato pass).

### Implications for Going On-Chain

When `go_on_chain` is called:

1. `set_state_for_coins` swaps `cached_last_action` into `did_rewind`.
2. If `did_rewind` is `Some(...)`, the system replays the cached move on-chain
   via `get_redo_action` → `RedoMove`.
3. If `did_rewind` is `None`, no redo is needed — the on-chain state already
   reflects all our moves.

### When Redo Happens (and When It Doesn't)

In normal operation, a player goes on-chain because their opponent stopped
responding. The player's last move is unacknowledged — `cached_last_action` is
set — so the redo mechanism replays it on-chain. This is the common case and
the whole point of the redo machinery.

A redo is **not** triggered only when the going-on-chain player was the
**receiver** of the most recent move (which cleared their `cached_last_action`
via `received_potato_move`). This scenario — going on-chain on your own turn
with nothing pending — is less typical but matters for tests that want a
straightforward timeout without redo complications.

---

## ResyncMove and the Simulation Loop

### What ResyncMove Does

`Effect::ResyncMove { id, state_number, is_my_turn }` is emitted by
`OnChainPotatoHandler::handle_game_coin_spent` (in `on_chain.rs`) when a game
coin is spent with an `Expected` result that carries redo data. It signals:
"the on-chain game has been replayed to this state; the UI should adjust."

It is the **only** place `ResyncMove` is emitted.

### How the Simulation Handles It

In the simulation loop (`run_calpoker_container_with_action_list`), when
`result.resync` is `Some((_, true))` (i.e., it's our turn after the resync):

1. `can_move` is set to `true`
2. `move_number` is **rewound** to the last `GameAction::Move(...)` in the
   action list

This is intended to let the simulation replay moves on-chain. However, the
rewound `Move` action specifies a particular player. If the on-chain state now
has a **different** player's turn, `my_move_in_game` returns `Some(false)` or
`None`, the move is "put back" (`move_number -= 1`), and the simulation stalls.

### Stall Conditions

A ResyncMove-induced stall occurs when:
- The rewound `Move(player, ...)` targets a player who is NOT the current mover
  on-chain
- No other trigger (`opponent_moved`, `can_move`, `global_move`) fires to
  advance `move_number` past the stuck `Move` action

This is why **the going-on-chain player matters for tests**: if player A goes
on-chain and has a redo, the ResyncMove fires with `is_my_turn` based on the
post-redo state. If the rewound `Move` in the action list is for player B but
the on-chain state expects player A, the simulation hangs.

### Avoiding Resync Stalls in Tests

- If the going-on-chain player has **no redo** (`cached_last_action` is `None`),
  no `ResyncMove` is emitted and no rewind occurs.
- To achieve no-redo: ensure the going-on-chain player **received** the last
  move (clearing their cache) before `GoOnChain` fires. This means the last
  `Move` action before `GoOnChain` should be from the **other** player.

---

## On-Chain Game State Tracking (our_turn)

The `OnChainPotatoHandler` maintains a `game_map: HashMap<CoinString,
OnChainGameState>` that tracks each game coin's state, including an `our_turn`
flag.

### How our_turn is Set

- **Initial game coin** (from unroll): `our_turn = live_game.is_my_turn()` at
  the time the unroll produces game coins (`set_state_for_coins`).
- **After opponent's move** (`TheirSpend::Expected` or `TheirSpend::Moved`):
  `our_turn = true` — the opponent just moved, so now it's our turn.

### How our_turn Determines Timeout Notifications

When `coin_timeout_reached` fires on a game coin:

```
if old_definition.our_turn →  GameNotification::WeTimedOut
else                        →  GameNotification::WeTimedOutOpponent
```

So the notification depends entirely on `our_turn` in the `game_map` entry for
the coin that timed out. Both players maintain independent `game_map`s, and
both should have complementary values of `our_turn` for the same game coin.
