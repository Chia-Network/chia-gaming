# Overview: Chia Gaming State Channels

This document provides the conceptual foundation for the `chia_gaming`
codebase — a system for playing two-player games over Chia state channels.
For detailed coverage of specific areas, see [Further Reading](#further-reading)
at the end of this document.

**Early beta status:** The project works, but bugs are still likely. Backwards
compatibility is attempted across on-chain wire formats, persistence formats,
browser localStorage, external APIs, and internal interfaces, but it remains
best-effort and may be unreliable. Breaking changes are still possible.

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
commitment with an incremented sequence number. Each player holds the latest
state received from the opponent, while the sender retains the preceding
fully-signed state until the next pass. If either player publishes an old state,
the other can preempt with the newer opposite-parity state they received.

---

## Coin Hierarchy

```
Funding coins (one per player)
    │
    ├── Receiver offer → Settlement → one-time Pre-launcher
    │                                      │
    │                                      ▼
    │                           zero-value Singleton Launcher
    ├── Initiator offer → Settlement → quoted Contribution Coin
    │                                      │
    │                                      └── asserts launcher announcement
    │
    └──────────────────────────────▶ Channel Coin ── 2-of-2 multisig
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

- Created as a child of a **zero-value standard singleton launcher**. The
receiver's persisted funding offer fixes its ancestry through a signed one-time
pre-launcher; the initiator's quoted contribution coin asserts the launcher's
announcement. CHIP-25 messages bind both wallet spends without host-selected
coin IDs.
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

The handshake establishes this invariant immediately. The receiver's D message
gives the initiator the fully signed even state 0. The initiator's E message
gives the receiver the fully signed odd state 1 with the same opening payout.
The receiver then starts off-chain play with the potato and sends even state 2
in the first ordinary Batch.

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

Every ordinary potato pass is a single `PeerMessage::Batch` containing:

1. `**actions: Vec<BatchAction>`** — zero or more game operations to apply
  sequentially:
  - `Propose` — propose one factory-derived request
  - `AcceptProposal` — accept one pending proposal
  - `CancelProposal` — cancel one pending proposal
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
   The signatures are always verified. Clean shutdown is not a Batch field: the
potato holder sends `PeerMessage::CleanShutdown { channel_half_sig }`. Both
peers derive the same canonically ordered direct payouts from the agreed
balances and handshake reward puzzle hashes. The responder returns only its
half in `PeerMessage::CleanShutdownComplete { channel_half_sig }`; each peer
locally combines and consensus-validates the finished spend before submission.
If actions are queued before shutdown, they are first flushed in an ordinary
Batch and the sender requests the potato back.

The receiver processes actions sequentially and rejects the entire batch if any
action fails validation. Untrusted `PeerMessage::Batch` processing runs against
an explicit cloneable rollback snapshot containing channel state, local actions,
incoming messages, potato ownership, peer-potato intent, clean-shutdown
correlation, last spend commitment, and height. If any action or signature
verification fails, the complete working state is restored and no effects or
replacement phase are published. A separate narrow snapshot protects received
`CleanShutdown`, which cancels proposals before its peer signature is
validated. Other trusted local mutations fail loudly instead of paying for a
broad transactional wrapper. Invalid peer data triggers go-on-chain only after
rollback.

After a valid received batch commits, queued local game actions are reconciled
once against the new peer state. Known stale moves, settlements, and cheats are
removed with `ActionFailed`; the remaining queue is drained once. An unexpected
local drain failure is an internal error, not a retryable peer-batch condition.

This rollback scope is an architectural invariant. Core atomicity exists to
isolate mutations made while validating untrusted peer input; it is not a
general transaction abstraction for trusted local UI calls, height updates,
coin observations, ordinary queue drains, or `go_on_chain`. Do not widen the
snapshot boundary to those paths. A valid peer batch must commit before stale
local intents are reconciled.

Because the batch comes with the potato, the sender constructed it while holding
the definitive state. Every action in the batch should be valid against that
state — any failure is a protocol violation by the peer, not a benign race.

The sender is responsible for ordering actions correctly. Proposal acceptances
run in batch order against the balances left by earlier actions.

Only one move per game is allowed per batch, enforced by the existing turn-taking
rules (you can't move on your opponent's turn).

The `current_state_number` increments once per batch, not per action.

### Message-Level Validation

Before batch processing begins, two checks protect the receiver:

- **Local receive policy:** The browser defaults reject message bodies larger
than 10 MiB and bound future-number distance, queued message count, and queued
bytes. These configurable denial-of-service limits are local policy, not
negotiated protocol constants.
- **Double-potato detection:** If a `Batch` arrives while we already hold the
potato (`PotatoState::Present`), it is rejected as a protocol violation.
Only one player can hold the potato at a time; receiving a second batch
means the peer is misbehaving.

### Local Action Queueing

When a local action is requested (move, proposal, accept, etc.), it follows a
unified pattern:

1. The action is placed on an internal queue.
2. The session requests or uses the potato:
  - If we hold the potato: drain all queued actions into a single batch and send
  - If we don't hold the potato: send a `RequestPotato` message

This ensures that multiple user actions between potato receives are
automatically batched together.

Moves have a stricter preparation boundary than the other queue entries. The
local move directive first validates that this game currently grants us the
turn and has no queued or pending move, then immediately runs the my-turn
handler. A tagged two-value rejection is returned synchronously as
`MoveRejected`; the invalid readable is never queued. Success queues only the
durable, uncurried `PreparedMove` handler outputs: move bytes, mover share,
waiting handler, and optional message parser. It retains no validator programs
or maximum move size. The readable UI input and entropy are not retained, nor
are later-derived transaction data, a curried referee, or a referee puzzle hash.

When the potato is available—or when an already prepared move is actuated
on-chain—the engine runs the current validator from the factory registry with
the move and nil evidence, resolves a returned non-nil next validator hash in
that registry, and consumes the `PreparedMove` to apply the referee transition,
curry and hash the resulting puzzle, sign as required, and send the batch or
spend. The registry is a proper nonempty list in factory field 9: its first
entry is initially current and later order is irrelevant because lookup is by
tree hash. A nil next validator hash is terminal and must agree with a nil next
handler. Mover share remains handler-owned. The engine does not run the my-turn
handler again. Only after application
does the separate `cached_redo_actions` state record the post-application facts
needed to replay a move after an unroll; the prepared queue is not the redo
cache.

On receipt, validator execution has three distinct jobs and is deliberately not
collapsed into one cached probe. Rust first runs the current local
factory-registry program with the bounded move and nil evidence to discover the
candidate next hash, state, and size limit. It then commits those values into a
real referee and slash-invokes nil evidence. A surviving move is evaluated with
the committed arguments to supply state to the their-turn handler, after which
every handler evidence candidate is tried in order through another slash
invocation. The peer never supplies executable programs, and handlers never
return validator programs; non-nil next hashes are resolved in the local
registry.

The `game_action_queue` is populated only by local API calls (user/UI actions),
never directly by received peer messages. A valid received batch commits its
peer-authored state first. Rust then reconciles queued local intents against
that committed state; stale intents produce `ActionFailed` without rejecting or
rolling back the valid peer batch. Separately, `drain_queue_into_batch`
processes the local queue when we hold the potato; errors during local draining
reflect bugs or stale local intents, not a peer-data recovery path.

### Non-Potato Messages

`PeerMessage::Message` (for advisory game messages) remains a separate type
that does not carry the potato and can be sent at any time.

**Key code:** `src/session_phases/mod.rs` (`OffChainPhase`, `PotatoState`)

### Handshake (4-Message Protocol)

Before play begins, the two players execute a multi-step handshake
(steps A through D) to exchange public keys, agree on channel parameters,
co-sign the initial channel coin, and transition to `OffChainPhase`.

The receiver obtains its funding offer first. Its OFFER_MOD settlement output
creates a one-time standard-puzzle pre-launcher, which creates and concurrently
spends a zero-value singleton launcher. This fixes the channel ancestry before
either party signs an unroll state without requiring the host to select or
name a wallet coin.

Each side runs its own handler: `HandshakeInitiatorPhase` (the player who
starts the channel) and `HandshakeReceiverPhase`. The A-D labels are the
wire/message protocol labels. A and B include a text-to-`u32` capabilities map;
`peer_protocol = 1` is required and unknown capability keys are ignored.
Handshake messages are not sent via `Batch`:

| Step | Sender | Message | Payload type |
|------|--------|---------|--------------|
| A | Initiator | `HandshakeA` | keys, reward ph, PoPs, and contributions |
| B | Receiver | `HandshakeB` | receiver identity, pre-launcher ID, and state-0 signatures |
| C | Initiator | `HandshakeC` | initiator funding bundle and state-1 signatures |
| D | Receiver | `HandshakeD` | receiver funding/acceptance bundle |

#### Between-message wallet interactions

After A, the receiver requests a persisted funding offer for
`contribution + opening_fee`. The wallet spend carries a mode-16
`RECEIVE_MESSAGE` from the pre-launcher's puzzle hash. The library completes
the settlement output into that pre-launcher, signs it with a dedicated
one-time private key persisted in the handshake state, and sends B only after
the ancestry and state-0 signatures are known.

After B, the initiator requests its own persisted funding offer for
`contribution + opening_fee`. Its wallet spend receives a mode-24 nil message
from a quoted contribution coin identified by puzzle hash and amount. That
coin reserves the opening fee and asserts the singleton launcher's
announcement. The initiator sends the completed half and state-1 signatures
in C.

Once each role knows the predicted channel coin, Rust registers it directly.
The channel coin's later creation completes activation; the local wallet
funding input is validated as part of the assembled transaction but is not an
intermediate protocol watch.

On C, the receiver first validates the complete assembled funding transaction
and verifies state 1 against a staged channel-state clone. Only after every
check succeeds does it commit genesis state, send its acceptance half in D, and
submit the locally assembled transaction. A rejected C leaves the receiver
byte-for-byte unchanged and may be followed by a valid retry. The initiator
independently combines and validates C and D before submission. Neither endpoint
accepts an untrusted aggregate bundle supplied by its peer.

#### State machine

Initiator (`have_potato = false` after C):

```
WaitingForStart → SentA → WaitingForOffer → Finished
   (send A)       (recv B, initialize state 1, request wallet offer, send C)
```

Receiver (`have_potato = true` after receiving state 1 in C):

```
WaitingForA → WaitingForOffer → SentB → Finished
 (recv A, request wallet offer, derive ancestry/send B, recv C/send D)
```

Handshake-specific wallet callback plumbing now lives in the split handshake
handlers, not in `OffChainPhase` monolithic handshake state.

The transition to `OffChainPhase` requires completed role-specific handshake
work and `coin_created` — the channel coin appearing on-chain. D and the local
coin observation may arrive in either order. Once a side has finished its
role-specific handshake work, non-handshake activation-lag messages are
retained and transferred FIFO into the off-chain phase. A late D is ignored
after the initiator has already transitioned. Internally, the
split handshake handlers move from `Finished` to `Done` during this handoff:
`Finished` means the handshake's own protocol work is complete, while `Done`
means the replacement `OffChainPhase` has been created and the old handshake
handler no longer reports channel status.

#### Security properties

1. **No unroll signatures before coin ID is known:** B commits the pre-launcher
   ID and therefore the zero-value singleton launcher and channel coin before
   the initiator accepts state 0 or signs state 1.
2. **One-time ancestry key:** The receiver's pre-launcher uses a separately
   generated private key, persisted only as handshake/session key material and
   never reused as a channel, unroll, or referee key.
3. **Signature ordering:** B carries state-0 signatures; C verifies them,
   advances the initiator to state 1, and returns state-1 signatures. The
   receiver verifies those signatures before D and starts off-chain as the
   initial potato holder, ready to send state 2.
4. **Proof-of-possession (PoP) for aggregate keys:** The channel and unroll
   coins use simple BLS key aggregation (pk_a + pk_b). Without proof that
   each party controls the private key behind their public key, a rogue key
   attack is possible: the responder (who sees the initiator's key first)
   could craft pk_rogue = G*sk_attacker − pk_honest, making the aggregate
   entirely controlled by the attacker. To prevent this, each `HandshakeA`/`B`
   message includes a PoP for both the channel key and the unroll key:
   `Sign(sk, pk.bytes())`. The receiver verifies these before proceeding.
   (The referee key already has an implicit PoP via `reward_payout_signature`.)
5. **Locally assembled funding transaction:** Handshake D is the receiver's
   acceptance only. Both endpoints combine their exact C and D halves and run
   Chia consensus validation over the result. Duplicate spends, signatures,
   messages, and launcher-announcement dependencies are checked as one
   transaction.
   Neither endpoint submits an untrusted combined bundle from the peer.

#### Wallet API interaction

The handshake requires one offer from each wallet:

| Call | When | Purpose |
|------|------|---------|
| `createOfferForIds(amount + fee, conditions)` | After A (receiver) | Fix the pre-launcher ancestry and receiver funding half |
| `createOfferForIds(amount + fee, conditions)` | After B (initiator) | Build the quoted contribution funding half |

Both calls let the wallet select and reserve their inputs. Persisting the
offers prevents two concurrent sessions—or both peers using the same
wallet—from selecting the same unspent coin. The extra conditions bind those
inputs to protocol-owned children using CHIP-25 messages; no host coin-ID
selection callback is required.

In the **simulator** these are implemented by `Simulator::select_coins` and
the `create_offer_for_ids` HTTP endpoint (which calls
`standard_solution_partial` to produce a signed spend). In the **real wallet**
they map to WalletConnect RPCs:

- `chia_createOfferForIds` — create a signed `SpendBundle` with the specified
  conditions and amount. The `extraConditions` parameter carries the
  channel-specific message receive and height conditions.
- `chia_pushTransactions` — broadcast the assembled funding `SpendBundle` to the
  network, wrapped in a `TransactionRecord` (both players submit the transaction
  they assembled locally).

#### Channel coin funding

The channel coin is created via a **standard singleton launcher**. For
offer-based wallets, the funding transaction contains seven logical spends:

1. **Receiver wallet coin** — creates an OFFER_MOD settlement output and
   receives the pre-launcher's mode-16 message.
2. **Receiver settlement coin** — creates a `contribution + fee` pre-launcher.
3. **Pre-launcher** — a one-time standard puzzle that sends the wallet message,
   reserves the fee, creates the zero-value launcher, and requires it be spent.
4. **Initiator wallet coin** — creates its OFFER_MOD settlement output and
   receives a mode-24 message from the contribution coin's puzzle hash and amount.
5. **Initiator settlement coin** — creates the quoted contribution coin.
6. **Contribution coin** — sends the wallet message, reserves the fee, and
   asserts the launcher announcement.
7. **Launcher coin** — the standard zero-value launcher puzzle, whose solution is
   `(channel_puzzle_hash, total_amount, ())`.

The two wallet inputs provide both contributions plus both opening fees; the
launcher creates a channel worth the contributions, leaving exactly the two
declared fees. Opening bundles are marked so submission does not attach a
second fee. Cloud Wallet uses the same persisted-offer settlement shape as
WalletConnect, including the protocol-provided CLVM conditions. Its wallet and
offer operations use the Cloud Wallet GraphQL API, while peak, coin, puzzle,
and transaction-submission traffic is relayed unchanged through that API's
Coinset proxy.

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
generated member's first validation-program hash
(`initial_validation_program_hash`) — never the factory's hash or the
human-readable key. Registration discovers it by running the factory with
representative valid parameters. Adding a game means creating that conventional
package and appending the key to the registry; Chialisp compile, Rust/WASM
registration, frontend imports, and factory presets are generated from that
file. Rust package modules and full-suite test aggregation are generated only
when their optional Rust source files exist. See
[`GAME_WRITING_GUIDE.md`](GAME_WRITING_GUIDE.md). Handler and validator
walkthroughs for the reference games are in
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

This is a security-sensitive application that constructs transactions
controlling real value. Rust is therefore also the mandatory home for logic
equivalent to backend business logic: authorization, transaction construction
and validation, fee policy and attachment, and durable submission/retry state.
JavaScript's dynamic browser and provider surface is useful for integration but
is not a suitable source of truth for those rules. Moving such logic into the
host requires an explicit architectural justification, not mere implementation
convenience.

JavaScript is the browser host. It transports opaque peer bytes, persists and
replays transport state, adapts wallet and chain APIs, forwards raw chain
observations, and projects Rust facts into UI. It enforces an intentional
one-uncancelled-proposal admission policy across local and peer proposals.
Rust's protocol model still supports multiple pending proposals, and a
successful acceptance may create multiple games: Krunk's paired games still
progress and settle independently.
It does not maintain a game-move replay journal. Post-unroll redo is
reconstructed from Rust-owned channel and on-chain state; after browser restore,
a game's normal state-driven effect may resubmit an automatic action only when
the restored canonical state still precedes that action.

Outbound transactions carry a Rust-owned stable identifier, expiry, and
captured fee intent. Exact canonical content is used only for idempotent
deduplication: different transactions that spend the same inputs receive
different IDs, and rejection retires only the named intent. Wallet delivery
acknowledgement and chain finality are separate. Ordinary reconnect replay is
limited to unacknowledged submissions, but any detected reorg resets and queues
retained, unexpired transactions once per rollback epoch, including
wallet-acknowledged ones. A lower tip replays the surviving retained set; an
equal-or-higher replacement tip replays only a transaction whose watched output
is explicitly absent while an input from that same bundle is explicitly live.
All replay paths reuse the exact wallet-finalized bundle and original fee.

Rust captures the configured fee amount, target, and explicit
`SubmitWithoutFee` attachment-failure policy when an intent is emitted.
Wallet adapters perform one attempt and return only a typed
acknowledged/unavailable/rejected outcome. Structured success or a response
identifying the exact same transaction as already included is idempotent
success. Failure to complete communication with the wallet is unavailable; an
error returned by the wallet is rejected. Adapters preserve that provenance
instead of deriving retry policy from consensus, mempool, or coin-status text.
Fee-bearing wallet outputs from either WalletConnect or Cloud Wallet are
validated and aggregated by one Rust boundary, including complete aggregate
signature verification for `AGG_SIG_UNSAFE`. JavaScript does not inspect
protocol bundle names, puzzles, inputs, or ordering, choose fee fallback, or
own durable retry state.

Blockchain observations have an explicit transaction boundary inside
`TransactionManager`. Each observation pays an intentional Bencodex
serialize/deserialize cost to create a deep working copy of the full durable
manager and nested `GameSession`; effects-only rollback cannot cover the
protocol mutations made by callbacks. Pending events, watch/unwatch deltas,
cradle output, and other skipped observation bookkeeping live in a separate
transient journal that is restored unchanged on failure or prepended to new
output on commit. Observation callbacks use a fresh scratch allocator, and all
surviving CLVM values own serialized `Program` bytes rather than allocator-local
`NodePtr`s.

Each game package owns its concrete mutable hand. Fresh hands are created from
accepted initialization terms; restored hands are constructed directly from
only their saved state. The shared hand boundary exposes `getState()` plus
host-delivered updates. For a protocol action the game mutates its own hand
first; the browser keeps the previous canonical hand only as a temporary
synchronous rollback checkpoint. If Rust rejects the command, the browser
restores that checkpoint. If Rust accepts the command as queued or already
applied, the mutated complete hand becomes canonical immediately and is
persisted atomically with Rust's serialized prepared-action queue. There is no
durable `pendingCandidates` layer. `LocalActionApplied` is host-only
protocol-presentation bookkeeping: it may advance the host's turn display, but
does not promote game-owned state or grant the game permission to act.

Proposal persistence stores the exact opaque Bencodex parameter value together
with the generic player-A/player-B terms and sender orientation. Each package
decodes that value only for its own form, display, and hand initialization;
there are no game-specific proposal save keys. The host tracks each pending
proposal as one scalar endpoint-local record. Rust runs the factory at
acceptance and reports the complete ordered generated-game list; each package
asserts that accepted topology when creating a fresh hand.

The current browser admits exactly one uncancelled proposal across both origins.
A second incoming proposal is definitively cancelled without being admitted to
the frontend model; a cancellation-queued proposal no longer occupies the
slot. This is a temporary UI capability while the product presents one hand at
a time, not a protocol restriction. Rust deliberately retains multi-proposal
support so future multi-hand UX can lift the admission policy without changing
the wire or core ledger.

| Concern | Owner |
| --- | --- |
| Protocol phases, game/channel facts, validation, lifecycle, spends; fee and submission intent; watch/retry lifecycle and ordering | Rust |
| Raw peer bytes, peer ACK durability, one-shot wallet RPC, chain polling | JavaScript host |
| UI projection, notification presentation, client capability constraints | JavaScript UI |

`SessionMachineRuntime` is the sole active browser durability coordinator. It
drains every consequence of a stimulus to a fixed point: reducer work, commands,
controller/WASM results, generated events, UX-model updates, and reliable
transport changes. It then synchronously captures one combined
machine/WASM/reliable boundary and attempts one atomic write before projecting
React state and releasing sends/ACKs. This same rule applies while completing
work after rehydration. React projection is not part of the drain; holding it
until the persistence attempt finishes prevents transient UX states and
flicker.

Persistence is checkpointing, not permission to continue a game for money. If
the browser write fails, the runtime reports a persistent durability warning
but still projects and releases that captured boundary exactly once. The
in-memory state remains dirty and a later activity retries the checkpoint
without resending already released effects; there is no immediate retry spin.
This deliberately accepts a degraded crash window: if the page dies before a
later write succeeds, the peer or chain may have advanced beyond the last local
checkpoint. Refusing to continue solely because local storage failed would be
the worse failure mode.

A released effect is deduplicated by key only while pending. Duplicate callers
receive the same promise, which settles with the launched external work. The
persistence attempt gates launching that work but does not await its completion;
the key is removed before launch so reentrant work may schedule the same key for
a later boundary.

No active-session adapter, reducer effect, or protocol callback may establish a
competing save, render, or send boundary. New event sources must enter the same
fixed-point drain.

The browser also separates three lifetimes that end at different moments.
Protocol lifetime ends only after queued terminal reductions and the durable
terminal snapshot has been prepared and its persistence attempt finishes. A
failure warns and degrades crash durability, but prepared external effects and
controller/transport teardown still proceed exactly once. Visual lifetime can
continue: the same React hand component and `handKey` remain mounted, but
receive the finalized model through the `frozen: true` branch of the same mount
contract, which structurally has no intent port. The retained hand is restored
from that finalized terminal model; `frozen` means terminal, read-only, and no
port, not stale pre-finalization game state. Cold restoration is separate again:
`FinishedSessionGameView` always attempts a package's frozen mount from valid
persisted hand state when no live tree survived (for example, after reload).

### Handlers

| Handler | File | Role |
|---------|------|------|
| `HandshakeInitiatorPhase` | `session_phases/handshake_initiator.rs` | Initiator side of the handshake (sends A and C). Transitions after local channel observation. |
| `HandshakeReceiverPhase` | `session_phases/handshake_receiver.rs` | Receiver side (sends B and D and starts with the potato). Same local observation gate. |
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
| **Handshake Handlers**    | `src/session_phases/handshake_initiator.rs`, `handshake_receiver.rs` | Four-message handshake state machines, one per side       |
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
| `ct-automation.sh`                         | Preferred quiet full-suite wrapper for automation and LLM agents |
| `tools/local-wasm-tests.sh`                 | Local JS/WASM integration test runner                    |


---

## Key Types


| Type                            | Location                                       | Purpose                                                                                                      |
| ------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------ |
| `CoinString`                    | `common/types/coin_string.rs`                  | Serialized coin: `parent_id ‖ puzzle_hash ‖ amount`                                                          |
| `PuzzleHash`                    | `common/types/puzzle_hash.rs`                  | 32-byte hash identifying a puzzle                                                                            |
| `GameID`                        | `common/types/game_id.rs`                      | A `u64` nonce that identifies a factory-created live game; see [Game IDs and Nonces](ON_CHAIN.md#game-ids-and-nonces) |
| `LocalProposalId` / `WireProposalId` | `common/types/proposal_id.rs`             | Endpoint-local pending handle and origin-assigned parity wire identifier; both retain compact integer encoding |
| `SpendBundle`                   | (chia types)                                   | Collection of `CoinSpend`s forming an atomic transaction                                                     |
| `RefereePuzzleArgs`             | `referee/types.rs`                             | All args curried into the referee puzzle                                                                     |
| `Referee`                       | `referee/mod.rs`                               | Enum: `MyTurn` / `TheirTurn`                                                                                 |
| `ChannelState`                | `channel_state/mod.rs`                       | Manages channel state, unroll, live games                                                                    |
| `OffChainPhase`                 | `session_phases/mod.rs`                        | Turn-taking protocol over the wire                                                                           |
| `OnChainPhase`            | `session_phases/on_chain.rs`                   | Drives on-chain dispute flow                                                                                 |
| `LiveGame`                      | `channel_state/types/live_game.rs`           | Wraps referee for a single active game                                                                       |
| `ProposedGame`                  | `channel_state/types/proposed_game.rs`       | Lightweight pending terms plus local-handle/origin-wire-ID mapping; members are created at acceptance |
| `UnrollCoin`                    | `channel_state/types/unroll_coin.rs`         | Unroll coin state and puzzle construction                                                                    |
| `GameSession`                    | `game_session.rs`                              | Production session host: owns current phase, queues, emits `GameSessionEvent`s                                |
| `ValidationInfo`                | `channel_state/types/validation_info.rs`     | Game validation program + state                                                                              |
| `CachedRedoActions` | `channel_state/types/potato.rs`              | Internal protocol replay entries: `CachedSendMove`, `CachedAcceptSettlement`, and per-ID `ProposalAccepted` (not the UI `ProposalAcceptedGroup`) |
| `BatchAction`                   | `session_phases/types.rs`                      | Peer-level actions: proposal `Propose`, `AcceptProposal`, `CancelProposal`, plus per-game `Move` and `AcceptSettlement` |
| `GameAction`                    | `session_phases/types.rs`                      | Local actions: game moves/settlements, scalar queued proposal intents, clean shutdown, and test-only cheat support |
| `GameSessionState`    | `game_session.rs`                              | Per-session mutable state: queues, flags, `peer_disconnected`                                                |
| `OnChainGameState`              | `channel_state/types/on_chain_game_state.rs` | Per-game-coin tracking: `our_turn`, `puzzle_hash`, `timeout_claim_armed`, `timeout_claim`, `pending_slash_amount`, `game_timeout` |
| `SettlementOutcome`             | `session_phases/effects.rs`                    | Settlement glossary ids (snake_case wire): off-chain `accept_settlement` plus on-chain outcomes #1–#11; see [Settlement glossary](NAMING_AUDIT.md#settlement-glossary-ux) |
| `GameNotification`              | `session_phases/effects.rs`                    | Notifications to the UI: `ChannelStatus`, proposal variants, `InsufficientBalance`, gameplay `GameStatus { status: GameStatusKind, ... }`, and unified settlement `GameSettled { id, outcome, our_share, coin_id }` |
| `Effect`                        | `session_phases/effects.rs`                    | All side effects returned by handler methods (notifications, transactions, coin registrations)               |
| `PeerLifecyclePhase`                   | `game_session.rs`                              | Trait implemented by all lifecycle phases — uniform interface for messages, coin events, game actions        |
| `HandshakeInitiatorPhase`     | `session_phases/handshake_initiator.rs`        | Initiator handshake state machine (A → C → coin_created)                                                    |
| `HandshakeReceiverPhase`      | `session_phases/handshake_receiver.rs`         | Receiver handshake state machine (B → D → coin_created)                                                     |
| `SpendChannelCoinPhase`       | `session_phases/spend_channel_coin_phase.rs` | Watches channel coin spend; clean shutdown detection + unroll handling, creates `OnChainPhase`         |
| `ChannelCoinSpendInfo`          | `channel_state/types/`                       | Solution, conditions, and aggregate signature for spending the channel coin                                  |
| `PeerMessage`                   | `session_phases/types.rs`                      | Wire message enum: `HandshakeA`–`HandshakeD`, `Batch`, `RequestPotato`, `Message`, etc.                     |

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
| [`WEBSOCKET_PROTOCOL.md`](WEBSOCKET_PROTOCOL.md) | Player-to-hub game relay carrier, messages, routing, and reconnect semantics |
| [`PEER_PROTOCOL.md`](PEER_PROTOCOL.md) | Reliable peer framing and authoritative peer message semantics |
| [`FRONTEND_ARCHITECTURE.md`](FRONTEND_ARCHITECTURE.md) | React frontend, WASM bridge, hub relay, session persistence |
| [`CLVM_DOS.md`](CLVM_DOS.md) | CLVM denial-of-service vectors: ladder bombs, execution cost, trust categories per call site, solution constraints |

