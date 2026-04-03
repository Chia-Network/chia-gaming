# Overview: Chia Gaming State Channels

This document provides the conceptual foundation for the `chia_gaming`
codebase — a system for playing two-player games over Chia state channels.
For detailed coverage of specific areas, see [Further Reading](#further-reading)
at the end of this document.

**Alpha status:** This project is in alpha. No on-chain wire formats, persistence
formats, or external APIs are stable yet. Breaking changes should be expected.

## Table of Contents

- [Overview](#overview)
- [State Channels: The Core Idea](#state-channels-the-core-idea)
- [Coin Hierarchy](#coin-hierarchy)
- [The Potato Protocol](#the-potato-protocol)
- [Calpoker: The Reference Game](#calpoker-the-reference-game)
- [Handler Architecture](#handler-architecture)
- [Code Organization](#code-organization)
- [Key Types](#key-types)
- [Further Reading](#further-reading)

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
    ├── Alice's coin creates 0-value launcher child
    │       │
    │       ▼
    │   Launcher Coin ── SINGLETON_LAUNCHER puzzle
    │       │
    │       ▼  (launcher creates channel coin)
    └──▶ Channel Coin ── 2-of-2 multisig (aggregate channel keys)
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

- Created as a child of a **standard singleton launcher**.  The launcher's
parent is a wallet coin selected by Alice during the handshake.  Both
players' funding coins contribute to the launcher transaction, and both
assert `ASSERT_COIN_ANNOUNCEMENT` on the launcher's output plus
`ASSERT_BEFORE_HEIGHT_ABSOLUTE` as a timeout guard.
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
the pot is split according to `mover_share` (see
[Referee Puzzle Args](ON_CHAIN.md#referee-puzzle-args) for semantics)
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

1. `**actions: Vec<BatchAction>`** — one or more game operations to apply
  sequentially:
  - `ProposeGame` — propose a new game
  - `AcceptProposal` — accept a pending game proposal
  - `CancelProposal` — cancel a pending proposal
  - `Move` — make a game move
  - `AcceptTimeout` — accept a game result (end game)
2. `**signatures: PotatoSignatures`** — two half-signatures covering the final
  channel state after all actions in the batch have been applied:
  - A half-signature of the **channel coin** spend committing to the new unroll
  coin (so both players can unroll to the latest agreed state).
  - A half-signature for **preempting the unroll coin** to this state (so the
  recipient can prove they have a more recent state if the opponent publishes
  a stale unroll).
   Both are half-signatures because the channel coin and unroll coin are 2-of-2
   constructions — each potato pass carries the sender's half, and the receiver
   combines it with their own to form the full aggregate signature.
3. `**clean_shutdown: Option<(Aggsig, ProgramRef)>`** — optional clean shutdown
  initiation, always positioned logically after all other actions. Contains the
   initiator's half-signature of the channel coin spend directly to reward coins
   (bypassing unroll and game coins entirely), plus the conditions program. The
   responder replies with a separate `PeerMessage::CleanShutdownComplete(CoinSpend)`
   message — not another batch — carrying their half-signature combined into a
   complete `CoinSpend` ready for on-chain submission.

The receiver processes actions sequentially and rejects the entire batch if any
action fails validation. Rejection uses a **rollback mechanism**: the
`ChannelHandler` (which derives `Clone`) is snapshot-cloned before processing
begins. If any action or signature verification fails, the snapshot is restored,
undoing all intermediate mutations from earlier actions in the batch. The error
then triggers go-on-chain (the peer sent a bad batch, so we dispute on-chain).

Because the batch comes with the potato, the sender constructed it while holding
the definitive state. Every action in the batch should be valid against that
state — any failure is a protocol violation by the peer, not a benign race.

The sender is responsible for ordering actions correctly (e.g., game acceptances
before proposal acceptances to ensure funds are available).

Only one move per game is allowed per batch, enforced by the existing turn-taking
rules (you can't move on your opponent's turn).

The `current_state_number` increments once per batch, not per action.

### Message-Level Validation

Before batch processing begins, two checks protect the receiver:

- **Message size limit:** Messages larger than 10 MiB are rejected immediately
in `received_message`, before deserialization. This prevents a
malicious peer from consuming unbounded memory.
- **Double-potato detection:** If a `Batch` arrives while we already hold the
potato (`PotatoState::Present`), it is rejected as a protocol violation.
Only one player can hold the potato at a time; receiving a second batch
means the peer is misbehaving.

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

### Handshake (6-Message Protocol)

Before play begins, the two players execute a multi-step handshake
(steps A through F) to exchange public keys, agree on channel parameters,
co-sign the initial channel coin, and transition to `PotatoHandler`.

The protocol is designed so that Alice (the initiator) commits the channel
coin ID — derived from a singleton launcher — before either party signs any
unroll state. This prevents either side from stealing funds or burning the
other's money.

Each side runs its own handler: `HandshakeInitiatorHandler` (the player who
starts the channel) and `HandshakeReceiverHandler`. The A-F labels are the
wire/message protocol labels. Internally, the split handlers use semantic
state names (`SentA`, `WaitingForLauncher`, `SentC`, etc.) while still speaking
the same A-F wire messages. Handshake messages are not sent via `Batch`:

| Step | Sender | Message | Payload |
|------|--------|---------|---------|
| A | Initiator | `HandshakeA` | Public keys (channel, unroll, referee), reward puzzle hash, reward payout signature |
| B | Receiver | `HandshakeB` | Public keys (channel, unroll, referee), reward puzzle hash, reward payout signature |
| C | Initiator | `HandshakeC` | `CoinString` of the launcher coin (parent + SINGLETON_LAUNCHER_HASH + 0) |
| D | Receiver | `HandshakeD` | State-0 `PotatoSignatures` (half-sigs for channel and unroll coins) |
| E | Initiator | `HandshakeE` | Partial `SpendBundle` (wallet spend + launcher spend) + state-0 `PotatoSignatures` |
| F | Receiver | `HandshakeF` | Final combined `SpendBundle` (initiator's spends + receiver's wallet spend) |

#### Between-message wallet interactions

Between B and C, the initiator must consult the wallet to select a coin
that will serve as the launcher parent. The library emits
`Effect::NeedLauncherCoinId`; the hosting layer (WASM wrapper or simulator)
calls `selectCoins`, computes the launcher coin, and feeds it back via
the split handler callback (`provide_launcher_coin` on the active
`PeerHandler` implementation).

The receiver verifies in C that the launcher coin's puzzle hash equals
`SINGLETON_LAUNCHER_HASH`, ensuring the channel coin parent is a standard
launcher.

Between D and E, the initiator must obtain a wallet `SpendBundle`
contributing their share of the channel funding. The library emits
`Effect::NeedCoinSpend(CoinSpendRequest)` containing the required amount,
conditions (CREATE_COIN for the launcher, ASSERT_COIN_ANNOUNCEMENT,
ASSERT_BEFORE_HEIGHT_ABSOLUTE), and the wallet coin ID to use. The hosting
layer calls `createOfferForIds` to get a `SpendBundle` from the wallet, then
feeds it back via `provide_coin_spend_bundle` on the split handler. The
library appends the launcher `CoinSpend` and sends the combined bundle in E.

Between E and F, the receiver must similarly obtain a wallet `SpendBundle`
contributing their share. The library emits `Effect::NeedCoinSpend` with the
receiver's conditions and amount. After receiving the wallet bundle, the
library combines it with the initiator's bundle from E and sends the final
transaction in F. Both players publish the same final `SpendBundle` to the
network.

#### State machine

Initiator (`have_potato = true`):

```
WaitingForStart → SentA → WaitingForLauncher → SentC → WaitingForOffer → Finished
   (send A)       (recv B, NeedLauncherCoinId)   (recv D, verify/store peer signatures,
                 provide_launcher → send C)       NeedCoinSpend, provide_coin_spend → send E)
```

Receiver (`have_potato = false`):

```
WaitingForA → SentB → SentD → WaitingForCompletion → Finished
 (recv A,     (recv C, verify launcher coin, send D)   (recv E, verify/store peer signatures,
  send B)                                              NeedCoinSpend, provide_coin_spend → send F)
```

Handshake-specific wallet callback plumbing now lives in the split handshake
handlers, not in `PotatoHandler` monolithic handshake state.

The transition to `PotatoHandler` is driven by `coin_created` — the channel
coin appearing on-chain. Since the coin cannot exist before E is sent, this
is the ground truth for "the channel is live." A late-arriving `HandshakeF`
after the transition is silently ignored by `PotatoHandler`.

#### Security properties

1. **No unroll signatures before coin ID is known:** The initiator sends the
   channel coin ID in C. Only after the receiver has this ID do they sign any
   unroll state (D). The initiator likewise only signs after verifying the
   receiver's signatures (E).
2. **Launcher verification:** The receiver checks that the launcher coin's
   puzzle hash is `SINGLETON_LAUNCHER_HASH`, ensuring the initiator cannot
   substitute an arbitrary coin.
3. **Signature symmetry:** Both sides call
   `ChannelHandler::verify_and_store_initial_peer_signatures` at the first
   point where they receive the peer's state-0 signatures (initiator on D,
   receiver on E), verifying and storing them before proceeding.

#### Wallet API interaction

The handshake requires interaction with the Chia wallet at three points:

| Call | When | Purpose |
|------|------|---------|
| `selectCoins(amount)` | After B (initiator only) | Select a wallet coin whose ID becomes the launcher parent |
| `createOfferForIds(amount, conditions)` | After D (initiator) | Get a signed `SpendBundle` contributing the initiator's share of funding |
| `createOfferForIds(amount, conditions)` | After E (receiver) | Get a signed `SpendBundle` contributing the receiver's share of funding |

The `createOfferForIds` call takes the player's contribution amount, extra
conditions (assertions and CREATE_COIN for the launcher), and optionally a
specific coin ID to spend. It returns a `SpendBundle` containing one wallet
coin spend with the requested conditions.

In the **simulator** these are implemented by `Simulator::select_coins` and
the `create_offer_for_ids` HTTP endpoint (which calls
`standard_solution_partial` to produce a signed spend). In the **real wallet**
they map to WalletConnect RPCs:

- `chia_selectCoins` — select spendable coins totalling at least the required
  amount.
- `chia_createOfferForIds` — create a signed `SpendBundle` with the specified
  conditions and amount. The `extraConditions` parameter carries the
  channel-specific assertions; `coinIds` optionally pins the spend to a
  specific coin.
- `chia_pushTx` — broadcast the final combined `SpendBundle` to the network
  (both players submit it).

#### Channel coin funding

The channel coin is created via a **standard singleton launcher**. The funding
transaction contains three spends:

1. **Initiator's wallet coin** — creates the 0-value launcher child and
   asserts `ASSERT_COIN_ANNOUNCEMENT` (launcher announces the channel coin
   creation) and `ASSERT_BEFORE_HEIGHT_ABSOLUTE` (timeout guard).
2. **Receiver's wallet coin** — asserts the same announcement and height
   conditions.
3. **Launcher coin** — the standard launcher puzzle, whose solution is
   `(channel_puzzle_hash, total_amount, ())`.

This produces the channel coin as a child of the launcher, with the agreed
puzzle hash and combined amount.

**Key code:** `src/potato_handler/handshake_initiator.rs`,
`src/potato_handler/handshake_receiver.rs`,
`src/potato_handler/handshake.rs` (shared types),
`src/channel_handler/mod.rs` (`get_initial_signatures`,
`verify_and_store_initial_peer_signatures`)

---
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
evaluated using `handcalc` (a chialisp hand evaluator). The final move sets
`mover_share` to reflect the outcome — the losing player (who must respond
next) receives `mover_share` on timeout, which is the smaller portion.

### On-Chain Steps (a through e)

Each step is a chialisp **validation program** that enforces the rules of that
step of the commit-reveal protocol:


| Step  | Mover           | Move                                          | State After                           | Validates                                                                          |
| ----- | --------------- | --------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| **a** | Alice (commits) | `sha256(preimage)` (32 bytes)                 | `alice_commit`                        | Move is exactly 32 bytes                                                           |
| **b** | Bob (seeds)     | `bob_seed` (16 bytes)                         | `(alice_commit, bob_seed)`            | Move is exactly 16 bytes                                                           |
| **c** | Alice (reveals) | `preimage ‖ sha256(salt‖discards)` (48 bytes) | `(new_commit, cards)`                 | `sha256(preimage) == alice_commit`; derives cards                                  |
| **d** | Bob (discards)  | `bob_discards` (1 byte)                       | `(bob_discards, alice_cards, bob_cards, alice_commit)` | Valid discard bitmask (popcount = 4)                          |
| **e** | Alice (final)   | `salt‖discards‖selects` (18 bytes)            | Game over                             | `sha256(salt‖discards) == alice_commit`; valid popcounts; hand eval; correct split |


At step **e**, Bob can submit his card selections as **evidence** for a slash
if Alice misclaims the split.

### Advisory Messages (Symmetric UX)

The commit-reveal protocol is inherently sequential — Alice and Bob take strict
turns. Without help, Bob would see nothing while Alice deliberates her move.
The game handler framework provides an **advisory message** mechanism that
lets the player who just processed a move immediately send derived information
back to the opponent, outside the logical flow of the game.

When Alice processes Bob's step **b** (his seed), her `their_turn_handler`
derives the card deal and produces an optional `message_data` blob. This is
sent back to Bob immediately as a `PeerMessage::Message`. Bob's
`message_parser` (a CLVM program returned by his earlier `my_turn_handler`)
decodes the blob into a `ReadableMove` that the UI can display. Bob sees his
cards and can start contemplating discards while Alice is still thinking.

The message is purely advisory: it carries no authority, doesn't change game
state, and cannot be used for cheating — the recipient will independently
derive the same information once the real move arrives. Because it is
advisory, there is no reason to bundle it with an authoritative potato pass.
And because the information it contains will be derivable by the recipient
anyway, sending it early does no strategic damage to the sender — it simply
lets the opponent start thinking sooner, making the UX feel simultaneous
even though the underlying protocol is turn-based.

The same mechanism is available to any game, not just calpoker. The
`my_turn_handler` returns a `message_parser` (or nil if the game doesn't use
advisory messages), and the `their_turn_handler` returns `message_data` as an
optional fourth element of its result.

**Key code:**

- `src/channel_handler/game_handler.rs` — `MyTurnResult::message_parser`,
`TheirTurnResult` (message field), `MessageHandler`
- `src/potato_handler/mod.rs` — sends `PeerMessage::Message` on receive;
dispatches incoming messages via `received_message`
- `clsp/games/calpoker/onchain/a.clsp` through `e.clsp`
- `clsp/games/calpoker/calpoker_generate.clinc` — off-chain handlers
- `src/test_support/calpoker.rs` — Rust-side calpoker registration/helpers

---

## Handler Architecture

The system uses a **handler chain** pattern to manage the channel lifecycle.
All handlers implement the `PeerHandler` trait (defined in `src/peer_container.rs`),
which provides a uniform interface for receiving messages, responding to
coin-watching events, and performing game actions. The `SynchronousGameCradle`
holds a single `Box<dyn PeerHandler>` and routes all events through it.

When a handler's phase is complete, it produces a replacement handler via
`take_replacement()`. The cradle detects this in `detect_phase_transition`
and swaps in the new handler. This creates a linear progression through
the channel lifecycle:

```
HandshakeInitiator ─┐
                     ├─→ PotatoHandler ─→ UnrollWatchHandler ─→ OnChainGameHandler
HandshakeReceiver  ─┘         │                  ↑
                              ├─→ ShutdownHandler─┘
```

### Peer Handlers vs States

Two related but distinct concepts appear throughout the docs:

- **Peer handlers** are concrete Rust types implementing `PeerHandler` (for
example `PotatoHandler`, `ShutdownHandler`, `UnrollWatchHandler`). They model
which component currently owns protocol logic.
- **States** are notification-level enums exposed to the UI and tests:
`ChannelState` and `GameStatusKind` (inside `GameNotification::GameStatus`).
They model what phase/outcome the user should see.
- **On-chain lifecycle states** are a protocol lens over coin progression.
For channels, this is commonly reasoned about as
`channel coin created -> unrolling -> unrolled/resolved`.
For individual games, this is commonly reasoned about as
`off-chain live game -> on-chain my/their move loop -> terminal resolution`
(most commonly timeout, but slash/error terminals also exist).

These are not the same thing. A handler transition often emits a state change,
but there is no one-to-one mapping between handler types and state values.
All three lenses are monotonic in lifecycle direction (forward progression,
with same-level repeats for updates), even though they use different names.

### Handlers

| Handler | File | Role |
|---------|------|------|
| `HandshakeInitiatorHandler` | `potato_handler/handshake_initiator.rs` | Initiator side of the handshake (sends A, C, E). Linear state machine; transitions to `PotatoHandler` when the channel coin appears on-chain. |
| `HandshakeReceiverHandler` | `potato_handler/handshake_receiver.rs` | Receiver side of the handshake (sends B, D, F). Same transition trigger. |
| `PotatoHandler` | `potato_handler/mod.rs` | Off-chain game play: batching actions, exchanging the potato, proposing/accepting/playing games. |
| `ShutdownHandler` | `potato_handler/shutdown_handler.rs` | Clean cooperative shutdown. Watches the channel coin spend and inspects the on-chain conditions. Falls through to `UnrollWatchHandler` if an unroll landed instead of the clean shutdown transaction. |
| `UnrollWatchHandler` | `potato_handler/unroll_watch_handler.rs` | Watches the unroll coin after the channel goes on-chain. Handles preemption, forward-aligns game state, creates `OnChainGameHandler`. |
| `OnChainGameHandler` | `potato_handler/on_chain.rs` | On-chain dispute resolution: submits moves, claims timeouts, detects slashes. Driven entirely by coin-watching events, not peer messages. |

Shared utilities used by multiple handlers (e.g. `build_channel_to_unroll_bundle`,
`emit_failure_cleanup`) live in `src/potato_handler/handler_base.rs`.

**Key code:** `src/peer_container.rs` (`PeerHandler` trait, `detect_phase_transition`)

---

## Code Organization

### Core layers (bottom to top)


| Layer                     | Directory / File                             | Responsibility                                                               |
| ------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| **Types & Utilities**     | `src/common/`                                | `CoinString`, `PuzzleHash`, `Amount`, `Hash`, `AllocEncoder`, etc.           |
| **Referee**               | `src/referee/`                               | Per-game state machine: moves, timeouts, slashes                             |
| **Channel Handler**       | `src/channel_handler/`                       | Channel/unroll/game coin management, balance tracking                        |
| **Handshake Handlers**    | `src/potato_handler/handshake_initiator.rs`, `handshake_receiver.rs` | Handshake state machines (A-F), one per side              |
| **Potato Handler**        | `src/potato_handler/mod.rs`                  | Off-chain game play: batching, potato exchange, proposals, moves             |
| **Shutdown Handler**      | `src/potato_handler/shutdown_handler.rs`     | Clean cooperative shutdown; falls through to unroll if needed                |
| **Unroll Watch Handler**  | `src/potato_handler/unroll_watch_handler.rs` | Watches unroll coin, handles preemption, creates OnChainGameHandler          |
| **On-Chain Game Handler** | `src/potato_handler/on_chain.rs`             | Post-unroll dispute resolution: coin watching, timeouts, slashes (no potato) |
| **Handler Base**          | `src/potato_handler/handler_base.rs`         | Shared utilities: `build_channel_to_unroll_bundle`, `emit_failure_cleanup`   |
| **Peer Container**        | `src/peer_container.rs`                      | `PeerHandler` trait, `GameCradle` trait, `SynchronousGameCradle`             |
| **Simulator**             | `src/simulator/`                             | Block-level simulation for integration tests                                 |


### Chialisp puzzles


| File                                          | Purpose                                                   |
| --------------------------------------------- | --------------------------------------------------------- |
| `clsp/unroll/unroll_puzzle.clsp`              | Unroll coin: timeout vs challenge with sequence numbers   |
| `clsp/referee/onchain/referee.clsp`           | Game coin: move / timeout / slash enforcement             |
| `clsp/games/calpoker/onchain/{a,b,c,d,e}.clsp` | Calpoker validation programs (one per protocol step)      |
| `clsp/games/calpoker/calpoker_generate.clinc` | Off-chain calpoker handlers (Alice & Bob sides)           |
| `clsp/test/debug_game.clsp`                   | Debug game: validator, my-turn, their-turn, and factory   |
| `clsp/handler_api.md`                         | Handler calling conventions (see also `HANDLER_GUIDE.md`) |


### Test infrastructure


| File                                        | Purpose                                                  |
| ------------------------------------------- | -------------------------------------------------------- |
| `src/test_support/calpoker.rs`              | Calpoker test registration and helpers                   |
| `src/test_support/debug_game.rs`            | Debug game: minimal game with controllable `mover_share` |
| `src/simulator/tests/potato_handler_sim.rs` | Integration tests including notification suite           |
| `src/test_support/peer/potato_handler.rs`   | Test peer helper                                         |
| `src/test_support/game.rs`                  | `GameAction` enum and simulation loop driver             |
| `tools/local-wasm-tests.sh`                 | Local JS/WASM integration test runner                    |


---

## Key Types


| Type                            | Location                                       | Purpose                                                                                                      |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `CoinString`                    | `common/types/coin_string.rs`                  | Serialized coin: `parent_id ‖ puzzle_hash ‖ amount`                                                          |
| `PuzzleHash`                    | `common/types/puzzle_hash.rs`                  | 32-byte hash identifying a puzzle                                                                            |
| `GameID`                        | `common/types/game_id.rs`                      | A `u64` nonce that uniquely identifies a game; see [Game IDs and Nonces](ON_CHAIN.md#game-ids-and-nonces)    |
| `SpendBundle`                   | (chia types)                                   | Collection of `CoinSpend`s forming an atomic transaction                                                     |
| `RefereePuzzleArgs`             | `referee/types.rs`                             | All args curried into the referee puzzle                                                                     |
| `Referee`                       | `referee/mod.rs`                               | Enum: `MyTurn` / `TheirTurn`                                                                                 |
| `ChannelHandler`                | `channel_handler/mod.rs`                       | Manages channel state, unroll, live games                                                                    |
| `PotatoHandler`                 | `potato_handler/mod.rs`                        | Turn-taking protocol over the wire                                                                           |
| `OnChainGameHandler`            | `potato_handler/on_chain.rs`                   | Drives on-chain dispute flow                                                                                 |
| `LiveGame`                      | `channel_handler/types/live_game.rs`           | Wraps referee for a single active game                                                                       |
| `ProposedGame`                  | `channel_handler/types/proposed_game.rs`       | Pending game proposal (stored in `proposed_games`)                                                           |
| `UnrollCoin`                    | `channel_handler/types/unroll_coin.rs`         | Unroll coin state and puzzle construction                                                                    |
| `GameCradle`                    | `peer_container.rs`                            | Trait for synchronous game interaction (tests/UI)                                                            |
| `ValidationInfo`                | `channel_handler/types/validation_info.rs`     | Game validation program + state                                                                              |
| `CachedPotatoRegenerateLastHop` | `channel_handler/types/potato.rs`              | Enum for `cached_last_actions` entries: `PotatoMoveHappening`, `PotatoAcceptTimeout`, `ProposalAccepted`     |
| `BatchAction`                   | `potato_handler/types.rs`                      | Peer-level batch action variants: `ProposeGame`, `AcceptProposal`, `CancelProposal`, `Move`, `AcceptTimeout` |
| `GameAction`                    | `potato_handler/types.rs`                      | Actions: `Move`, `AcceptTimeout`, `SendPotato`, `QueuedProposal`, `CleanShutdown`, `Cheat`                   |
| `SynchronousGameCradleState`    | `peer_container.rs`                            | Per-peer mutable state: queues, flags, `peer_disconnected`                                                   |
| `OnChainGameState`              | `channel_handler/types/on_chain_game_state.rs` | Per-game-coin tracking: `our_turn`, `puzzle_hash`, `accepted`, `pending_slash_amount`, `game_timeout`        |
| `GameNotification`              | `potato_handler/effects.rs`                    | Notifications to the UI: `ChannelStatus`, proposal variants, `InsufficientBalance`, and `GameStatus { status: GameStatusKind, ... }` |
| `Effect`                        | `potato_handler/effects.rs`                    | All side effects returned by handler methods (notifications, transactions, coin registrations)               |
| `PeerHandler`                   | `peer_container.rs`                            | Trait implemented by all handlers — uniform interface for messages, coin events, game actions                |
| `HandshakeInitiatorHandler`     | `potato_handler/handshake_initiator.rs`        | Initiator handshake state machine (A → C → E → coin_created)                                                |
| `HandshakeReceiverHandler`      | `potato_handler/handshake_receiver.rs`         | Receiver handshake state machine (B → D → F → coin_created)                                                 |
| `ShutdownHandler`               | `potato_handler/shutdown_handler.rs`           | Clean shutdown flow; can fall through to `UnrollWatchHandler`                                                |
| `UnrollWatchHandler`            | `potato_handler/unroll_watch_handler.rs`       | Watches unroll coin post-channel-spend, creates `OnChainGameHandler`                                        |
| `ChannelCoinSpendInfo`          | `channel_handler/types/`                       | Solution, conditions, and aggregate signature for spending the channel coin                                  |
| `PeerMessage`                   | `potato_handler/types.rs`                      | Wire message enum: `HandshakeA`–`HandshakeF`, `Batch`, `RequestPotato`, `Message`, etc.                     |

---

## Further Reading

| Document | Covers |
| --- | --- |
| [`GAME_LIFECYCLE.md`](GAME_LIFECYCLE.md) | Game proposals, off-chain game flow, AcceptTimeout lifecycle |
| [`ON_CHAIN.md`](ON_CHAIN.md) | Dispute resolution, clean shutdown, preemption, stale unrolls, the referee, on-chain game state tracking |
| [`UX_NOTIFICATIONS.md`](UX_NOTIFICATIONS.md) | Notification types, lifecycle invariants, WASM event FIFO |
| [`INTERNALS.md`](INTERNALS.md) | Timeouts, peer disconnect, redo mechanism, cheat support, simulator strictness, test infrastructure, `game_assert!` |
| [`HANDLER_GUIDE.md`](HANDLER_GUIDE.md) | Off-chain handler API, on-chain validator conventions |
| [`clsp/handler_api.md`](clsp/handler_api.md) | CLVM calling conventions for handler functions |
| [`DEBUGGING_GUIDE.md`](DEBUGGING_GUIDE.md) | Debugging, testing, `./cb.sh` / `./ct.sh` usage |
| [`FRONTEND_ARCHITECTURE.md`](FRONTEND_ARCHITECTURE.md) | React frontend, WASM bridge, tracker relay, session persistence |

