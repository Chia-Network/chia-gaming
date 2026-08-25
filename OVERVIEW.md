# Overview: Chia Gaming State Channels

This document provides the conceptual foundation for the `chia_gaming`
codebase — a system for playing two-player games over Chia state channels.
For detailed coverage of specific areas, see [Further Reading](#further-reading)
at the end of this document.

**Alpha status:** This project is in alpha. No backwards compatibility is
maintained for anything — on-chain wire formats, persistence formats, browser
localStorage, external APIs, or internal interfaces. Breaking changes should
be expected.

## Table of Contents

- [Overview](#overview)
- [Design Philosophy: Fail Fast](#design-philosophy-fail-fast)
- [State Channels: The Core Idea](#state-channels-the-core-idea)
- [Coin Hierarchy](#coin-hierarchy)
- [The Potato Protocol](#the-potato-protocol)
- [Reference Games](#reference-games)
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

## Design Philosophy: Fail Fast

This codebase **fails fast**: when something is wrong, it surfaces the error at
the point of detection rather than papering over it. The goal is that bugs get
diagnosed and fixed at their source, not masked by defensive code that lets a
corrupted state limp along and produce a confusing failure somewhere else later.

Concretely, this means **no belt-and-suspenders backstops** — no silently
swallowing an unexpected event, no "just in case" idempotency guard around a
call that should only happen once, no defaulting a value that should never be
absent. Such backstops trade a loud, locatable failure for a quiet, mislocated
one; they hide the very bug that needs fixing and tend to accumulate into a
system nobody fully understands. When you are tempted to add a guard, first ask
whether the condition it guards against can actually occur in correct operation.
If it cannot, assert instead — don't tolerate it.

The one essential distinction is the **trust boundary**:

- **Untrusted input** — data from a peer or the blockchain — is validated and
  rejected gracefully. A peer sending a bad batch is a protocol violation we
  expect and handle (reject the batch, go on-chain); it is not a bug in our
  code, so it must never crash us.
- **Internal invariants** — conditions that can only be false if *our own* code
  is wrong — fail loudly. These use `game_assert!` / `game_assert_eq!`, which
  panic in debug/test builds (so the bug is impossible to miss) and return an
  `Err` in release builds (so a deployed process degrades into an error
  notification rather than corrupting state). The simulator applies the same
  principle on the chain side via strict mode. See
  [Invariant Assertions](INTERNALS.md#invariant-assertions-game_assert--game_assert_eq)
  and [Simulator Strictness](INTERNALS.md#simulator-strictness).

For example, an attempt to make a game move after a terminal move (one whose
validation program is nil) can only happen if a caller is buggy — so the move
handler asserts rather than silently discarding the move. Discarding it would
hide the bug and leave the broken caller in place to cause subtler problems
later.

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

**Key code:** `src/channel_state/types/channel_coin.rs`,
`ChannelState` in `src/channel_state/mod.rs`

### Unroll Coin

The unroll coin implements the **optimistic rollback** mechanism:

- **Curried parameters:** `SHARED_PUBKEY` (aggregate 2-of-2 unroll public
key), `OLD_SEQUENCE_NUMBER`, `DEFAULT_CONDITIONS_HASH`
- **Solution:** The conditions list, passed as the dotted-pair cdr of the
puzzle args.  Dispatch is via `shatree(conditions) == DEFAULT_CONDITIONS_HASH`.
- **Timeout path** (hash matches): The conditions are returned as-is.  They
include `ASSERT_HEIGHT_RELATIVE` so the spend can only land after the
timeout elapses.  These conditions create the game coins and reward coins
reflecting the last agreed state.
- **Preemption path** (hash does not match): The puzzle checks that the
conditions contain a **higher sequence number** with the correct parity,
then prepends `AGG_SIG_UNSAFE SHARED_PUBKEY (shatree conditions)` and
returns.  The aggregate signature from both unroll keys ensures the
conditions were co-signed.

**Parity rule.** Each player only ever sends half-signed states of one parity
to the opponent (based on `started_with_potato`), so each player can only
fully sign states of the parity they *receive*. The unroll puzzle requires
that a preempting state has the opposite parity from the published unroll.
This prevents a rollback attack: without the rule, a malicious player could
publish a very old unroll and immediately preempt it with a less-old-but-still-
stale state of the same parity — one they can fully sign — effectively rolling
back to a favorable earlier state. The parity constraint means you cannot both
publish and preempt; only your opponent can preempt your unroll.

**Unroll state tracking.** The code tracks `latest_sent_unroll` (the most
recent unroll we sent the opponent) and `latest_received_unroll` (the most
recent unroll received from them).  For preemption, only the latest state
is needed — it has the highest sequence number and the correct parity.
However, the opponent can broadcast *any* unroll we ever sent them (all
carry valid aggregate signatures from the time they were created).  To
identify these on-chain, the `ChannelState` maintains an
`unroll_puzzle_hash_map` that maps each unroll puzzle hash to a compact
historical record: state number, committed conditions hash, and timeout
conditions. The map deliberately does not retain historical signatures or
preemption conditions; preemption always uses a latest full record. When a
channel coin spend is detected, the `CREATE_COIN` puzzle hashes in the
on-chain conditions are matched against this map to identify which unroll
landed. Classification happens then, in `channel_coin_spent`: an old
opposite-parity state is preempted, an old same-parity state we signed is
resolved with its stored timeout conditions, and a spend we never signed
(unknown puzzle hash) or whose conditions do not match the signed record is
an error. A state we have not reached cannot be in the map, so it fails the
same never-signed check. Those old puzzle hashes cannot be
discarded: the opponent may publish any previously signed unroll, so
recognizing every historical hash is how we tell a signed timeout record
from a spend we never signed.

Browser session persistence stores the serialized game session as raw binary in
IndexedDB. Compact historical unroll records are therefore part of the durable
minimum even though obsolete full signatures and preemption conditions are not.

**Key code:** `src/channel_state/types/unroll_coin.rs`,
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
- Accept a game result (accept_settlement)
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
  - `ProposeGroup` — propose one factory-derived atomic game group
  - `AcceptProposal` — accept a pending game proposal
  - `CancelProposal` — cancel a pending proposal
  - `Move` — make a game move
  - `AcceptSettlement` — accept a game result (end game)
2. `**signatures: StateUpdateSignatures`** — two half-signatures covering the final
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
action fails validation. Rejection uses a **rollback mechanism**: before peer
batch processing begins, `OffChainPhase` snapshots both the `ChannelState` and
the local `game_action_queue`. If any action or signature verification fails,
both snapshots are restored. This makes a peer batch atomic across all state that
could otherwise affect dispute recovery: intermediate mutations to `live_games`,
`pending_settlements`, balances, `state_number`, `cached_redo_actions`, and
queued local actions are not allowed to leak out of a failed peer batch. The
error then triggers go-on-chain (the peer sent a bad batch, so we dispute
on-chain).

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

The `game_action_queue` is populated only by local API calls (user/UI actions),
never directly by received peer messages. Received batches can still make queued
local actions stale as a side effect of valid peer state changes, so failed peer
batch handling snapshots the queue as part of the atomic boundary. Separately,
`drain_queue_into_batch` processes the local queue when we hold the potato; any
errors during local draining reflect bugs or stale local intents, not a normal
peer-data recovery path.

### Non-Potato Messages

`PeerMessage::Message` (for advisory game messages) remains a separate type
that does not carry the potato and can be sent at any time.

**Key code:** `src/session_phases/mod.rs` (`OffChainPhase`, `PotatoState`)

### Handshake (6-Message Protocol)

Before play begins, the two players execute a multi-step handshake
(steps A through F) to exchange public keys, agree on channel parameters,
co-sign the initial channel coin, and transition to `OffChainPhase`.

The protocol is designed so that Alice (the initiator) commits the channel
coin ID — derived from a singleton launcher — before either party signs any
unroll state. This prevents either side from stealing funds or burning the
other's money.

Each side runs its own handler: `HandshakeInitiatorPhase` (the player who
starts the channel) and `HandshakeReceiverPhase`. The A-F labels are the
wire/message protocol labels. Internally, the split handlers use semantic
state names (`SentA`, `WaitingForLauncher`, `SentC`, etc.) while still speaking
the same A-F wire messages. Handshake messages are not sent via `Batch`:

| Step | Sender | Message | Payload type |
|------|--------|---------|--------------|
| A | Initiator | `HandshakeA` | `HandshakePayloadA` (= `HandshakePayloadB`): keys, reward ph, PoPs, contributions |
| B | Receiver | `HandshakeB` | `HandshakePayloadB`: same shape as A |
| C | Initiator | `HandshakeC` | `HandshakePayloadC`: launcher `CoinString` |
| D | Receiver | `HandshakeD` | `HandshakePayloadD`: state-0 `StateUpdateSignatures` |
| E | Initiator | `HandshakeE` | `HandshakePayloadE`: partial `SpendBundle` + state-0 sigs |
| F | Receiver | `HandshakeF` | `HandshakePayloadF`: final combined `SpendBundle` |

#### Between-message wallet interactions

Between B and C, the initiator must consult the wallet to select a coin
that will serve as the launcher parent. The library emits
`Effect::NeedLauncherCoinId`; the hosting layer (WASM wrapper or simulator)
calls `selectCoins`, computes the launcher coin, and feeds it back via
the split handler callback (`provide_launcher_coin` on the active
`PeerLifecyclePhase` implementation).

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
handlers, not in `OffChainPhase` monolithic handshake state.

The transition to `OffChainPhase` is driven by `coin_created` — the channel
coin appearing on-chain. Since the coin cannot exist before E is sent, this
is the ground truth for "the channel is live." A late-arriving `HandshakeF`
after the transition is silently ignored by `OffChainPhase`. Internally, the
split handshake handlers move from `Finished` to `Done` during this handoff:
`Finished` means the handshake's own protocol work is complete, while `Done`
means the replacement `OffChainPhase` has been created and the old handshake
handler no longer reports channel status.

#### Security properties

1. **No unroll signatures before coin ID is known:** The initiator sends the
   channel coin ID in C. Only after the receiver has this ID do they sign any
   unroll state (D). The initiator likewise only signs after verifying the
   receiver's signatures (E).
2. **Launcher verification:** The receiver checks that the launcher coin's
   puzzle hash is `SINGLETON_LAUNCHER_HASH`, ensuring the initiator cannot
   substitute an arbitrary coin.
3. **Signature symmetry:** Both sides call
   `ChannelState::verify_and_store_initial_peer_signatures` at the first
   point where they receive the peer's state-0 signatures (initiator on D,
   receiver on E), verifying and storing them before proceeding.
4. **Proof-of-possession (PoP) for aggregate keys:** The channel and unroll
   coins use simple BLS key aggregation (pk_a + pk_b). Without proof that
   each party controls the private key behind their public key, a rogue key
   attack is possible: the responder (who sees the initiator's key first)
   could craft pk_rogue = G*sk_attacker − pk_honest, making the aggregate
   entirely controlled by the attacker. To prevent this, each `HandshakeA`/`B`
   message includes a PoP for both the channel key and the unroll key:
   `Sign(sk, pk.bytes())`. The receiver verifies these before proceeding.
   (The referee key already has an implicit PoP via `reward_payout_signature`.)

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
- `chia_pushTransactions` — broadcast the final combined `SpendBundle` to the
  network, wrapped in a `TransactionRecord` (both players submit it).

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

**Key code:** `src/session_phases/handshake_initiator.rs`,
`src/session_phases/handshake_receiver.rs`,
`src/session_phases/handshake.rs` (shared types),
`src/channel_state/mod.rs` (`get_initial_signatures`,
`verify_and_store_initial_peer_signatures`)

---

## Reference Games

The repository includes three production reference games:

- **Calpoker** — simplest: a commit-reveal poker variant.
- **Space Poker** — Texas Hold'em-style with messages and a terminal.
- **Krunk** — Wordle-style atomic pair; illegal input surfaces as `MoveRejected`.

Reference games share protocol/package contracts, not frontend presentation
utilities. Each owns its amount controls, mojo formatting, settlement copy, and
keyboard behavior. Space Poker is the only reference game that currently
exposes the diagnostic cheat action.

Each game lives in one top-level package under `games/<key>/`, registered only
in [`games/registry.json`](games/registry.json) (`production` vs `test`). Package
keys are build/bootstrap identifiers. The protocol identity is the first
generated member's initial validation puzzle hash
(`initial_validation_program_hash`) — never the factory's hash or the
human-readable key. Registration discovers it by running the factory with
representative valid parameters. Adding a game means creating that conventional
package and appending the key to the registry; Chialisp compile, Rust/WASM
wiring, frontend imports, and the full-suite test aggregator are generated from
that file. See [`GAME_WRITING_GUIDE.md`](GAME_WRITING_GUIDE.md). Handler and
validator walkthroughs for the reference games are in
[`HANDLER_GUIDE.md`](HANDLER_GUIDE.md#worked-examples-reference-games).

The Rust game collection also registers `debug` (test list) for simulator tests
only. It is not a user-facing reference game.

---

## Handler Architecture

The system uses a **lifecycle phase** pattern to manage the channel session.
All phases implement the `PeerLifecyclePhase` trait (defined in `src/game_session.rs`),
which provides a uniform interface for receiving messages, responding to
coin-watching events, and performing game actions. The `GameSession`
holds a single `Box<dyn PeerLifecyclePhase>` and routes all events through it.
The trait has no behavioral defaults: every concrete phase explicitly defines
every operation as valid behavior, an intentional no-op, or a phase-specific
error. This keeps `GameSession` phase-agnostic and makes additions to the
operation surface a compile-time checklist for every phase. Phase-specific
operations such as handshake start and timeout status updates also use this
interface rather than runtime type downcasts.

When a phase is complete, it produces the next phase via
`take_next_phase()`. The session detects this in `detect_phase_transition`
and swaps in the new phase. Each concrete phase constructs its own successor
because it owns the state-transfer knowledge; the successors deliberately have
different constructor shapes. This creates a linear progression through the
channel lifecycle:

```
HandshakeInitiator ─┐
                     ├─→ OffChainPhase ─→ SpendChannelCoinPhase ─→ OnChainPhase
HandshakeReceiver  ─┘
```

### Peer Handlers vs States

Two related but distinct concepts appear throughout the docs:

- **Peer handlers** are concrete Rust types implementing `PeerLifecyclePhase` (for
example `OffChainPhase`, `SpendChannelCoinPhase`). They model
which component currently owns protocol logic.
- **States** are notification-level enums exposed to the UI and tests:
`ChannelStatus` and `GameStatusKind` (inside `GameNotification::GameStatus`).
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

### Runtime Ownership: Rust Engine vs JavaScript Host

Rust is the sole authority for protocol facts and business lifecycle: channel
and game validation, potato ownership, proposal legality, settlement, on-chain
transitions, watch registration and ordering, and spend intent. `GameSession`
and its phases emit protocol intents and interpret ordered observations;
`TransactionManager` durably owns watch lifecycle and raw-chain reconciliation.
Neither the browser nor a wallet adapter may infer or override a protocol
outcome.

JavaScript is the browser host. It transports opaque peer bytes, persists and
replays transport state, adapts wallet and chain APIs, forwards raw chain
observations, and projects Rust facts into UI. It may enforce explicit product
capability policy—for example, this client currently starts at most one
concurrent proposal group—but proposal groups are atomic only at formation and
acceptance: Krunk's paired games still progress and settle independently.
It does not maintain a game-move replay journal. Post-unroll redo is
reconstructed from Rust-owned channel and on-chain state; after browser restore,
a game's normal state-driven effect may resubmit an automatic action only when
the restored canonical state still precedes that action.

| Concern | Owner |
| --- | --- |
| Protocol phases, game/channel facts, validation, lifecycle, spends; watch lifecycle and ordering | Rust |
| Raw peer bytes, ACK durability, wallet RPC, chain polling | JavaScript host |
| UI projection, notification presentation, client capability constraints | JavaScript UI |

The browser also separates three lifetimes that end at different moments.
Protocol lifetime ends only after queued terminal reductions and the durable
terminal snapshot are flushed, at which point the real controller and transport
attachments are destroyed. Visual lifetime can continue: the same React hand
component and `handKey` remain mounted, but receive the finalized model through
the `frozen: true` branch of the same mount contract, which structurally has no
intent port. Cold restoration is separate again:
`FinishedSessionGameView` remounts a validated persisted Cal Poker, Space Poker,
or Krunk hand only when no live tree survived (for example, after reload).

### Handlers

| Handler | File | Role |
|---------|------|------|
| `HandshakeInitiatorPhase` | `session_phases/handshake_initiator.rs` | Initiator side of the handshake (sends A, C, E). Linear state machine; transitions to `OffChainPhase` when the channel coin appears on-chain. |
| `HandshakeReceiverPhase` | `session_phases/handshake_receiver.rs` | Receiver side of the handshake (sends B, D, F). Same transition trigger. |
| `OffChainPhase` | `session_phases/mod.rs` | Off-chain game play: batching actions, exchanging the potato, proposing/accepting/playing games. |
| `SpendChannelCoinPhase` | `session_phases/spend_channel_coin_phase.rs` | Watches the channel coin spend and handles both clean shutdown (change coin observation) and unroll paths. Handles preemption, forward-aligns game state, always transitions to `OnChainPhase`. |
| `OnChainPhase` | `session_phases/on_chain.rs` | On-chain dispute resolution: submits moves, claims timeouts, detects slashes. Driven entirely by coin-watching events, not peer messages. |

Shared utilities used by multiple handlers (e.g. `build_channel_to_unroll_bundle`,
`emit_failure_cleanup`) live in `src/session_phases/handler_base.rs`.

**Key code:** `src/game_session.rs` (`PeerLifecyclePhase` trait, `detect_phase_transition`)

---

## Code Organization

### Core layers (bottom to top)


| Layer                     | Directory / File                             | Responsibility                                                               |
| ------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------- |
| **Types & Utilities**     | `src/common/`                                | `CoinString`, `PuzzleHash`, `Amount`, `Hash`, `AllocEncoder`, etc.           |
| **Referee**               | `src/referee/`                               | Per-game state machine: moves, timeouts, slashes                             |
| **Channel State**         | `src/channel_state/`                       | Channel/unroll/game coin management, balance tracking                        |
| **Handshake Handlers**    | `src/session_phases/handshake_initiator.rs`, `handshake_receiver.rs` | Handshake state machines (A-F), one per side              |
| **Off-Chain Phase**       | `src/session_phases/mod.rs`                  | Off-chain game play: batching, potato exchange, proposals, moves             |
| **Spend Channel Coin Phase** | `src/session_phases/spend_channel_coin_phase.rs` | Watches channel coin spend; handles clean shutdown and unroll paths, creates OnChainPhase |
| **On-Chain Phase**        | `src/session_phases/on_chain.rs`             | Post-unroll dispute resolution: coin watching, timeouts, slashes (no potato) |
| **Handler Base**          | `src/session_phases/handler_base.rs`         | Shared utilities: `build_channel_to_unroll_bundle`, `emit_failure_cleanup`   |
| **Game Session**          | `src/game_session.rs`                      | `PeerLifecyclePhase` trait, `GameSession` struct                          |
| **Simulator**             | `src/simulator/`                             | Block-level simulation for integration tests                                 |


### Chialisp puzzles


| File                                          | Purpose                                                   |
| --------------------------------------------- | --------------------------------------------------------- |
| `clsp/unroll/unroll_puzzle.clsp`              | Unroll coin: timeout vs challenge with sequence numbers   |
| `clsp/referee/onchain/referee.clsp`           | Game coin: move / timeout / slash enforcement             |
| `clsp/games/game_codes.clinc` | Shared game error codes                                      |
| `games/calpoker/clsp/onchain/{a,b,c,d,e}.clsp` | Calpoker validation programs (one per protocol step) |
| `games/calpoker/clsp/calpoker_generate.clinc` | Off-chain calpoker handlers (Alice & Bob sides)      |
| `games/spacepoker/clsp/onchain/*.clsp`       | Space Poker validation programs                           |
| `games/spacepoker/clsp/spacepoker_generate.clinc` | Off-chain Space Poker handlers                        |
| `games/krunk/clsp/onchain/{commit,guess,clue}.clsp` | Krunk validation programs                           |
| `games/krunk/clsp/krunk_generate.clinc`      | Off-chain Krunk handlers (Alice & Bob sides)              |
| `games/krunk/clsp/factory_args.clvm.bin`| Generated factory curry arguments: `(pubkey signed_dict_tree)` |
| `games/debug/clsp/factory.clsp`             | Debug game: validator, my-turn, their-turn, and factory   |
| `clsp/handler_api.md`                         | Handler calling conventions (see also `HANDLER_GUIDE.md`) |


### Test infrastructure


| File                                        | Purpose                                                  |
| ------------------------------------------- | -------------------------------------------------------- |
| `games/calpoker/rust/tests/sim.rs`          | Calpoker test registration and helpers                   |
| `games/spacepoker/rust/tests/sim.rs`        | Space Poker test registration and helpers                |
| `games/krunk/rust/tests/sim.rs`             | Krunk test registration and helpers                      |
| `games/debug/rust/mod.rs`                   | Debug game: minimal game with controllable `mover_share` |
| `src/simulator/tests/session_phases_sim.rs` | Integration tests including notification suite           |
| `src/test_support/peer/peer_harness.rs`   | Test peer helper                                         |
| `src/test_support/sim_script.rs`                  | `SimScriptAction` enum and simulation loop driver        |
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
| `ChannelState`                | `channel_state/mod.rs`                       | Manages channel state, unroll, live games                                                                    |
| `OffChainPhase`                 | `session_phases/mod.rs`                        | Turn-taking protocol over the wire                                                                           |
| `OnChainPhase`            | `session_phases/on_chain.rs`                   | Drives on-chain dispute flow                                                                                 |
| `LiveGame`                      | `channel_state/types/live_game.rs`           | Wraps referee for a single active game                                                                       |
| `ProposedGame`                  | `channel_state/types/proposed_game.rs`       | One pending member of a factory-derived atomic group stored in `proposed_games` |
| `UnrollCoin`                    | `channel_state/types/unroll_coin.rs`         | Unroll coin state and puzzle construction                                                                    |
| `GameSession`                    | `game_session.rs`                              | Production session host: owns current phase, queues, emits `GameSessionEvent`s                                |
| `ValidationInfo`                | `channel_state/types/validation_info.rs`     | Game validation program + state                                                                              |
| `CachedRedoActions` | `channel_state/types/potato.rs`              | Enum for `cached_redo_actions` entries: `CachedSendMove`, `CachedAcceptSettlement`, `ProposalAccepted`     |
| `BatchAction`                   | `session_phases/types.rs`                      | Peer-level batch action variants: group-level `ProposeGroup`, per-ID `AcceptProposal` / `CancelProposal` expanded atomically by the higher layer, `Move`, `AcceptSettlement` |
| `GameAction`                    | `session_phases/types.rs`                      | Actions: `Move`, `AcceptSettlement`, `CleanShutdown`, `QueuedProposalGroup`, `QueuedAcceptProposal`, `QueuedCancelProposal`, `QueuedCancelProposalSilently`, `Cheat` |
| `GameSessionState`    | `game_session.rs`                              | Per-session mutable state: queues, flags, `peer_disconnected`                                                |
| `OnChainGameState`              | `channel_state/types/on_chain_game_state.rs` | Per-game-coin tracking: `our_turn`, `puzzle_hash`, `timeout_claim_armed`, `timeout_claim`, `pending_slash_amount`, `game_timeout` |
| `SettlementOutcome`             | `session_phases/effects.rs`                    | Settlement glossary ids (snake_case wire): off-chain `accept_settlement` plus on-chain outcomes #1–#11; see [Settlement glossary](NAMING_AUDIT.md#settlement-glossary-ux) |
| `GameNotification`              | `session_phases/effects.rs`                    | Notifications to the UI: `ChannelStatus`, proposal variants, `InsufficientBalance`, gameplay `GameStatus { status: GameStatusKind, ... }`, and unified settlement `GameSettled { id, outcome, our_share, coin_id }` |
| `Effect`                        | `session_phases/effects.rs`                    | All side effects returned by handler methods (notifications, transactions, coin registrations)               |
| `PeerLifecyclePhase`                   | `game_session.rs`                              | Trait implemented by all lifecycle phases — uniform interface for messages, coin events, game actions        |
| `HandshakeInitiatorPhase`     | `session_phases/handshake_initiator.rs`        | Initiator handshake state machine (A → C → E → coin_created)                                                |
| `HandshakeReceiverPhase`      | `session_phases/handshake_receiver.rs`         | Receiver handshake state machine (B → D → F → coin_created)                                                 |
| `SpendChannelCoinPhase`       | `session_phases/spend_channel_coin_phase.rs` | Watches channel coin spend; clean shutdown detection + unroll handling, creates `OnChainPhase`         |
| `ChannelCoinSpendInfo`          | `channel_state/types/`                       | Solution, conditions, and aggregate signature for spending the channel coin                                  |
| `PeerMessage`                   | `session_phases/types.rs`                      | Wire message enum: `HandshakeA`–`HandshakeF`, `Batch`, `RequestPotato`, `Message`, etc.                     |

---

## Further Reading

| Document | Covers |
| --- | --- |
| [`GAME_WRITING_GUIDE.md`](GAME_WRITING_GUIDE.md) | How to write a game: package layout, registry hook, host and CLVM APIs |
| [`GAME_LIFECYCLE.md`](GAME_LIFECYCLE.md) | Game proposals, off-chain game flow, AcceptSettlement lifecycle |
| [`ON_CHAIN.md`](ON_CHAIN.md) | Dispute resolution, clean shutdown, preemption, stale unrolls, the referee, on-chain game state tracking |
| [`UX_NOTIFICATIONS.md`](UX_NOTIFICATIONS.md) | Notification types, lifecycle invariants, WASM event FIFO |
| [`INTERNALS.md`](INTERNALS.md) | Timeouts, peer disconnect, redo mechanism, cheat support, simulator strictness, `game_assert!` |
| [`SIMULATOR_TESTING.md`](SIMULATOR_TESTING.md) | Simulator test harness, `SimScriptAction` reference, trigger semantics, test-writing conventions |
| [`HANDLER_GUIDE.md`](HANDLER_GUIDE.md) | Off-chain handler API, on-chain validator conventions |
| [`clsp/handler_api.md`](clsp/handler_api.md) | CLVM calling conventions for handler functions |
| [`DEBUGGING_GUIDE.md`](DEBUGGING_GUIDE.md) | Debugging, testing, `./cb.sh` / `./ct.sh` usage |
| [`FRONTEND_ARCHITECTURE.md`](FRONTEND_ARCHITECTURE.md) | React frontend, WASM bridge, hub relay, session persistence |
| [`CLVM_DOS.md`](CLVM_DOS.md) | CLVM denial-of-service vectors: ladder bombs, execution cost, trust categories per call site, solution constraints |

