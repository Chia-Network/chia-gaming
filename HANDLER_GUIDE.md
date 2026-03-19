# Game Handler and Validation System

This document explains the off-chain handler and on-chain validation system
used by the game framework. It covers how game logic is structured, how
handlers produce moves, how validators enforce rules, and how the two systems
connect through the referee puzzle.

For the broader architecture (state channels, potato protocol, dispute
resolution), see `ARCHITECTURE.MD`. For the raw calling conventions, see
`clsp/handler_api.txt`.

## Table of Contents

- [Overview](#overview)
- [Two Kinds of Handlers](#two-kinds-of-handlers)
- [My-Turn Handler](#my-turn-handler)
- [Their-Turn Handler](#their-turn-handler)
- [Handler Chaining](#handler-chaining)
- [Detailed Turn Data Flow](#detailed-turn-data-flow)
- [Validators](#validators)
- [Validator Chaining](#validator-chaining)
- [On-Chain vs Off-Chain](#on-chain-vs-off-chain)
- [Message Parsers](#message-parsers)
- [Worked Example: Calpoker](#worked-example-calpoker)

---

## Overview

Games are driven by two cooperating systems:

- **Handlers** run off-chain on each player's machine. They produce moves,
  interpret the opponent's moves, and decide what to display in the UI. They
  are chialisp programs, curried with game-specific state.

- **Validators** enforce the rules of each move. They are chialisp programs,
  one per protocol step (e.g. `a.clsp` through `e.clsp` for calpoker). They
  run both off-chain (for move verification during normal play) and on-chain
  (inside the referee puzzle, for slash enforcement during disputes).

Handlers and validators are complementary: handlers decide *what* to play,
validators prove *that it was legal*. A handler that produces an illegal
move will pass locally (the handler trusts its own output) but the
opponent's off-chain code will detect the fraud when it runs the validator,
and can then slash on-chain.

---

## Two Kinds of Handlers

There are two handler types, reflecting the two sides of a turn:

| Handler | When it runs | Who runs it | What it produces |
|---------|-------------|-------------|-----------------|
| **My-turn handler** | It's our turn to move | The moving player | A serialized move, validators, and state for the next turn |
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

### Return: Success (10 elements)

```
(
  label                    ; string, for UI/debug
  move                     ; bytes, the move to send on-chain
  outgoing_validator       ; program, validates THIS move
  outgoing_validator_hash  ; sha256tree of outgoing_validator
  incoming_validator       ; program, validates opponent's NEXT move
  incoming_validator_hash  ; sha256tree of incoming_validator (nil if game over)
  max_move_size            ; int, max bytes the opponent may send
  mover_share              ; int, our share if opponent times out
  their_turn_handler       ; program for processing opponent's response (nil if game over)
  message_parser           ; program or nil (see Message Parsers)
)
```

- `outgoing_validator` validates the move *we just produced*. The opponent
  will use this (via the referee) to verify our move was legal.
- `incoming_validator` validates the move *the opponent will produce next*.
  This is passed forward so the referee knows how to validate the reply.
- When `their_turn_handler` is nil, this is the final move of the game.
  `incoming_validator_hash` should also be nil in this case.

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

### Parameters

```
(curried_args... amount pre_state state move validation_info_hash mover_share)
```

| Parameter | Description |
|-----------|-------------|
| `amount` | Total game pot |
| `pre_state` | On-chain state BEFORE the opponent's move |
| `state` | On-chain state AFTER the opponent's move |
| `move` | Opponent's move bytes |
| `validation_info_hash` | Hash of the validation program + state for this move |
| `mover_share` | Opponent's declared share of the pot |

### Return: Normal Move (3-4 elements)

```
(
  readable_move    ; clvm value, UI-displayable interpretation
  evidence_list    ; list of fraud proofs (may be empty/nil)
  next_handler     ; my-turn handler, or nil if game over
  message          ; bytes, optional out-of-band message
)
```

- If `next_handler` is nil or absent, this is a final move (game over).
- `evidence_list` contains potential slash evidence candidates. The handler
  does **not** need to verify that each piece of evidence actually triggers a
  slash -- just return everything that *might* work. The Rust framework
  (`their_turn_move_off_chain`) tests each candidate against the validator;
  the first one that produces a `SLASH` result wins. If none succeed, the
  game continues normally -- evidence that doesn't work is silently discarded.
  Nil evidence is always tried automatically by the framework *before*
  calling the handler, so the handler never needs to include it. When the
  handler is certain the move is fraudulent, it puts the evidence in the
  list and can return junk for the other fields (`readable_move`,
  `next_handler`, etc.) since they will never be used.
- `message` is optional (the fourth element may be absent). When present,
  it is sent out-of-band to the opponent and parsed by their
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
accepted: the proposal factory produces the first handler and validator for
each side. From there, each turn's handler output specifies the next handler,
creating an implicit state machine.

When a handler returns nil for the next handler, the game is over. No more
turns will be taken.

---

## Detailed Turn Data Flow

The following diagram (from `src/referee/my_turn.rs`) shows how data flows
through a single round of play -- one of our moves followed by one of
theirs:

```
my turn:                                   ┌-------------------------------------------┐
                                           v                                           |
┌-> my_turn_handler(local_move, state_after_their_turn0) ->                            |
|            { serialized_our_move, ------------┐    |                                 |
|   ┌--------- their_turn_handler,              |    |                                 |
|   |          local_readable_move,             |    |                                 |
|   |   ┌----- their_turn_validation_program,   |    |                                 |
|   |   |    }                                  |    └------------┐                    |
|   |   |                                       |                 |                    |
|   |   |                                       v                 v                    |
| ┌-|---|->my_turn_validation_program(serialized_our_move, state_after_their_turn0) -> |
| | |   |    state_after_our_turn --------------------------------┐                    |
| | |   |                                                         |                    |
| | |   | their turn:                                             |                    |
| | |   v                                                         v                    |
| | |   their_turn_validation_program(serialized_their_move, state_after_our_turn) ->  |
| | |     state_after_their_turn1 -┐                              |                    |
| | |                              |                              |                    |
| | v                              |                              |                    |
| | their_turn_handler(            ├---------------------------------------------------┘
| |   serialized_their_move,       |                              |
| |   state_after_their_turn1 <----┘                              |
| |   state_after_our_turn, <-------------------------------------┘
| | ) ->
| |   { remote_readable_move,
| └---- my_turn_validation_program,
└------ my_turn_handler,
        evidence, --------------> try these with their_turn_validation_program
      }
```

Key observations:

- **`their_turn_handler` receives both states**: it gets `state_after_our_turn`
  (before the opponent moved) and `state_after_their_turn1` (after). This lets
  it compare the two to detect fraud.
- **Evidence feeds back into the validator**: the `evidence` returned by
  `their_turn_handler` is tested against `their_turn_validation_program` by the
  framework. The handler just proposes candidates; the framework does the
  actual slash check.
- **The loop feeds forward**: the outputs of one round (`my_turn_handler`,
  `my_turn_validation_program`) become the inputs to the next round.

### The 0th Move

On the very first move, the initial validation program is **not** called.
Instead, the game's `initial_state` is used directly as the state input to
the handler. The first validator only runs when the *opponent* processes
move 0.

### On-Chain vs Off-Chain Chains

On-chain, validators form a single linear chain:

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
*arriving* at the other, so the outgoing validation program for a move must
be the same program that the opponent uses as the incoming validator for
that move. This is why `my_turn_handler` returns both `outgoing_validator`
and `incoming_validator` -- they correspond to adjacent links in the single
on-chain chain.

---

## Validators

Validators are chialisp programs that enforce the rules for a single step of
the game protocol. They run both **on-chain** (inside the referee puzzle
during disputes) and **off-chain** (called by the Rust code during normal
play).

A validator takes the move and current state and returns a tagged result:

### Validator Return: Valid Move

```
(new_validation_info_hash new_state max_move_size mover_share ...)
```

Tag `0` (`MAKE_MOVE`) means the move is legal. The returned values are used
in two places:

- **On-chain**: The referee curries them into the new referee coin
  (next validation hash, state, max move size, mover share).
- **Off-chain**: The Rust code extracts `new_state` so the handler can
  determine the next game state without duplicating that logic.

### Validator Return: Invalid Move (SLASH)

```
()
```

Nil (`SLASH`) means the move is illegal. On-chain, the referee emits a reward coin giving
the full game amount to the slasher. Off-chain, the Rust code represents
validator results as `Option<Rc<Program>>` — `Some(new_state)` for
valid payloads, `None` for slash — and initiates a slash when it gets `None`.

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
validator. The referee runs the validator with the evidence. If the
validator returns `SLASH` (does not raise), the slash succeeds and the
slasher takes the full pot. If the validator raises, the slash attempt
fails.

**Timeout path** -- No validator is involved. The referee simply checks
that enough time has passed and pays out according to the current mover
share.

---

## Validator Chaining

Validators form their own chain, parallel to the handler chain. Each move
carries two validators:

- **Outgoing validator**: Validates the move being made right now. Its hash
  was committed by the *previous* move's `incoming_validator_hash`.
- **Incoming validator**: Will validate the opponent's *next* move. Its hash
  is committed in this move's on-chain state.

This creates a chain of commitments:

```
Move 0:
  outgoing_validator = a.clsp  (hash matches initial_validator_hash from proposal)
  incoming_validator = b.clsp  (hash stored on-chain for Move 1 to match)

Move 1:
  outgoing_validator = b.clsp  (hash matches what Move 0 committed)
  incoming_validator = c.clsp  (hash stored on-chain for Move 2 to match)

Move 2:
  outgoing_validator = c.clsp  (hash matches what Move 1 committed)
  incoming_validator = d.clsp  (hash stored on-chain for Move 3 to match)

...

Final move:
  outgoing_validator = e.clsp  (hash matches what the prior move committed)
  incoming_validator_hash = nil  (no next move)
```

The hash chain ensures that each player commits to the validation rules for
the *next* move before seeing that move. Neither player can retroactively
change what program will validate their opponent's response.

---

## On-Chain vs Off-Chain

### Off-Chain (Normal Play)

During normal play, both handlers and validators run off-chain on each
player's machine. The Rust code (`src/referee/my_turn.rs`,
`src/referee/their_turn.rs`) orchestrates this:

1. Call the handler to produce a move (or interpret one)
2. Run the validator to compute the new state
3. Update the referee's internal state
4. Send the move to the opponent via the potato protocol

Both players independently run the same validators and arrive at the same
state. If they disagree, one of them will detect fraud when they try to
validate the opponent's move.

The validator's `MAKE_MOVE` return includes the new state, so the handler
uses this directly rather than duplicating state-transition logic.

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
  opponent can submit evidence to the validator and take the full pot.
- On the **slash path**, the referee runs the validator with the provided
  evidence. If it returns `SLASH`, the slasher wins.

The same validator programs are used both off-chain (by the Rust code, to
verify moves as they happen) and on-chain (by the referee, for slash
enforcement). This guarantees consistency: if a move fails off-chain
validation, the evidence that caught it will also work on-chain.

---

## Message Parsers

Some games need to send information to the opponent outside the strict
turn-taking protocol. The **message parser** mechanism enables this.

### How It Works

1. A my-turn handler returns a `message_parser` program (element 10 of the
   return list). This program knows how to decode advisory messages for the
   current game state.
2. When the their-turn handler processes the opponent's reply, it can return
   an optional `message` (element 4 of the normal return). This message is
   sent to the opponent out-of-band.
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

## Worked Example: Calpoker

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

### Validator Chain

```
a.clsp ──> b.clsp ──> c.clsp ──> d.clsp ──> e.clsp ──> (nil, game over)
```

Each validator's hash is committed by the previous move, creating an
unbreakable chain of verification.

### The Steps

| Step | Mover | Handler | Validator | Move |
|------|-------|---------|-----------|------|
| a | Alice | `calpoker_alice_handler_a` | `a.clsp` | `sha256(preimage)` |
| b | Bob | `calpoker_bob_handler_b` | `b.clsp` | `bob_seed` |
| c | Alice | `calpoker_alice_handler_c` | `c.clsp` | `preimage \|\| sha256(salt\|\|discards)` |
| d | Bob | `calpoker_bob_handler_d` | `d.clsp` | `bob_discards` |
| e | Alice | `calpoker_alice_handler_e` | `e.clsp` | `salt\|\|discards\|\|selects` |

After step e, Alice's my-turn handler returns nil for `their_turn_handler`
and nil for `incoming_validator_hash`, signaling the game is over.

### Key Code

- Handlers: `clsp/games/calpoker/calpoker_generate.clinc`
- Validators: `clsp/games/calpoker/onchain/a.clsp` through `e.clsp`
- Rust-side handler invocation: `src/channel_handler/game_handler.rs`
- Rust-side referee state machine: `src/referee/my_turn.rs`,
  `src/referee/their_turn.rs`
- Handler API reference: `clsp/handler_api.txt`
