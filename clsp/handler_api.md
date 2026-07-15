# Handler API

## Scope
This describes the calling convention and return shapes for off-chain
"handler" functions used by the game framework. Handlers are chialisp
programs that drive the game logic on each player's side. They are not
game-specific — calpoker is one implementation.


## Game Factory
Both peers run the same deterministic factory with only the canonical
parameters program. There is no proposal parser. A factory returns a proper,
nonempty list of game records. Every record is a proper list with exactly 12
fields:

```
(sender_contribution receiver_contribution amount sender_goes_first
 initial_validator_hash initial_move initial_max_move_size initial_state
 initial_mover_share my_turn_handler their_turn_handler initial_validator)
```

`sender_goes_first` is canonical nil or `1`. Handler order is always
my-turn followed by their-turn. Because both peers execute the identical
factory output, sender/receiver and my/their are interpreted relative to the
proposal sender when the records are installed.

Canonical parameters:

- Calpoker: proper list `(per_player_stake sender_goes_first)`.
- Space Poker: proper list
  `(per_player_stake bet_unit sender_goes_first)`.
- Krunk: the stake atom. Its factory is curried with the dictionary public key
  and tree and returns the fixed two-game atomic hand.


## Handler parameters
There are two kinds of handlers:

1) My-turn handler (I am making a move)
   (curried_args... local_move amount state mover_share entropy)

   - local_move: UI input for this turn (may be nil for automatic moves)
   - amount: total game amount
   - state: on-chain state from the previous validator
   - mover_share: current mover's share if timeout occurs
   - entropy: 32-byte random input for this turn

2) Their-turn handler (opponent just moved)
   (curried_args... amount pre_state state move validation_program_hash mover_share)

   - amount: total game amount
   - pre_state: on-chain state BEFORE the opponent's move
   - state: on-chain state AFTER the opponent's move
   - move: opponent's move bytes
   - validation_program_hash: tree hash of the validation program for this move
   - mover_share: opponent's share claim

   `validation_program_hash` is a raw program hash. It is not the validation
   info hash used in referee coin commitments, which is
   `sha256(validation_program_hash, shatree(state))`. Some existing handlers may
   still use the name `validation_info_hash` for this argument; the value passed
   here is the raw validation program hash because the framework has the
   validation program available at handler invocation time.


## Return values

My-turn return (success, 9-10 elements):
  (
    label                          ; string, for UI/debug
    move                           ; bytes, the move to send on-chain
    outgoing_validator             ; program, validates THIS move
    outgoing_validator_hash        ; hash of outgoing_validator
    incoming_validator             ; program, validates opponent's NEXT move
    incoming_validator_hash        ; hash of incoming_validator
    max_move_size                  ; int, max bytes the opponent may send
    mover_share                    ; int, our share if opponent times out
    their_turn_handler             ; program, handler for opponent's turn
    message_parser                 ; optional program or nil (see Message Parser below)
  )

  "outgoing" = validates the move we just produced (our move).
  "incoming" = validates the move the opponent will produce next.
  The their_turn_handler receives the opponent's response.
  message_parser may be absent. When present and non-nil, it can parse
  out-of-band messages from the opponent (see below).

My-turn return (rejection, 2 elements):
  (error_tag message_bytes)

  Returned when the handler rejects the local_move input (e.g. invalid
  discard selection). The Rust side raises GameMoveRejected.

My-turn return (error):
  (x ...)

  A CLVM raise — the handler crashed. The Rust side raises ClvmErr.


Their-turn return (normal move, 2-4 elements):
  (
    readable_move                  ; clvm value, UI-displayable result
    evidence_list                  ; list of fraud proofs (may be empty/nil)
    next_handler                   ; optional my-turn handler, or nil if game over
    message                        ; optional bytes, out-of-band message
  )

  - If next_handler is nil or absent, this is a final move (game over).
  - If next_handler is present, the game continues with our turn.
  - evidence_list contains potential slash evidence candidates. The
    handler does not need to verify each piece actually triggers a
    slash — just return everything that might work. The Rust framework
    tests each candidate by running the validator with that evidence;
    if the validator returns nil (slash) rather than a valid payload, the
    slash succeeds. If none of the candidates trigger a slash, the game
    continues normally. Evidence candidates that do not apply must be
    rejected by the validator as non-slashes (a non-nil result), not by
    requiring the handler to pre-filter them. Nil evidence is always
    tried automatically before the handler is called, so the handler
    never needs to include it. When the handler is certain the move is
    fraudulent, it puts the evidence in the list and can return junk for
    the other fields (they are ignored when a slash succeeds).
  - message is optional (element may be absent). When present and non-empty,
    it is sent out-of-band to the opponent and parsed by their message_parser.

Security rule: their-turn handlers run on adversarial peer moves. If a
peer-controlled move can make a their-turn handler raise, run expensively, or
allocate excessively before returning slash evidence, treat that as a security
bug by default. Referee-envelope violations such as `max_move_size` are checked
before the handler; game-rule violations that survive that envelope must be
handled as slashable validator outcomes/evidence, not handler crashes. Terminal
their-turn handlers get the same nil-evidence precheck as non-terminal handlers:
if nil evidence successfully slashes, the framework skips the handler. Inputs
that survive that precheck are still peer-controlled and must be safe for the
handler to process.


## Message Parser
An optional program returned by a my-turn handler. It runs on the
receiver's side to parse out-of-band messages from the opponent.

Parameters:
  (message state amount)

  - message: raw bytes sent by the opponent
  - state: current on-chain state (e.g. (alice_commit bob_seed))
  - amount: total game amount

Returns:
  readable_info (any clvm value for UI display), or raises on error.

Example: in calpoker, after Bob sends his seed (step b), Alice sends
her preimage as an out-of-band message. Bob's parse_message verifies
sha256(preimage) == alice_commit, then returns the derived cards for
display.


## Notes on validators vs handlers
Validators (a.clsp through e.clsp) run both on-chain and off-chain.
Handlers run off-chain only to produce moves and interpret opponent moves.

A handler returns two validators per move:
  - outgoing_validator: validates the move we just made
  - incoming_validator: validates the opponent's reply

The outgoing_validator_hash must match what the previous incoming_validator
specified, creating a chain of validated state transitions.

Validator return values are untagged: a non-nil payload list for valid moves
`(next_validation_program_hash new_state max_move_size ...)`, or nil for slash.
Nil means the move is illegal for the supplied evidence. A non-nil result means
the move is valid only if the returned values match the next-state commitments
accepted by the move path; mismatched infohash or max-move-size values are
slashable on-chain. Validator-returned extra conditions are also slashable on
the slash path and are prepended to the payout conditions; this supports
conditional slashes, such as requiring an aggregate signature that proves a
challenged value falls in a committed range. Rust parses the result as Option —
Some(new_state) for valid moves, None for slash — and uses None to initiate a
slash.

Validator security rule: malicious moves must be slashable without validator
exceptions, while invalid slash attempts against valid moves must fail. Check
move length/shape before `substr` or expensive helpers, return nil for any
malicious move shape or rule violation, and only then inspect evidence that may
raise to reject malformed evidence.

Move-path enforcement: the on-chain referee does NOT re-run the validator
when a move is submitted. It trusts the submitted values and advances the
game. Enforcement comes from the threat of slashing — if a player cheats,
the opponent submits evidence to the validator on-chain and takes the pot.
This avoids running validation logic during honest play.
