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

- **Validators** run on-chain inside the referee puzzle. They enforce the
  rules of each move, producing a new game state. They are also chialisp
  programs, one per protocol step (e.g. `a.clsp` through `e.clsp` for
  calpoker).

Handlers and validators are complementary: handlers decide *what* to play,
validators prove *that it was legal*. A handler that produces an illegal move
will pass off-chain (handlers trust each other's output) but fail on-chain
(the referee runs the validator, which raises).

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
- `evidence_list` contains potential slash evidence. Each item can be
  submitted as evidence in an on-chain slash spend. They may or may not
  actually validate -- the on-chain referee decides.
- `message` is optional (the fourth element may be absent). When present,
  it is sent out-of-band to the opponent and parsed by their
  `message_parser`.

### Return: Slash (2 elements)

```
(2 evidence)
```

The type tag `2` means the opponent's move is provably fraudulent. The
`evidence` is submitted for an on-chain slash. The game immediately ends
with a slash attempt.

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

## Validators

Validators are chialisp programs that run *on-chain* inside the referee
puzzle. They enforce the rules for a single step of the game protocol.

A validator takes the move and current state, and produces a new state (plus
a `MAKE_MOVE` or `SLASH` tag for the referee):

### Validator Return: Valid Move

```
(0 new_validation_info_hash new_state max_move_size mover_share ...)
```

Tag `0` (`MAKE_MOVE`) means the move is legal. The referee uses the returned
values to construct the next game coin.

### Validator Return: Slash

```
(2 ...)
```

Tag `2` (`SLASH`) means the move is illegal. When this happens during an
on-chain slash attempt, the slasher takes the full game amount.

### How the Referee Calls Validators

When a move is submitted on-chain, the referee:

1. Looks up the `previous_validation_info_hash` (the hash committed by the
   prior move)
2. Verifies that the revealed validation program + state match that hash
3. Runs the validator with the move and state
4. If the validator returns `MAKE_MOVE`, creates a new game coin with the
   updated state
5. If the validator raises (error), the move is rejected on-chain

For slash attempts, the referee runs the *previous* move's validator with
evidence. If the validator returns `SLASH`, the slash succeeds.

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

### On-Chain (Dispute)

When the channel goes on-chain, game coins are created from the last agreed
state. From that point:

- The **referee puzzle** (`clsp/referee/onchain/referee.clsp`) enforces the
  rules. It runs validators to check moves and produces new game coins.
- **Handlers are not used on-chain.** The on-chain path only needs the move
  bytes and the validator -- it doesn't need to interpret the move for a UI.
- The on-chain referee has three actions: **move** (advance the game),
  **timeout** (claim the pot when the opponent doesn't act), and **slash**
  (prove a previous move was invalid and take the full amount).

The key insight is that the same validator programs are used both off-chain
(by the Rust code, to verify moves as they happen) and on-chain (by the
referee puzzle, to enforce rules during disputes). This guarantees
consistency: if a move passes off-chain validation, it will pass on-chain
validation too.

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
