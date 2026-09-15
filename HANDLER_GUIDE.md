# Game Handler and Validation System

This document explains the off-chain handler and on-chain validation system
used by the game framework. It covers how game logic is structured, how
handlers produce moves, how validators enforce rules, and how the two systems
connect through the referee puzzle.

For adding a game (package layout, registry, host APIs), see
`GAME_WRITING_GUIDE.md`. For the broader architecture (state channels, potato
protocol, dispute resolution), see `OVERVIEW.md`. For the raw calling
conventions, see `clsp/handler_api.md`. For DoS considerations (move size
bounds, validation program cost, argument checking), see `CLVM_DOS.md`.

## Table of Contents

- [Overview](#overview)
- [Two Kinds of Handlers](#two-kinds-of-handlers)
- [My-Turn Handler](#my-turn-handler)
- [Their-Turn Handler](#their-turn-handler)
- [Handler Chaining](#handler-chaining)
- [Proposal Execution Model](#proposal-execution-model)
- [Detailed Turn Data Flow](#detailed-turn-data-flow)
- [Validators](#validators)
- [Validator Registry and Selection](#validator-registry-and-selection)
- [On-Chain vs Off-Chain](#on-chain-vs-off-chain)
- [Message Parsers](#message-parsers)
- [Nil Moves (Automatic Moves)](#nil-moves-automatic-moves)
- [Messages as Pre-Reveals](#messages-as-pre-reveals)
- [Worked Examples: Reference Games](#worked-examples-reference-games)

---

## Overview

Games are driven by two cooperating systems:

- **Handlers** run off-chain on each player's machine. They produce moves,
  interpret the opponent's moves, and decide what to display in the UI. They
  are chialisp programs, curried with game-specific state.

- **Validators** enforce the rules of each move. They are chialisp programs,
  one per protocol step (e.g. `a.clsp` through `e.clsp` for calpoker). They
  run both off-chain (to check a move before sending it) and on-chain (inside
  the referee puzzle, for slash enforcement during disputes). Package layout
  and registration are in `GAME_WRITING_GUIDE.md`.

Handlers and validators are complementary: handlers decide *what* to play,
validators prove *that it was legal*. Rust runs the current validator locally
with each produced move and nil evidence before advancing. The opponent repeats
that validation off-chain and can slash on-chain if a malicious peer nevertheless
commits an illegal move.

---

## Two Kinds of Handlers

There are two handler types, reflecting the two sides of a turn:

| Handler | When it runs | Who runs it | What it produces |
|---------|-------------|-------------|-----------------|
| **My-turn handler** | It's our turn to move | The moving player | A serialized move, mover share, and the handler for the opponent's turn |
| **Their-turn handler** | The opponent just moved | The waiting player | A readable interpretation of the move, evidence for slashing, and the next my-turn handler |

Handlers alternate: a my-turn handler produces a their-turn handler (for the
opponent's reply), and a their-turn handler produces a my-turn handler (for
our next move). This forms a chain that drives the entire game.

---

## My-Turn Handler

Called when it's our turn. The player's UI provides a `local_move` (e.g.
which cards to discard), and the handler translates it into the on-chain
move format.

### Parameters

```
(curried_args... local_move amount state mover_share entropy)
```

| Parameter | Description |
|-----------|-------------|
| `local_move` | UI input for this turn (may be nil for automatic moves) |
| `amount` | Total game pot |
| `state` | On-chain state from the previous validator |
| `mover_share` | Current mover's share if timeout occurs |
| `entropy` | 32 bytes of randomness for this turn |

### Return: Success (4-5 elements)

```
(
  label                    ; string, for UI/debug
  move                     ; bytes, the move to send on-chain
  mover_share              ; int, our share if opponent times out
  their_turn_handler       ; program for processing opponent's response (nil if game over)
  message_parser           ; optional program or nil (see Message Parsers)
)
```

- The handler owns `mover_share`; validators do not choose it.
- The handler returns the next off-chain handler, but it never returns a
  validator program, validator hash, state, or move-size limit.
- The current validator comes from the factory registry. Rust runs it with the
  move and nil evidence to derive the next validator hash, new state, and next
  maximum move size, then resolves a non-nil hash in that registry for the next
  move.
- When `their_turn_handler` is nil, this is the final move of the game. The
  current validator must also return a nil next validator hash.
- `message_parser` is the optional fifth element (zero-based index 4). If the
  element is absent or nil,
  the game does not accept out-of-band readable messages for this state.

### Return: Rejection (2 elements)

```
(error_tag message_bytes)
```

The handler rejected the `local_move` input (e.g. invalid discard selection).
The Rust side raises `GameMoveRejected`.

### Return: Error

```
(x ...)
```

A CLVM raise -- the handler crashed. The Rust side raises `ClvmErr`.

---

## Their-Turn Handler

Called when the opponent has moved and we need to interpret their move.

Their-turn handlers run on adversarial peer input. A handler crash, expensive
loop, or allocation blowup caused by a peer-supplied move is a security bug by
default, not a normal parse failure. Generic referee-envelope checks such as
`max_move_size` happen before the handler, so handlers may assume those bounds,
but game-rule failures must be represented through validator/slash behavior and
evidence candidates, not CLVM raises. The framework first runs the current
validator with nil evidence to reconstruct the candidate transition, then
slash-invokes a referee committed to that transition with nil evidence. This
second execution is intentional: the first discovers the arguments, while the
second asks whether those committed arguments are slashable. Only a move that
survives both phases reaches the handler, including terminal moves. Nil
evidence must therefore produce one of two outcomes:

- **Slash** — nil, a misaligned payload, or extra slash conditions. The
  handler is skipped.
- **Soft non-slash** — a normal valid payload
  `(next_validator_hash new_state max_move_size)`. The move is not slashable
  with empty evidence. `new_state` is passed to the handler as `state`.

After the commitment check, Rust runs the validator with the committed
arguments to obtain the state passed to the handler. An assert in any required
nil-evidence run is a hard validator error: the peer move is not accepted
off-chain and the game must go on chain. The handler is not called with a
fabricated nil state. Terminal validators return `(list 0)` when the move is
valid but no evidence was supplied.

Handlers are responsible for safely processing the peer-controlled moves that
survive the slash precheck.

### Parameters

```
(curried_args... amount pre_state state move validation_program_hash mover_share)
```

| Parameter | Description |
|-----------|-------------|
| `amount` | Total game pot |
| `pre_state` | On-chain state BEFORE the opponent's move |
| `state` | After-state from the committed nil-evidence validator run; canonical nil for a terminal result |
| `move` | Opponent's move bytes |
| `validation_program_hash` | Tree hash of the validation program for this move |
| `mover_share` | Opponent's declared share of the pot |

`validation_program_hash` is not the same thing as a validation info hash. The
program hash identifies a validator program by itself. A validation info hash is
the referee commitment `sha256(next_validator_hash, shatree(new_state))`, which
binds the *next* validator program to the state that program will validate.
Some existing handler code may still name this argument `validation_info_hash`,
but the value passed to their-turn handlers is the raw validation program hash
of *this* move because the framework has the validation program available at
that call site. Referee coins commit to the validation info hash instead.
Neither hash is accepted from the peer move message: the framework computes
the next infohash from the current validator's return value before invoking
this handler.

### Return: Normal Move (2-4 elements)

```
(
  readable_move    ; clvm value, UI-displayable interpretation
  evidence_list    ; list of fraud proofs (may be empty/nil)
  next_handler     ; optional my-turn handler, or nil if game over
  message          ; optional bytes, out-of-band message
)
```

- If `next_handler` is nil or absent, this is a final move (game over).
- `evidence_list` contains potential slash evidence candidates. The handler
  does **not** need to verify that each piece of evidence actually triggers a
  slash -- just return everything that *might* work. The Rust framework
  (`their_turn_move_off_chain`) tests each candidate by slash-invoking a
  curried referee; the first one that succeeds as a slash wins. If none
  succeed, the game continues normally -- evidence that doesn't work is
  silently discarded.
  Nil evidence is always tried automatically by the framework *before*
  calling the handler, so the handler never includes it in `evidence_list`.
  After the handler returns, each listed candidate is tried in order and may
  execute the same adversarial move through the validator again. Slash
  evidence is independent of whether `next_handler` is nil: a final move
  may still be slashed, and a continuing move may still be slashed. When
  evidence actually produces a slash, the other fields are unused. If no
  evidence slashes, `next_handler` is how the receiver learns whether the
  game continues, so it must not be junk in that case.
- `message` is optional (the fourth element may be absent). When present and
  non-empty, it is sent out-of-band to the opponent and parsed by their
  `message_parser`.

---

## Handler Chaining

Handlers form a chain that drives the game forward. Each handler produces
the next handler for the other side:

```
my_turn_handler_0 ──produces──> their_turn_handler_0
                                       │
                                produces
                                       │
                                       v
                               my_turn_handler_1 ──produces──> their_turn_handler_1
                                                                       │
                                                                    produces
                                                                       │
                                                                       v
                                                               my_turn_handler_2
                                                                      ...
```

The initial handler pair is established when the game is proposed and
accepted: the proposal factory produces fixed my-turn and their-turn handlers
plus a validator registry for each game. The higher layer selects the handler
appropriate to the local side and first mover and selects the registry's first
validator as current. From there, each turn's handler output specifies the next
handler, creating an implicit handler state machine independent of validator
selection.

When a handler returns nil for the next handler, the current validator must
return nil for its next validator hash. That agreement marks the game terminal.

---

## Proposal Execution Model

The proposal API takes one atomic group request:

```
GameProposal {
  player_a_contribution,
  player_b_contribution,
  sender_is_player_a,
  game_type,
  timeout,
  parameters
}
```

`parameters` is the game-specific structured Bencodex value and `timeout` is
shared by every game produced for the group. `sender_is_player_a` globally maps
the proposal sender to the stable A/B orientation. Game frontend code validates
the parameter value without handling CLVM. The Rust host converts it
deterministically and invokes the registered factory with:

```
(player_a_contribution player_b_contribution game_parameters)
```

Both peers use the same complete arguments. The factory returns a
non-empty ordered list of canonical 10-field game records:

```
(
  player_a_contribution
  player_b_contribution
  player_a_goes_first
  initial_move
  initial_max_move_size
  initial_state
  initial_mover_share
  my_turn_handler
  their_turn_handler
  validation_programs
)
```

Contributions, `player_a_goes_first`, and member order use one stable A/B
orientation. The higher layer uses `sender_is_player_a` to project those facts
to sender/receiver and local/opponent perspectives without reordering members.
It selects `my_turn_handler` for the first player and `their_turn_handler` for
the waiting player. The factory handlers are not regenerated from peer-specific
inputs. `validation_programs` must be a proper, nonempty list. Its first program
is initially current; later ordering is irrelevant because Rust resolves every
subsequent validator by tree hash. The first member's first validator hash is
the protocol identity. `initial_state` is the state supplied to that first
validator and first local handler; games normally use canonical nil unless
their first transition genuinely needs pre-existing state.

The framework derives each game's amount from its two contributions and hashes
the registry's first validator. Wire members retain only setup commitments:
contributions, first-player orientation, validator and validation-info hashes,
initial move, maximum move size, and initial mover share. Raw initial state,
validator registry, handlers, and the derived amount stay local. The receiver
reruns the factory, checks the retained metadata (including list order and
cardinality), derives the group ID from the first member, and builds
`GameStartInfo` entirely from its local factory result. The current factories
produce one game for Calpoker, one for Space Poker, and two for Krunk.

There is no proposal parser and no peer-specific `wire_data`/`local_data`
proposal split in this model. This is separate from the optional advisory
message parsers described below, which remain part of active gameplay.

---

## Detailed Turn Data Flow

For each move, handler progression and validator selection meet in Rust:

```
my_turn_handler(local_move, state, mover_share, entropy)
  -> move, next mover_share, their_turn_handler, optional message_parser

current_validator(move, pre_state, nil evidence)
  -> next_validator_hash, new_state, next_max_move_size

Rust resolves a non-nil next_validator_hash in the factory registry and makes
the resolved program current for the next move; nil is terminal.

their_turn_handler(amount, pre_state, new_state, move,
                   current_validator_hash, mover_share)
  -> readable_move, evidence, next_my_turn_handler, optional message
```

For a received move, deriving that transition is not the slash check. Rust
first uses a placeholder commitment to discover the transition, then curries a
referee with the derived commitment and slash-invokes it with nil evidence. If
that does not slash, Rust evaluates the validator with the committed arguments
to supply `new_state` to the handler. Every handler evidence candidate causes a
further ordered slash invocation until one succeeds or the list is exhausted.
This repeated execution is required because parameter discovery, commitment
verification, and evidence trials answer different questions.

Key observations:

- **`their_turn_handler` receives both states**: it gets `state_after_our_turn`
  (before the opponent moved) and `state_after_their_turn1` (after). This lets
  it compare the two to detect fraud.
- **Evidence feeds back into the validator**: the `evidence` returned by
  `their_turn_handler` is tested against the current validator program by the
  framework. The handler just proposes candidates; the framework does the
  actual slash check.
- **The two state machines agree at terminal**: nil
  `next_validator_hash` must accompany nil `next_my_turn_handler`; otherwise
  the returned hash must resolve in the factory registry.

### The 0th Move

The game's `initial_state` is used directly as the state input to the first
my-turn handler. The registry's first validator is current for move 0 and is
run with that move and nil evidence to derive the following validator hash,
state, and maximum move size.

### On-Chain vs Off-Chain Chains

On-chain, validator hashes describe the protocol sequence:

```
a.clsp -> b.clsp -> c.clsp -> d.clsp -> e.clsp -> (terminal)
```

Off-chain, there are two parallel handler progressions (one per player):

```
alice: alice_handler_0 -> move 0
bob:   move 0 -> a.clsp with initial_state
bob:   bob_handler_0 -> move 1
alice: move 1 -> b.clsp
...
```

On-chain there is no difference between a move *leaving* one player and
*arriving* at the other. Both peers therefore use the same factory registry
and resolve the validator hash returned by the current validator. Handlers do
not carry validator programs between turns.

---

## Validators

Validators are chialisp programs that enforce the rules for a single step of
the game protocol. They run both **on-chain** (inside the referee puzzle
during disputes) and **off-chain** (called by the Rust code during normal
play).

A validator takes the move, current state, and optional evidence and returns an
untagged result:

### Validator Return: Valid Move

```
(next_validation_program_hash new_state max_move_size)
```

These three elements describe the new game state after the move.

- **On-chain**: The referee checks that these values match the commitments
  in the coin's curried state (infohash and max_move_size). If they align,
  the move is valid and the slash attempt fails.
- **Off-chain**: A successful nil-evidence run is a soft non-slash: the
  framework takes `new_state` and `max_move_size` from it before calling the
  their-turn handler. Every structurally valid move must return a payload with
  nil evidence. `(list 0)` is the valid terminal payload: the next validator
  hash is nil, there is no after-state, and the next max move size is zero.

Note: `mover_share` is **not** in the validator's return value. It is part
of the referee's curried arguments and is checked separately by each
validator.

### Validator Return: Valid Move with Conditions (Conditional Slash)

```
(next_validation_program_hash new_state max_move_size condition1 condition2 ...)
```

Elements beyond the first three are **conditions** that the referee must
emit for the slash to succeed. This enables "conditional slashing" where
a move is provably invalid but the proof requires an external cryptographic
check (e.g. verifying that a dictionary range was signed by both players).

The referee prepends these conditions to its standard payout conditions.
Example: a Krunk dictionary range slash returns
`(AGG_SIG_UNSAFE dict_pubkey evidence)` as the 4th element, which the
referee emits so the blockchain verifies the BLS signature on the range.
The local referee treats a handler-provided signed evidence entry as a
conditional slash candidate even though this validator result is non-nil; the
signature is aggregated into the slash spend and the blockchain enforces the
returned condition.

If values align with commitments but no conditions are present (list ends
at element 3), the move is valid and the slash attempt fails (assert
aborts the spend).

### Validator Return: Invalid Move (Unconditional Slash)

```
()
```

Nil means the move is unconditionally illegal. On-chain, the referee emits
payout conditions giving the full game amount to the slasher without
requiring any additional cryptographic proof.

Off-chain, Rust parses a non-nil payload into its next validator hash, state,
and move-size limit. A nil result means the attempted slash succeeded.

A slash also succeeds when the validator returns non-nil values that
**don't align** with the referee's committed infohash or max_move_size.
This covers cases where the validator deliberately returns mismatched
values to signal fraud provable from game state alone (no external
conditions needed).

### Slash Success Versus Slash Rejection

A CLVM hard fail aborts the referee spend: the transaction never enters the
mempool or a block. That is a legitimate way to **reject** a slash. It is a
bug only when the committed move is illegal and the supplied evidence is the
intended proof — then the cheat is unslashable.

- Illegal moves must return nil, a misaligned payload, or extra slash
  conditions, without hard-failing on the intended evidence.
- A slash of a valid move may hard-fail, or return an aligned payload with no
  extra conditions.
- Extra conditions on an aligned payload are a conditional slash; they must
  not appear unless the evidence actually proves fraud.

### Krunk Reveal and Evidence Semantics

Krunk's `clue.clsp` reveal validator treats an early reveal as a concession.
The scheduled guesser shares, in `base_unit` multiples, are
`100, 100, 20, 5, 1` for correct guesses one through five. A fifth incorrect
guess pays zero. If Alice reveals after an incorrect guess one through four,
the reveal is valid only when it pays the same scheduled share as a correct
guess at that depth. An underfunded concession, malformed reveal, or reveal
that does not open Alice's commitment returns nil and is unconditionally
slashable. Those move-only faults are slashable with nil evidence. Unsupported
non-nil evidence lengths return the same terminal result as nil.

Evidence has two proof-specific forms:

- A one-byte index selects a prior clue. If recomputing that clue from the
  revealed word proves Alice's clue wrong, the validator returns nil. A correct
  clue returns the ordinary aligned terminal result; an out-of-range index
  raises and cannot authorize a slash.
- A ten-byte `lower_bound || upper_bound` dictionary-gap proof conditionally
  slashes when the revealed word lies inside that range. The validator appends
  `(AGG_SIG_UNSAFE dict_pubkey evidence)`, so the referee slash succeeds only
  when the blockchain verifies the range signature. A range that does not
  contain the word raises and cannot authorize a slash.

The dictionary handler obtains both the range and its precomputed aggregate
signature from the signed dictionary tree. In a handler `evidence_list`, signed
evidence is represented as `("s" evidence signature)`. Rust unwraps this
envelope before calling the validator and aggregates `signature` with the
ordinary reward-payout signature when constructing the slash spend. Plain
evidence entries remain unchanged. Keeping the signature beside its evidence
prevents a conditional validator result that emits an `AGG_SIG_UNSAFE`
condition but can never satisfy it.

For presentation, Bob's terminal handler maps any nonzero, validator-approved
reveal payout—including a premature concession—to the same
`(revealed_word, all-green clue)` readable as an actual correct guess. The
frontend therefore follows one normal correct-guess path and does not duplicate
the payout rules.

### Space Poker Showdown Bitfields

Space Poker showdown masks select five cards from a seven-card list, so only
bits 0 through 6 are meaningful. `popcount == 5` is not sufficient validation:
a mask such as `0x8f` has five set bits but selects only four cards because bit
7 has no corresponding card. Passing that shortened list to the hand evaluator
can raise and make the illegal terminal move unslashable.

The terminal validator therefore rejects a mover mask when bit 7 is set before
selecting or evaluating cards, then separately requires exactly five set bits.
The waiter's evidence mask follows the same range and popcount rules. Nil
evidence returns `(list 0)` without comparing hands. Invalid non-nil evidence
raises, rejecting that slash attempt. A well-formed waiter mask that does not
prove overclaim also returns `(list 0)`. An invalid committed mover mask
returns nil and is unconditionally slashable.

### How the On-Chain Referee Uses Validators

The referee has three spend types: **move**, **slash**, and **timeout**.
Validators are only involved in the first two, and their role differs:

**Move path** -- The referee does **not** call a validator when a move is
submitted. It trusts that the move is valid and advances the game state
using the values provided in the solution. The threat of slashing is the
enforcement mechanism: if a player submits an illegal move, the opponent
can slash them. This avoids running validation logic on-chain during honest
play, saving cost and complexity.

**Slash path** -- A player submits evidence along with the previous move's
validator. The referee runs the validator with the evidence. Slash succeeds
in three cases:
1. The validator returns nil — unconditional slash (move is definitely illegal).
2. The validator returns non-nil values whose infohash or max_move_size
   don't match the curried commitments — unconditional slash (misalignment
   proves fraud from game state alone).
3. The validator returns values that DO align with commitments AND includes
   extra conditions beyond the 3rd element — conditional slash. The referee
   emits these conditions (e.g. `AGG_SIG_UNSAFE` for signed range proofs)
   alongside the payout conditions; the blockchain enforces them.

If the validator returns aligned values with no extra conditions (list ends
at element 3), the move was valid and the slash attempt fails (the spend
aborts). If the validator hard-fails, the slash transaction never exists;
that is also a valid way to reject a slash of an honest move.

Validators have a two-sided security contract:

- Every malicious move that the referee move path can accept optimistically must
  be slashable. For those inputs the validator must return nil, or another
  slash-triggering result, without raising. This includes malformed lengths,
  bad popcounts, bad preimage reveals, wrong mover shares, and invalid
  next-state commitments.
- Every invalid slash attempt against a valid move must fail. Non-nil evidence
  either proves its specific accusation or fails to slash. A validator may
  reject unusable evidence by raising or may treat it like nil and return the
  valid payload. Nil evidence must never raise: it is also used off chain to
  extract the transition and next max move size. Evidence assertions are only
  safe after the move itself has already been classified as valid; otherwise
  malformed evidence could mask a malicious move by causing an exception
  instead of a slash.

In practice, validators should cheaply classify move shape before any
length-sensitive `substr`, hand-evaluation helper, or evidence processing.
Only after the move is known to be valid should the validator inspect evidence
that might intentionally reject an invalid slash.

**Timeout path** -- No validator is involved. The referee simply checks
that enough time has passed and pays out according to the current mover
share.

---

## Validator Registry and Selection

The factory returns every validator program in one proper, nonempty
`validation_programs` list. The first entry is initially current. For every
move, Rust runs the current validator with nil evidence and reads its
`next_validation_program_hash`:

- A non-nil hash is resolved by tree hash against the factory registry and the
  resolved program becomes current for the next move.
- A nil hash is terminal and must agree with a nil next handler.

Only the first registry position is meaningful. All later entries are an
unordered lookup set, so protocol correctness must never depend on their order.
The returned hash still commits the next coin to the selected validator and
state, preventing either player from substituting different validation rules.

---

## On-Chain vs Off-Chain

### Off-Chain (Normal Play)

During normal play, both handlers and validators run off-chain on each
player's machine. For a local move, Rust calls the my-turn handler, validates
its move with the current registry validator, resolves the returned next hash,
and sends the move. For a received move, Rust discovers the transition with a
nil-evidence validator run, verifies the resulting commitment through the real
referee slash path, reruns the committed transition for the handler state, and
then tries each handler-provided evidence candidate through that slash path.

Both players independently run the same validators and arrive at the same
state. If they disagree, one of them will detect fraud when they try to
validate the opponent's move.

The validator's non-nil return includes the new state, so the handler uses
this directly rather than duplicating state-transition logic when there is a
follow-on state to derive.

### On-Chain (Dispute)

When the channel goes on-chain, game coins are created from the last agreed
state. From that point:

- **Handlers are not used on-chain.** The on-chain path only needs the move
  bytes and the validator -- it doesn't need to interpret the move for a UI.
- The on-chain referee has three spend types: **move** (advance the game),
  **timeout** (claim the pot when the opponent doesn't act), and **slash**
  (prove a previous move was invalid and take the full amount).
- On the **move path**, the referee does **not** re-run the validator. It
  trusts the submitted state transition and advances the game. The
  enforcement mechanism is the threat of slashing: if a player cheats, the
  opponent can submit evidence to the validator and take the full pot. This
  keeps honest moves small: they carry the next validation info hash, not the
  full validation program and state.
- On the **slash path**, the referee runs the validator with the provided
  evidence. If it returns nil, or returns values that do not match the
  committed next-state fields, or returns extra conditions, the slasher wins.
  The slash spend reveals the previous validation program and state so the
  referee can recompute and check the committed infohash.

The same validator programs are used both off-chain (by the Rust code, to
verify moves as they happen) and on-chain (by the referee, for slash
enforcement). This guarantees consistency: if a move fails off-chain
validation, the evidence that caught it will also work on-chain.

---

## Message Parsers

Some games need to send information to the opponent outside the strict
turn-taking protocol. The **message parser** mechanism enables this.

### How It Works

1. A my-turn handler may return a `message_parser` program as its optional
   fifth element (zero-based index 4). This program knows how to decode advisory
   messages for the current game state. If the element is absent or nil, no
   parser is installed.
2. When the their-turn handler processes the opponent's reply, it can return
   an optional `message` (element 4 of the normal return, zero-based index 3).
   This message is sent to the opponent out-of-band.
3. The opponent's `message_parser` decodes the raw bytes into a
   `readable_info` value that the UI can display.

### Message Parser Parameters

```
(message state amount)
```

### Message Parser Return

A clvm value for UI display, or raises on error.

### Why It Exists

In calpoker, the commit-reveal protocol means Bob can't see his cards until
Alice reveals her preimage (step c). But after Alice processes Bob's seed
(step b), she can derive the cards immediately. The message mechanism lets
her send Bob the card information right away, so he can start thinking about
discards while Alice is still deciding her move. The message is purely
advisory -- Bob will independently derive the same information when Alice's
real move arrives.

---

## Nil Moves (Automatic Moves)

A `local_move` of nil (null from JavaScript) means the player isn't providing
any input -- the handler is fully responsible for computing the move. The
frontend just triggers the handler; it doesn't supply data.

### When to Use Nil Moves

Nil moves are appropriate when:

- **The move is deterministic and requires no user choice.** The handler
  generates the move entirely from internal state and entropy. Example:
  commit steps where the handler builds a hash chain from entropy and sends
  the chain tip.

- **The move involves secret data the handler manages internally.** The
  handler knows the preimage/bitfield and constructs the reveal. The
  frontend doesn't have this data and shouldn't need it. Example: the final
  reveal in space poker, where the handler concatenates the base preimage
  with the optimal card selection computed by `space_hand_calc`.

- **The move is purely mechanical acknowledgment.** The handler auto-fills
  a response that advances the protocol without any strategic decision.

### Examples

**Calpoker commitA** (step a): Alice's handler generates a preimage from
entropy, hashes it, and sends the hash. The package dispatches
`{ type: 'make-move', memberIndex: 0, readable: null }` -- no user input is
needed.

**Calpoker commitB** (step b): Bob's handler generates his seed from
entropy and sends it. Same nil pattern.

**Space poker commitA/commitB**: Both handlers build a 5-element hash chain
from 16 bytes of entropy and send the chain tip. The frontend auto-fires
these during the "Shuffling..." phase.

**Space poker end reveal**: The mover's handler has the base preimage from
its curried chain and computes the optimal 5-card selection via
`space_hand_calc`. It concatenates `preimage || bitfield` and sends it.
The package dispatches a nil `make-move` intent for member index 0; the handler
fills in the actual 17-byte move. On-chain, this move is validated by `end.clsp` which
independently derives all cards and checks the hand evaluation.

### Frontend Pattern

The package detects automatic moves by checking its game phase. During setup
phases (commits), it dispatches a nil move for the stable member index as soon
as it is the player's turn, without waiting for user interaction. The UI shows a
status message like "Shuffling..." while these automatic moves fire.

```typescript
// Auto-play commit steps
if (phase === 'setup' && isMyTurn) {
  port.dispatch({ type: 'make-move', memberIndex: 0, readable: null });
}
```

---

## Messages as Pre-Reveals

Messages let a player pre-reveal a preimage they're committed to revealing
on their next move anyway. The opponent can then derive information early
rather than waiting for the formal move to arrive.

### Why Pre-Reveal?

In commit-reveal protocols, the reveal happens as part of a formal move.
But after the commit step, the revealing player may need time to make a
strategic decision (e.g. choosing discards in calpoker). Meanwhile, the
opponent is waiting with no useful information to act on.

If the revealer has no reason to withhold the preimage -- they're going to
reveal it on their next move regardless, and there's no scenario where
they'd fold instead -- they can send it ahead as a message. The opponent
derives the information immediately and can start thinking about their
response.

### Calpoker Example

After Bob sends his seed (step b), Alice processes it in her their-turn
handler and can immediately derive the cards. She pre-reveals her preimage
as a message. Bob's message parser decodes it and shows him the cards while
Alice is still deciding her discards. When Alice's formal move (step c)
arrives, Bob independently verifies the same information.

### Mechanics

1. A **my-turn handler** may return a `message_parser` as its optional fifth
   element (zero-based index 4). This parser knows how to decode messages
   for the current game state. If the element is absent or nil, no parser is
   installed.

2. The **their-turn handler** processing the opponent's reply may return an
   optional `message` as element 4 of the normal return list (zero-based index
   3). A non-empty message is sent out-of-band to the opponent.

3. The opponent's `message_parser` decodes the raw bytes into readable data
   for the UI.

Messages arrive as `GameMessage` events in the frontend, distinct from
`OpponentMoved` events which come from the formal move protocol.

---

## Worked Examples: Reference Games

Calpoker and Space Poker are both reference games. Calpoker is the smaller,
earlier example and is easiest to follow end-to-end. Space Poker exercises a
different part of the API: multi-round poker state and repeated
betting/open transitions, including advisory message parsers for pre-revealed
card information.

The `debug` game is registered for simulator tests only. It exists to exercise
channel/on-chain mechanics with controlled `mover_share` values and is not a
user-facing reference game.

### Calpoker

Calpoker uses 5 protocol steps (a through e), each with a validator and
corresponding handlers on both sides.

### Handler Chain

```
Alice my-turn handler a  ──>  Bob their-turn handler a
                                     │
                              Bob my-turn handler b  ──>  Alice their-turn handler b
                                                                  │
                                                           Alice my-turn handler c  ──>  Bob their-turn handler c
                                                                                                │
                                                                                         Bob my-turn handler d  ──>  Alice their-turn handler d
                                                                                                                             │
                                                                                                                      Alice my-turn handler e  ──>  Bob their-turn handler e
                                                                                                                                                           │
                                                                                                                                                    (game over, nil handler)
```

### Validator Sequence

```
a.clsp ──> b.clsp ──> c.clsp ──> d.clsp ──> e.clsp ──> (nil, game over)
```

All five programs are present in the factory registry. The first is initially
current; each validator returns the tree hash selecting the next one.

### The Steps

| Step | Mover | Handler | Validator | Move |
|------|-------|---------|-----------|------|
| a | Alice | `calpoker_alice_handler_a` | `a.clsp` | `sha256(preimage)` |
| b | Bob | `calpoker_bob_handler_b` | `b.clsp` | `bob_seed` |
| c | Alice | `calpoker_alice_handler_c` | `c.clsp` | `preimage \|\| sha256(salt\|\|discards)` |
| d | Bob | `calpoker_bob_handler_d` | `d.clsp` | `bob_discards` |
| e | Alice | `calpoker_alice_handler_e` | `e.clsp` | `salt\|\|discards\|\|selects` |

After step e, Alice's my-turn handler returns nil for
`their_turn_handler`, and `e.clsp` returns a nil next validator hash. Their
agreement signals that the game is over.

### Key Code

- Handlers: `games/calpoker/clsp/calpoker_generate.clinc`
- Validators: `games/calpoker/clsp/onchain/a.clsp` through `e.clsp`
- Rust-side handler invocation: `src/channel_state/game_handler.rs`
- Rust-side referee state machine: `src/referee/my_turn.rs`,
  `src/referee/their_turn.rs`
- Handler API reference: `clsp/handler_api.md`

### Space Poker

Space Poker is a Texas Hold'em-style reference game. It demonstrates how a game
can keep more complex state across multiple rounds while keeping the formal move
protocol authoritative. It also uses advisory message parsers: a my-turn handler
can install a parser for the current state, and the opponent's their-turn handler
can return an optional fourth `message` element to pre-reveal information that is
already implied by, or will be independently derivable from, the formal move
sequence. Calpoker uses this once for Alice's seed pre-reveal; Space Poker uses it
at the beginning of each street for deal/open pre-reveals. Since there is no
reason to fold before at least checking there, the player can preemptively send
the reveal that will show the next street's cards, improving pacing without
changing the authoritative move flow.

**Key code:**

- Handlers: `games/spacepoker/clsp/spacepoker_generate.clinc`
- Validators: `games/spacepoker/clsp/onchain/*.clsp`
- Rust tests: `games/spacepoker/rust/tests/`
