# CLVM Denial-of-Service Vectors and Countermeasures

This document describes the denial-of-service attack surfaces involving CLVM
evaluation and serialization in the chia-gaming codebase, and the
countermeasures in place. It is intended to make security audits faster by
documenting trust boundaries upfront.

For the system architecture and coin hierarchy, see `OVERVIEW.md`. For
on-chain resolution details, see `ON_CHAIN.md`.

## Table of Contents

- [Ladder Bombs (Serialization Attacks)](#ladder-bombs-serialization-attacks)
- [Execution Cost Attacks](#execution-cost-attacks)
  - [run_program Call Site Trust Categories](#run_program-call-site-trust-categories)
  - [On-Chain Solution Constraints](#on-chain-solution-constraints)
  - [Off-Chain Move Validation](#off-chain-move-validation)
- [Allocator Resource Limits](#allocator-resource-limits)
- [Peer Message Bounds](#peer-message-bounds)
- [Zero-Reward Infohash Constraint](#zero-reward-infohash-constraint)
- [Game-Specific Responsibilities](#game-specific-responsibilities)

---

## Ladder Bombs (Serialization Attacks)

A **ladder bomb** (or backref bomb) exploits CLVM's compressed serialization
format. CLVM supports backreferences: a serialized byte stream can reference
earlier subtrees instead of repeating them. This creates a DAG (shared
structure) that, when traversed naively as a tree, produces exponential
blowup. A payload of ~200 bytes with ~30 levels of doubling references would
expand to gigabytes if fully materialized.

**Countermeasure:** This codebase uses `clvmr::serde::node_from_bytes` for all
CLVM deserialization — the non-backref deserializer. It does not understand
backref encoding, so a backref-laden payload is either rejected as malformed
or interpreted as a small literal tree. Without backrefs, deserialized tree
size is linear in serialized byte length.

The backref-aware deserializer (`node_from_bytes_backrefs`) is never used.

This means ladder bombs via the serialization format are not a concern, but
the linear size bound still depends on the input size being bounded — see
[Peer Message Bounds](#peer-message-bounds).

### Ladder Bombs in Puzzle Trees

Ladder bombs can also arise in locally-constructed CLVM trees if
attacker-influenced data is inserted as a subtree that gets referenced from
multiple places. Even without serialization backrefs, a tree node that appears
as a child of multiple parents (possible in the allocator's DAG representation)
can cause exponential work during serialization (`node_to_bytes`) or tree
hashing. See [Zero-Reward Infohash Constraint](#zero-reward-infohash-constraint)
for a concrete example of this class of issue and how it was addressed.

---

## Execution Cost Attacks

Every `run_program` call in clvmr accepts a `max_cost` parameter. When
`max_cost = 0`, clvmr maps this to `Cost::MAX` (effectively `u64::MAX`),
allowing unlimited CLVM execution. An attacker who controls the program or
its arguments could construct CLVM that produces exponentially large
intermediates at runtime — `concat` cascades, `(* x x)` doublings, deep
cons-spine construction — exhausting memory or CPU.

**Countermeasure:** All production `run_program` calls use
`MAX_BLOCK_COST_CLVM` (11,000,000,000 — the Chia block cost limit) as the
cost cap. This constant is defined in `src/common/types/coin_condition.rs`
and re-exported from `common::types`.

Test-only `run_program` calls (in `src/tests/` and `src/test_support/`) may
still pass `0` since they run locally-constructed programs against
locally-constructed data and do not represent an attack surface.

### run_program Call Site Trust Categories

Each `run_program` call site falls into one of three trust categories:

**Category 1: Locally-constructed program + locally-constructed data.**
Both the CLVM program and its arguments are built by our own code. No
adversarial input. Examples: constructing transactions we will broadcast,
computing puzzle hashes for coins we create.

**Category 2: Locally-held program + bounded peer data.**
The CLVM program is one we created or received during game setup (game
handlers, validation programs). The data includes peer-provided move bytes,
but these are bounded by `MAX_MOVE_SIZE` and typed as flat byte strings.
The peer cannot make our programs run expensively — they can only provide
small bounded input. See [Off-Chain Move Validation](#off-chain-move-validation).

**Category 3: On-chain puzzle + on-chain solution (farm-validated).**
The puzzle and solution come from a spend that landed in a Chia block. A
farmer already validated the spend within block cost limits. We re-evaluate
locally to extract conditions (CREATE_COIN, etc.). The `MAX_BLOCK_COST_CLVM`
cap is defense-in-depth — it cannot reject legitimate on-chain spends, but
protects against corrupted full-node data. See
[On-Chain Solution Constraints](#on-chain-solution-constraints) for why the
attack surface here is minimal even without the cost cap.

### On-Chain Solution Constraints

The on-chain puzzles tightly constrain what solutions can contain. For each
coin type, the solution format is destructured and validated:

**Channel coin** — Uses a standard `p2_delegated_puzzle_or_hidden_puzzle`
with a 2-of-2 aggregate public key. The spend requires an aggregate
signature from both players. The opponent can only broadcast spends that
were previously co-signed during off-chain play — they cannot craft
arbitrary delegated solutions.

**Unroll coin (timeout path)** — The solution is a conditions list whose
`shatree` hash must equal `DEFAULT_CONDITIONS_HASH`, a fixed value both
parties agreed to. No freedom in the solution at all.

**Unroll coin (preemption path)** — The solution must contain a higher
sequence number with correct parity, and the spend requires
`AGG_SIG_UNSAFE` with the shared unroll key. Again co-signed.

**Referee (move path)** — The solution is destructured as
`(new_move infohash_c new_mover_share new_max_move_size . tail)` with
explicit checks: `(not tail)`, `(<= (strlen new_move) MAX_MOVE_SIZE)`,
`(<= (strlen new_max_move_size) 2)`, bounds on `new_mover_share`, length
check on `infohash_c`. The spend requires `AGG_SIG_ME` from the mover.

**Referee (timeout path)** — The solution is just
`(mover_payout_ph waiter_payout_ph)`, confirmed by `(not (r (r args)))`.
Trivially cheap.

**Referee (slash path)** — The solution includes `previous_validation_program`
which is run by the puzzle. However, the **slasher is the honest/defending
player** — they are proving the opponent cheated. The cheater committed the
validation program hash during play but has no control over the slash spend
itself. The defender has no incentive to make their own slash expensive.

### Off-Chain Move Validation

When a peer sends a move via the potato protocol (`BatchAction::Move`), the
receiving side:

1. **Deserializes** the `GameMoveDetails` from the wire format. The move data
   (`move_made`) is a `Vec<u8>` — a flat byte string, not a CLVM tree. The
   Rust type system enforces this at deserialization.

2. **Checks move length** against the locally-stored `max_move_size` for the
   current game state (`apply_received_move` in `channel_handler/mod.rs`).
   The peer cannot influence this check — `max_move_size` comes from our own
   game state, not from the peer's message.

3. **Runs the validation program** (`run_state_update` in
   `referee/their_turn.rs`). This evaluates a CLVM program that we hold
   locally (the current step's validation program), passing the peer's move
   bytes as an atom argument. The program is ours; the peer only controls a
   small bounded input.

4. **Runs the game handler** (`call_their_turn_handler` in
   `channel_handler/game_handler.rs`). Again, our locally-held handler
   program, with the peer's move data as a bounded argument.

The peer cannot send a CLVM program for us to evaluate. They send data, and
we run our own programs against it.

---

## Allocator Resource Limits

The clvmr `Allocator` enforces several limits:

| Limit | Default | Purpose |
|-------|---------|---------|
| `heap_limit` | `u32::MAX` (~4 GiB) | Total bytes allocated for atoms |
| `MAX_NUM_ATOMS` | 62,500,000 | Maximum atom count |
| `MAX_NUM_PAIRS` | 62,500,000 | Maximum pair (cons) count |

These defaults are generous but finite. Combined with the `MAX_BLOCK_COST_CLVM`
execution cost cap, the allocator limits provide a second layer of defense:
even if a CLVM program somehow evades the cost counter, it cannot allocate
unbounded memory.

The `Allocator` supports `new_limited(heap_limit)` for tighter caps. The
current codebase uses `Allocator::new()` (default limits) everywhere. This
is acceptable because the cost cap prevents programs from reaching the
allocator limits through normal CLVM execution.

---

## Peer Message Bounds

Peer messages (off-chain potato protocol) are bounded at multiple levels:

1. **Wire-level size limit:** Messages larger than 10 MiB are rejected in
   `received_message` before deserialization. This prevents a malicious peer
   from consuming unbounded memory via message size alone.

2. **No backref deserialization:** CLVM programs embedded in messages (as
   `Program` = `Vec<u8>`) are deserialized with `node_from_bytes` (no
   backrefs). A 10 MiB serialized payload produces at most ~10 MiB of tree.

3. **Move data is typed as bytes:** The `move_made` field in
   `GameMoveStateInfo` is `Vec<u8>`, not a CLVM tree. It enters CLVM
   evaluation only as an atom via `encode_atom`.

4. **Move length is checked:** `apply_received_move` rejects moves exceeding
   the game's current `max_move_size` (set by the game's validation programs,
   capped at 65535 by the on-chain referee's 2-byte `strlen` check).

---

## Zero-Reward Infohash Constraint

When a player receives zero reward (their share is 0), the referee puzzle
requires their payout puzzle hash to be nil. However, the `INFOHASH` for the
non-rewarded side — a commitment to their validation program — is not
needed for timeout resolution and might never be checked on-chain.

The risk: during off-chain play, the cheating side can commit to an arbitrary
`INFOHASH`. If the honest side's code carries the corresponding validation
program around in memory (even without ever running it), the program could
contain a ladder-like structure that causes problems during serialization
or tree hashing.

**Countermeasure:** When a side gets zero reward, the protocol asserts that
their `INFOHASH` is nil. This prevents smuggling a commitment to a
potentially malicious program through a code path where it would never be
validated but might still be processed.

This is an example of a general principle: data that is "unused" from the
protocol's perspective can still cause DoS if the implementation carries it
around and processes it (serializes, hashes, or traverses it). Every field
in the puzzle tree should either be validated or constrained to a harmless
value.

---

## Game-Specific Responsibilities

The game handler framework provides the infrastructure for bounded, safe
evaluation. Individual games must uphold their part:

- **Validation programs must check argument types and lengths.** Each step's
  validator should verify that the move is the expected byte length and
  format. The calpoker validators do this (32 bytes for commits, 16 bytes
  for seeds, 48 bytes for reveals, 1 byte for discards, 18 bytes for the
  final step).

- **`max_move_size` should be tight.** Games should set `max_move_size` to
  the smallest value that accommodates legitimate moves for that step.

- **Validation programs should be cheap.** They run on every received move.
  Stick to byte-length checks, hashing, and simple arithmetic. Avoid
  patterns that could have super-linear cost in the input size.

New game implementations should be reviewed for these properties.
