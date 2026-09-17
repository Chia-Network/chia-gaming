# Handler API

## Scope
This describes the calling convention and return shapes for off-chain
"handler" functions used by the game framework. Handlers are chialisp
programs that drive the game logic on each player's side. They are not
game-specific — calpoker is one implementation.


## Game Factory
Both peers run the same deterministic factory once with the uniform proper-list
wrapper:

```
(player_a_contribution player_b_contribution game_parameters)
```

`game_parameters` is the game's opaque CLVM value converted from Bencodex by
Rust. Bencodex text and byte strings are distinct on the wire even though both
become CLVM atoms; integers are limited to signed `i128` and use canonical
signed CLVM integer encoding, booleans map to nil/`1`, null maps to nil, and
lists remain proper lists.
Timeout, channel identity, local identity, and `sender_is_player_a` are not
factory inputs. A factory returns a proper, nonempty list of game records.
Every record is a proper list with exactly 10 fields:

```
(player_a_contribution player_b_contribution player_a_goes_first initial_move
 initial_max_move_size initial_state initial_mover_share my_turn_handler
 their_turn_handler validation_programs)
```

`player_a_goes_first` is canonical nil or `1`. Handler order is always the
handler for the player whose turn is first, followed by the handler for the
waiting player. Both peers execute and compare the complete ordered factory
shape locally; the wire retains only the ordered setup commitments, and the
receiver rebuilds raw state, handlers, and validator programs from its own
factory run. Rust maps player A/B to sender/receiver and local/opponent globally
using the proposal's one `sender_is_player_a` bit; member order never changes.
Field 5 remains `initial_state`. Field 9, `validation_programs`, is a proper,
nonempty list of every validator program the game may select. Its first program
is the initial validator; later programs are registry entries whose list order
has no protocol meaning. Validators are selected by tree hash. The first
member's first validation-program hash is the registered protocol identity.
Use canonical nil for `initial_state` unless the first transition genuinely
needs pre-existing validator state.

The host derives `amount` by adding the player A and B contributions. It
also calculates the first validator's tree hash, which is the protocol game ID
for the first record. Factories do not return either redundant value.

Canonical CLVM parameters, produced only inside the Rust host by converting the
game's structured Bencodex proposal parameters:

- Calpoker: nil.
- Space Poker: one positive bet-unit integer atom.
- Krunk: nil. Its factory is curried with the dictionary public key and tree
  and returns the fixed two-game atomic hand.

A factory probe returns the complete representative invocation list, not only
`game_parameters`: Calpoker currently probes with `(1 1 ())`, Space Poker with
representative contributions plus a positive bet unit, and Krunk with
`(100 100 ())`.


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

My-turn return (success, 4-5 elements):
  (
    label                          ; string, for UI/debug
    move                           ; bytes, the move to send on-chain
    mover_share                    ; int, our share if opponent times out
    their_turn_handler             ; program, handler for opponent's turn
    message_parser                 ; optional program or nil (see Message Parser below)
  )

  The handler does not return a validator program, validator hash, state, or
  move-size limit. The current validator is selected from the factory's
  `validation_programs`
  registry, initially its first entry. Running it with this move and nil
  evidence derives the next validator hash, new state, and next maximum move
  size. Rust resolves a non-nil hash in the registry and makes the resolved
  program current for the next move; nil is terminal.
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
    tests each candidate in list order by slash-invoking the committed referee
    with that evidence. If the invocation succeeds, the slash succeeds. If
    none of the candidates trigger a slash, the game
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
their-turn handlers get the same nil-evidence precheck as non-terminal handlers.
Rust first runs the validator to discover the candidate transition, then
slash-invokes a referee committed to that transition with nil evidence. If that
slash succeeds, the framework skips the handler. If any required nil-evidence
run raises, off-chain acceptance fails and the handler is not called with a
fabricated nil state. Otherwise a committed validator run supplies the
handler's `state`.
Inputs that survive a successful slash precheck are still peer-controlled and
must be safe for the handler to process.


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

Handlers do not return or chain validators. The factory supplies a nonempty
validator registry, and the referee begins with its first program. For each
move, Rust runs the current validator with nil evidence, reads the returned next
validator hash, and resolves that hash against the registry. Registry order
after the first entry is irrelevant.

For a peer move, transition discovery and slash checking are deliberately
separate executions. The discovery run determines the next validator hash,
state, and size limit. Rust then commits those values in real referee arguments
and slash-invokes nil evidence. After that check it obtains the committed state
for the handler, and every handler evidence candidate causes another ordered
slash invocation. Handlers only propose evidence; they do not replace these
validator executions.

Validator return values are untagged: a non-nil payload list for valid moves
`(next_validation_program_hash new_state max_move_size ...)`, or nil for slash.
Nil means the move is illegal for the supplied evidence. A non-nil result means
the move is valid only if the returned values match the next-state commitments
accepted by the move path; mismatched infohash or max-move-size values are
slashable on-chain. Validator-returned extra conditions are also slashable on
the slash path and are prepended to the payout conditions; this supports
conditional slashes, such as requiring an aggregate signature that proves a
challenged value falls in a committed range. Rust parses non-nil transition
payloads into the next hash, state, and size limit; nil means that slash
invocation succeeded.

Validator security rule: malicious moves must be slashable without validator
exceptions, while invalid slash attempts against valid moves must fail. Check
move length/shape before `substr` or expensive helpers, return nil for any
malicious move shape or rule violation, and return the valid transition when
nil evidence supplies no proof. The host uses that nil-evidence run to derive
the transition and next max move size. Non-nil evidence either proves its
specific accusation or fails to slash. A validator may reject unusable evidence
by raising or may treat it like nil and return the valid transition. Evidence
processing that can raise must occur only after the move itself is known to be
valid. A nil next validator hash is terminal and must agree with a nil next
handler from the unchanged their-turn handler output; a non-nil hash must
resolve to a program in the factory registry and accompany a non-nil next
handler. This continuation agreement is checked only after every handler
evidence candidate fails to slash: successful evidence is a terminal outcome
and the handler may deliberately omit its continuation in that case.
`mover_share` remains handler-owned and is not returned by validators.

Move-path enforcement: the on-chain referee does NOT re-run the validator
when a move is submitted. It trusts the submitted values and advances the
game. Enforcement comes from the threat of slashing — if a player cheats,
the opponent submits evidence to the validator on-chain and takes the pot.
This avoids running validation logic during honest play.
