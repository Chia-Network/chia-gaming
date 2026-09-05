# How to Add a Game

This guide explains the pieces you need to add a game and how they fit
together. Start with the package layout and the step-by-step checklist. The API
reference near the end is useful when you are implementing each file.

A game has three main parts:

1. **CLVM rules** define valid moves and protect both players if a dispute goes
   on-chain.
2. **Tests** exercise those rules through Rust or another harness.
3. **A TypeScript/React UI** lets players propose a hand, play it, and restore
   it after a refresh.

You do not need to understand every part of the player application. Game code
uses the protocol and package interfaces in
[`games/host/index.ts`](games/host/index.ts). Keep your game behind that
interface so it remains independent of this particular frontend.

If state channels are new to you, read [`OVERVIEW.md`](OVERVIEW.md) first. For
deeper protocol rationale and advanced CLVM patterns, use
[`HANDLER_GUIDE.md`](HANDLER_GUIDE.md) and
[`clsp/handler_api.md`](clsp/handler_api.md). This guide includes the contracts
and examples needed to connect a game to the host; those documents explain why
the referee and validator design works.

## The example used in this guide

California Poker is the main worked example because it is the smallest
production game with a factory, handlers, on-chain validators, proposal UI,
durable hand state, automatic moves, and a finished-hand mount. Short excerpts
are included here. Follow the links when the complete implementation is more
useful than another large code block.

The walkthrough focuses on the package API. California Poker internally masks
some simultaneous commitment and reveal steps behind ordinary turns; you do not
need to reproduce or understand every poker phase to use the same boundaries in
another game.

## Start from an existing game

The fastest way to begin is to copy the game that is closest to what you are
building:

- [`games/calpoker`](games/calpoker) is the simplest complete example. Its
  factory creates one game.
- [`games/spacepoker`](games/spacepoker) shows a game with several rounds and
  more substantial UI state.
- [`games/krunk`](games/krunk) shows a factory that creates two linked games
  from one proposal.
- [`games/debug`](games/debug) is only for protocol tests. It does not have a
  production UI.

## Directory structure

Put the new game in `games/<key>/`, where `<key>` is a short lowercase name
such as `calpoker`.

```text
games/<key>/
  clsp/
    factory.clsp          # Creates the initial game program and state
    factory_probe.clsp    # Returns one representative valid parameter value
    factory_args.clvm.bin # Optional generated curry arguments
    onchain/              # Checks moves during an on-chain dispute
    *_generate.clinc      # Handles moves while the game is off-chain
  rust/                   # Optional; omit when using a non-Rust test harness
    mod.rs                # Rust helpers and test module declaration
    tests/                # Optional Rust CLVM/handler/validator/simulator tests
  ui/
    handProposalForm.tsx  # Form used to propose a new hand
    handProposal.ts       # Proposal validation and factory parameters
    serialize.ts          # Optional organization for hand state and transitions
    play.tsx              # Live and finished-hand React views
    styles.css            # Optional game-specific styles
```

Production packages require `handProposal.ts`, `handProposalForm.tsx`, and
`play.tsx`. Other UI modules are package-private organization: the reference
games use `serialize.ts`, but the build neither requires nor imports that name.
If `ui/styles.css` exists, the frontend generator includes it automatically.

The frontend catalog is generated, so do not create `ui/index.ts`. Each UI
file has a conventional export that the generator discovers:

- `handProposal.ts` has a default export containing the game registration.
- `handProposalForm.tsx` exports `HandProposalForm`.
- `play.tsx` exports `play`.

The generator passes those three exports through the frontend-owned
`defineGamePackage`. This is the compile-time boundary that proves the proposal
draft, complete hand state, concrete hand type, factory parameters, form, and
mount belong to one coherent package. The generated keyed registry then exposes
a frontend-only erased runtime facade. Game packages do not import or call
`defineGamePackage`.

## Step 1: Register the game

Add the key to [`games/registry.json`](games/registry.json):

- Use the `production` list for a playable game with a UI.
- Use the `test` list for a game that exists only in automated tests.
- Use a key matching `[a-z][a-z0-9_]*`; Rust keywords and the reserved key
  `host` are rejected.

That is the only catalog you edit by hand. The build generates frontend imports
and the factory preset list for every production package. When `rust/mod.rs` or
`rust/tests/mod.rs` exists, it also generates the corresponding Rust module or
internal test-suite aggregation.

The catalog key must equal the `games/<key>/` directory name. The build
automatically compiles `clsp/factory.clsp`, `clsp/factory_probe.clsp`, and
production `.clsp` files below `clsp/onchain/`; do not add package entries to
`chialisp.toml`. Run `./cb.sh` before the first frontend build so the generated
prepared factory exists for the frontend registry generator.

Do not edit or check in compiled `.hex` files, prepared factory binaries, or
`games/package_manifest.json`; they are generated implementation artifacts.
Game packages maintain their `.clsp` sources and, when needed, the optional
`factory_args.clvm.bin` input.

Two identifiers appear in the code:

- The **catalog key** is the readable name from `registry.json`. The frontend
  uses it in saves and when choosing a UI package.
- The **protocol ID** is the first generated game's initial validation puzzle
  hash (`initial_validation_program_hash`). Peers use that puzzle hash to
  identify the game on the wire. It is not a hash of the factory code.

Normally your game code only deals with the catalog key. The host converts
between the key and protocol ID at the WASM boundary.

## Step 2: Implement the CLVM rules

The factory is invoked once with this exact proper list:

```clojure
(player_a_contribution player_b_contribution game_parameters)
```

It returns the game or games that the peers will run. It must be deterministic:
both peers run the same factory with the same A/B contributions and parameters
and must get the same result.

Most factories create one game. A factory may create several games that must
be accepted or cancelled together; the code calls these an atomic group.
Krunk is the reference example for that case.

`factory.clsp` is normally only an exported entry point. California Poker uses:

```clojure
(include *standard-cl-23*)

(import games.calpoker.clsp.calpoker_generate exposing calpoker_factory)

(export calpoker_factory)
```

Module paths start at a repository include root, so package modules use names
such as `games.<key>.clsp.<module>`. The factory implementation may live in a
`.clinc` module so handlers and tests can import the same definitions.

The result is a nonempty proper list. Every member is a proper list with exactly
these 10 fields:

```clojure
(player_a_contribution player_b_contribution player_a_goes_first initial_move
 initial_max_move_size initial_state initial_mover_share my_turn_handler
 their_turn_handler initial_validator)
```

The fields mean:

| Field | Required value |
| --- | --- |
| `player_a_contribution`, `player_b_contribution` | Factory-approved mojo contributions for this member. |
| `player_a_goes_first` | Canonical nil or `1`. |
| `initial_move` | The first committed move as a CLVM atom; use nil when there is no pre-existing move. |
| `initial_max_move_size` | Maximum byte length accepted for that move. |
| `initial_state` | Initial validator state; any CLVM value. |
| `initial_mover_share` | Mover's timeout payout in mojos, between zero and the member's total amount. |
| `my_turn_handler` | Off-chain program for the player who starts. |
| `their_turn_handler` | Off-chain program for the waiting player. |
| `initial_validator` | On-chain program committed at game start and used to begin validator chaining. |

The handler fields are program values, not names. Curry secrets or
role-specific data into them when needed. California Poker validates equal
positive contributions and nil parameters, then emits one record:

```clojure
(import games.calpoker.clsp.onchain.a exposing (program as pokera))
(import std.li)
(import std.assert)
(import std.relops)
(import std.deep_compare)

(defun calpoker_factory
    (@ _args (player_a_contribution player_b_contribution game_parameters))
    (assert
        (> player_a_contribution 0)
        (= player_a_contribution player_b_contribution)
        (not game_parameters)
        (deep= _args (li player_a_contribution player_b_contribution game_parameters))
        (li
            (li player_a_contribution player_b_contribution 1
                0 32 0 0
                calpoker_alice_handler_a
                calpoker_bob_handler_a
                pokera
            )
        )
    )
)
```

Validate the exact contribution and parameter shape in the factory. It is the
semantic authority for proposal acceptance; a frontend form is only an earlier
user-facing check. See the complete
[`calpoker_generate.clinc`](games/calpoker/clsp/calpoker_generate.clinc) for
handler currying and the remaining move sequence.

The proposal sender is mapped to A or B once by the proposal-wide
`senderIsPlayerA`/`sender_is_player_a` value. Rust uses that mapping to project
A/B contributions and turns into each peer's local perspective; it does not
reinterpret or reorder factory members. Krunk always returns two members in
fixed order: member 0 has player A first and member 1 has player B first.

Return each player's contribution separately; the host derives the total
amount. Return the initial validator program itself; the host derives its tree
hash. The first member's initial-validator hash is the package's protocol
identity. See [the factory return format](clsp/handler_api.md#game-factory).

During play, the engine uses:

- A **my-turn handler** to turn a local UI action into the next move.
- A **their-turn handler** to read and apply the opponent's move.
- **Validators** to reject moves that do not follow the rules.
- An optional **message parser** for game messages that update the UI without
  changing whose turn it is.

Handlers run off-chain. Their signatures are:

```clojure
; Local player creates a move.
(curried_args... local_move amount state mover_share entropy)

; Opponent's move has been applied.
(curried_args... amount pre_state state move validation_program_hash mover_share)
```

`amount` is the member's combined pot. `entropy` is fresh 32-byte input for the
local turn. The their-turn `validation_program_hash` is the raw tree hash of
the validator program, not the state-bound validation-info hash.

`mover_share` is the mover's timeout payout on the currently committed referee
coin; the waiting player receives `amount - mover_share`. A local move chooses
the share for the next coin. The opponent-facing handler and validator must
reject a peer move whose declared share disagrees with the game result.

A successful my-turn handler returns seven or eight values:

```clojure
(label move outgoing_validator incoming_validator max_move_size
 mover_share their_turn_handler optional_message_parser)
```

`outgoing_validator` validates the move just created.
`incoming_validator` commits to the opponent's next move. A two-value
`(error_tag message_bytes)` return rejects local UI input as `MoveRejected`; a
CLVM raise is an internal handler failure.

The host validates that the addressed member currently grants local move
authority, then runs this my-turn handler synchronously at the move-directive
boundary. A tagged rejection is therefore synchronous and queues no readable
input. On success Rust retains only a durable uncurried `PreparedMove` containing
the relevant handler outputs, including the optional parser when present. It does not
retain the readable, entropy, a transaction, a curried referee, or a derived
puzzle hash. Potato acquisition or later on-chain actuation consumes that
prepared output to apply/curry/sign/send; it never reruns your handler.
Post-application redo caching is a separate protocol mechanism.

Import validators using their compiled `program` export, as above. Factory field
10 and handler validator returns contain those program values. Handler functions
are also program values; use `(curry handler captured_value...)` when the next
phase needs a secret or other role-specific data.

A their-turn handler returns:

```clojure
(readable_move evidence_candidates optional_next_my_turn_handler optional_message)
```

`readable_move` is serialized across the Rust/WASM boundary. The JavaScript
host deserializes it once and delivers it to the game package as the
`Program` in `move-readable`.
`evidence_candidates` is a list of possible fraud proofs. A missing or nil next
handler ends the game. An optional message is sent separately and parsed by the
message parser `(message state amount)`, whose result becomes
`message-readable`.

California Poker's first pair illustrates both entry directions. The starting
player creates a commitment and curries its secret into a later handler. The
waiting player's initial their-turn handler interprets that commitment and
returns its first my-turn handler:

```clojure
(defun calpoker_alice_handler_a (local_move amount state split entropy)
  (assign
    preimage (substr entropy 0 16)
    (list "calpoker_alice_handler_a"
          (sha256 preimage)
          pokera pokerb 48 0
          (curry calpoker_alice_handler_b preimage))))

(defun calpoker_bob_handler_a
    (amount pre_state state move validation_program_hash split)
  (list 0 0 calpoker_bob_handler_b))
```

The zero readables are CLVM nil and the empty evidence list. Your own handlers
may expose meaningful readables immediately; the important structure is that
the two factory entry handlers meet at the same validated state transition.

Their-turn handlers process adversarial peer input. Check cheap shape and
length constraints before indexing, hashing, or allocating. A game-rule
violation must produce slash evidence that makes the validator return nil, not
crash the handler. The framework checks the envelope's committed maximum move
size and tries nil evidence before calling the handler.

Validators run both off-chain when checking evidence and on-chain during a
slash. Every validator has this input shape:

```clojure
(export
  (mod_hash
    (MOVER_PUBKEY WAITER_PUBKEY TIMEOUT AMOUNT MOD_HASH NONCE
     MOVE MAX_MOVE_SIZE VALIDATION_INFO_HASH MOVER_SHARE
     PREVIOUS_VALIDATION_INFO_HASH)
    previous_state previous_validation_program evidence)
  ...)
```

`mod_hash` is the current validator's tree hash. `MOD_HASH` identifies the
referee puzzle. `MOVE`,
`MAX_MOVE_SIZE`, `VALIDATION_INFO_HASH`, and `MOVER_SHARE` are the values
committed by the move being challenged. The final arguments provide the
previous state, the previous validator program, and the proposed evidence.

Return a nonempty proper list for a valid move:

```clojure
(next_validation_program_hash new_state next_max_move_size optional_conditions...)
```

Return nil when the move is illegal for that evidence and should slash.
Terminal validators may return `(list 0)`. Check move shape before operations
such as `substr`; malformed evidence for a valid move must not accidentally
turn that move into a slash. California Poker's first validator is a compact
example:

```clojure
(export (mod_hash
    (MOVER_PUBKEY WAITER_PUBKEY TIMEOUT AMOUNT MOD_HASH NONCE
     MOVE MAX_MOVE_SIZE VALIDATION_INFO_HASH MOVER_SHARE
     PREVIOUS_VALIDATION_INFO_HASH)
    previous_state previous_validation_program evidence)
  (if (= (strlen MOVE) 32)
      (list bhash MOVE 16)
      0))
```

The first validator is not executed to create the first local move; the factory
supplies `initial_state`, and the handler returns the validators that continue
the chain. Each outgoing validator hash must match the prior incoming
commitment. See California Poker's
[`onchain/`](games/calpoker/clsp/onchain) directory for the complete chain,
[`HANDLER_GUIDE.md`](HANDLER_GUIDE.md) for complete move-chain,
nil-move, evidence, and conditional-slash examples,
[`clsp/handler_api.md`](clsp/handler_api.md) for the full return contracts, and
[`CLVM_DOS.md`](CLVM_DOS.md) for cost and size limits.

## Step 3: Add the factory probe

Add `games/<key>/clsp/factory_probe.clsp`, a no-argument Chialisp program that
returns one representative valid complete factory argument list: contributions
for A and B followed by the game parameters. Calpoker's current probe is:

```clojure
(include *standard-cl-23*)

(export () (list 1 1 ()))
```

The final `()` is Calpoker's nil parameter value; it is not an omitted
argument. Krunk uses `(list 100 100 ())`, while Space Poker supplies its positive
integer bet unit as the third item. The build compiles both files, curries any
`factory_args.clvm.bin` into the factory, and runs the probe against that
prepared factory. It records the first returned game's initial validation
puzzle hash as the protocol ID and emits one prepared binary factory for
runtime use. The factory itself is never hashed as an identifier.

Factory loading, binary serialization, caching, and registration are player
implementation details. A game package does not implement Rust loader
functions. If a generated external data set must be curried into the factory,
write it as a proper list of arguments at
`games/<key>/clsp/factory_args.clvm.bin`; Krunk's signed dictionary generator
is the example. Probe programs and factory-argument files are build inputs;
the browser downloads neither of them.

Test the handlers and validators with the harness appropriate to the package.
Rust tests may live under `games/<key>/rust/tests/`; production packages using a
non-Rust harness may omit both `rust/mod.rs` and `rust/tests/mod.rs`. When Rust
tests are present, `rust/mod.rs` must declare `#[cfg(test)] pub mod tests;`, and
`rust/tests/mod.rs` must expose `pub fn test_funs()`. The build discovers that
file and adds its closures to the internal full-suite runner; there is no
handwritten per-package test list.

A typical `rust/tests/mod.rs` is:

```rust
pub mod handlers;
pub mod validation;

pub fn test_funs() -> Vec<(&'static str, &'static (dyn Fn() + Send + Sync))> {
    let mut funs = handlers::test_funs();
    funs.extend(validation::test_funs());
    funs
}
```

Rust tests load generated CLVM by repository path:

```rust
let validator =
    read_hex_puzzle(&mut allocator, "games/<key>/clsp/onchain/step.hex")
        .expect("compiled validator");
```

Test handlers as state transitions and validators through the referee/slash
path, not only by invoking validator programs with invented arguments.
California Poker's
[`handlers.rs`](games/calpoker/rust/tests/handlers.rs) and
[`validation.rs`](games/calpoker/rust/tests/validation.rs) are the complete
examples; their card calculations are game-specific, but their puzzle loading,
move-chain, and slash harness structure are reusable.
Start from `calpoker_factory_succeeds` for factory invocation and
`test_calpoker_handlers_happy_path` for a two-sided handler chain. There is no
package-facing Rust helper that can infer your handler arguments or readable
shapes, so adapt those explicit lists to the contract your CLVM defines rather
than inventing a second runtime adapter.

The `test` array in `games/registry.json` is a separate internal mechanism for
Rust-only test packages. The existing `debug` package uses it to register its
bespoke `prepared_factory` and `probe_parameters` functions with simulator
tests; it is not the way a production package selects its test harness. Use
[`SIMULATOR_TESTING.md`](SIMULATOR_TESTING.md) when a Rust test needs the
blockchain simulator.

## Step 4: Define how a hand is proposed

The proposal flow has three representations:

```text
mounted form state → typed package parameters → opaque HandProposal
```

Keeping these representations separate makes each boundary clear:

- The mounted React form owns temporary controls and validation presentation.
- Its imperative handle returns sender/receiver contributions plus typed,
  package-owned parameters.
- The host immediately encodes those parameters to `ProposalParameterValue` and
  constructs the final `HandProposal`, which contains catalog `gameType`,
  player-A/player-B contributions, sender orientation, timeout, and the exact
  opaque Bencodex value. Rust is the semantic authority for the factory input.

Implement the React form in `handProposalForm.tsx` with `forwardRef`. It owns
its editable state and exposes `GameProposalFormHandle<TParams>`. Export it as:

```tsx
export const HandProposalForm = forwardRef<
  GameProposalFormHandle<MyParams>,
  HandProposalFormProps<MyParams>
>(function HandProposalForm(
  { disabled, maxPerHandMojos, defaultContribution, initialValues, onSubmit },
  ref,
) {
  const initialAmount = initialValues?.senderContribution ?? defaultContribution;
  const [amount, setAmount] = useState(initialAmount);
  useImperativeHandle(ref, () => ({
    getProposal: () =>
      amount > 0n && (maxPerHandMojos === null || amount <= maxPerHandMojos)
        ? {
            ok: true,
            senderContribution: amount,
            receiverContribution: amount,
            parameters: {} as MyParams,
          }
        : { ok: false, error: 'Enter a positive affordable stake.' },
  }));
  return (
    <input
      disabled={disabled}
      value={amount.toString()}
      onChange={(event) => setAmount(BigInt(event.currentTarget.value))}
      onKeyDown={(event) => event.key === 'Enter' && onSubmit()}
    />
  );
});
```

### Proposal form API

The complete package-facing form contract is:

```ts
interface HandProposalFormProps<TParams> {
  ref?: Ref<GameProposalFormHandle<TParams>>;
  disabled: boolean;
  maxPerHandMojos: bigint | null;
  defaultContribution: bigint;
  initialValues: {
    senderContribution: bigint;
    receiverContribution: bigint;
    parameters: TParams;
  } | null;
  onSubmit: () => void;
}
```

`HandProposalFormProps` is the declarative React prop bag supplied by the host;
it is not a constructor interface or a getter. When host session state changes,
React renders the parent again and passes current values such as `disabled` to
the form. The form passes those values to its controls. It does not need an
enable/disable method or callback.

The `ref` is the separate imperative part. A `forwardRef` component receives it
as its second function argument, and `useImperativeHandle` exposes
`getProposal()` through it. The host calls that method only when the user
submits, so it can pull and validate the form's current private draft. The
remaining fields, including `onSubmit`, are ordinary props.

- `disabled` is true after submission while the host is preventing another
  proposal. Disable every editable control and submit action when it is true.
  Changing it does not clear the form's local draft.
- `maxPerHandMojos` is the largest currently available contribution per player,
  in mojos. `null` means the host cannot provide a balance-derived limit; it
  does not make an otherwise invalid draft valid.
- `defaultContribution` seeds a fresh mounted form. `initialValues` may seed a
  counter/retry form. Its parameters are already decoded to `TParams`, and its
  contributions are oriented to the proposal being composed now: `sender` is
  the local proposer and `receiver` is the peer, regardless of who proposed the
  previous hand. These values initialize local `useState` when the form mounts;
  they do not continuously overwrite edits if the parent later rerenders.
- `onSubmit()` asks the host to call the active handle. `getProposal()` returns
  either `{ ok: true, senderContribution, receiverContribution, parameters }`
  or `{ ok: false, error }`. The form displays its own validation error.

The result uses the same orientation: `senderContribution` is what the local
proposer commits and `receiverContribution` is what the accepting peer commits.
The host maps those values to stable factory player A/B fields and supplies the
proposal-wide sender-orientation bit. Games never inspect that bit.

The host owns the game selector and `gameTimeout`; they are deliberately absent
from this interface. The game form owns only game-specific draft fields. A form
must not send a proposal or call protocol APIs itself.

The game also owns its form controls, amount-unit choices, formatting, and
validation copy. Amounts cross the package boundary as absolute mojo `bigint`
values. There is deliberately no shared game UI component or currency-formatting
service: reference games may duplicate small controls so their presentation
implementations remain independent.

Implement the package registration in `handProposal.ts`. The complete
registration contract is:

```ts
interface GamePackageRegistration<TState, THand extends GameHand<TState>, TParams> {
  readonly displayName: string;
  createHand(init: GameHandInitialization): THand;
  restoreHand(savedState: unknown): THand;
  readonly proposalParameters: ProposalParameterCodec<TParams>;
  describeHandProposal(handProposal: HandProposal): string;
}
```

`displayName` is player-facing catalog text. `proposalParameters` is the one
typed parameter codec. `describeHandProposal` decodes
`handProposal.parameters` through that codec and must fail if the player app
cannot project the Rust-approved value. `handProposal.ts` must default-export
this object because the generated registry imports that default.

California Poker has no game-specific proposal parameter, so its complete
codec and registration are small:

```ts
type CalpokerFactoryParameters = Record<string, never>;

const proposalParameters: ProposalParameterCodec<CalpokerFactoryParameters> = {
  decode: (value) => (value === null ? {} : null),
  encode: () => null,
};

const registration: GamePackageRegistration<
  CalpokerHandState,
  CalpokerHand,
  CalpokerFactoryParameters
> = {
  displayName: 'California Poker',
  createHand: createCalpokerHand,
  restoreHand: restoreCalpokerHand,
  proposalParameters,
  describeHandProposal(proposal) {
    if (proposalParameters.decode(proposal.parameters) === null) {
      throw new Error('California Poker proposal parameters are invalid');
    }
    return `Stake ${proposal.playerAContribution} mojos each`;
  },
};

export default registration;
```

Space Poker is the reference for a nonempty typed parameter record: it maps a
positive Bencodex integer to `{ betUnitMojos: bigint }`. Reuse the same codec in
the form, `describeHandProposal`, and `createHand`; do not maintain separate
decoders.

The unabridged example is
[`games/calpoker/ui/handProposal.ts`](games/calpoker/ui/handProposal.ts).

Game frontend code must not construct, deserialize, or inspect CLVM here. Rust
converts the opaque Bencodex value to factory input and remains the semantic
authority.

### Proposal-parameter codec API

```ts
interface HandProposalBase {
  playerAContribution: bigint;
  playerBContribution: bigint;
  senderIsPlayerA: boolean;
  gameTimeout: bigint;
  parameters: ProposalParameterValue;
}

type HandProposal = HandProposalBase & {
  gameType: string;
};

type ProposalParameterValue =
  | null
  | boolean
  | bigint
  | string
  | Uint8Array
  | readonly ProposalParameterValue[];

interface ProposalParameterCodec<TParams> {
  decode(value: unknown): TParams | null;
  encode(params: TParams): ProposalParameterValue;
}
```

The codec validates exact JavaScript types without coercion. Bencodex text
strings are JavaScript `string`; byte strings are `Uint8Array`; integers are
`bigint` within Rust's inclusive signed `i128` range; booleans, null, and proper
lists retain their own types. Values outside `i128::MIN..=i128::MAX` are rejected
at the peer decoding boundary rather than promoted to arbitrary precision. For
example:

```ts
const text: ProposalParameterValue = 'unit';
const bytes: ProposalParameterValue = new Uint8Array([0x75, 0x6e, 0x69, 0x74]);
const integer: ProposalParameterValue = 100n;
```

Those three values are distinct even though their CLVM atom bytes can overlap.
Calpoker and Krunk codecs encode typed empty parameter records as `null`:
`decode(null) -> {}` and `encode({}) -> null`. Space Poker decodes a positive
`bigint` as `{ betUnitMojos }` and encodes that record back to the same
`bigint`. The host persists the encoded value directly and never reconstructs
package-specific fields.

## Step 5: Own one hand instance

The protocol state in Rust is not enough to restore every detail of a React UI.
For example, a card game may need revealed cards and current selections. Define
one complete game-owned state type and implement both `createHand(init)` and
`restoreHand(savedState)`. The first receives accepted initialization terms for
a new hand. The second receives an `unknown` saved value—never proposal or
initialization data—and must validate it with the package's hand-state predicate
before constructing the hand. Invalid state fails immediately at this boundary.

The shared `GameHand<TState>` exposes only `receive(update)` and `getState()`.
Define any local mutation method on your package's concrete hand type. The
typed package/mount assembly lets your UI call that private method without
adding setters to the shared API. `restoreHand` constructs a replacement hand
directly from the complete saved state; it does not create a fresh hand and
overwrite it.

The complete initialization shape is:

```ts
interface GameHandInitialization {
  parameters: ProposalParameterValue;
  members: readonly {
    playerAContribution: bigint;
    playerBContribution: bigint;
    ourTurn: boolean;
  }[];
}
```

The initial state must copy every accepted fact the play UI needs:
game-specific proposal terms decoded from `parameters`, plus each factory
member's approved A/B contributions and local initial turn from `members`.
These member contributions are factory output and may differ from the
proposal-wide inputs; derive a member's total only as
`playerAContribution + playerBContribution`. Assert the expected member count
and contribution topology.
Protocol IDs, proposal origin, and session `iStarted` are deliberately
inaccessible to packages.

A concrete hand is normally a small mutable closure around the complete state.
California Poker's pattern, trimmed to the package boundary, is:

```ts
interface CalpokerHand extends GameHand<CalpokerHandState> {
  update(reducer: (state: CalpokerHandState) => CalpokerHandState): void;
}

function handFromState(initial: CalpokerHandState): CalpokerHand {
  let state = initial;
  return {
    getState: () => state,
    receive(update) {
      state = reduceHandState(state, update);
    },
    update(reducer) {
      state = reducer(state);
    },
  };
}

function createHand(init: GameHandInitialization): CalpokerHand {
  if (init.members.length !== 1) throw new Error('Expected one member');
  const member = init.members[0];
  if (
    member.playerAContribution <= 0n ||
    member.playerAContribution !== member.playerBContribution
  ) {
    throw new Error('Expected equal positive contributions');
  }
  return handFromState({
    perPlayerStake: member.playerAContribution,
    playerHand: [],
    opponentHand: [],
    cardSelections: [],
    moveNumber: 0n,
    isPlayerTurn: member.ourTurn,
    iStarted: !member.ourTurn,
    settlementOutcome: null,
  });
}

function restoreHand(savedState: unknown): CalpokerHand {
  if (!isCalpokerHandState(savedState)) {
    throw new Error('Saved California Poker state is invalid');
  }
  return handFromState(savedState);
}
```

See [`games/calpoker/ui/serialize.ts`](games/calpoker/ui/serialize.ts) for the
complete state predicate and readable reducers.

For a parameterized game, decode `init.parameters` through the registration's
`proposalParameters` codec before constructing state and fail if it returns
`null`. `restoreHand` receives only the inner game-owned state, not the generic
`{ gameType, state }` host envelope. A game may derive and persist a local role
such as California Poker's `iStarted` from `member.ourTurn`; it does not receive
the similarly named player-app session field.

Route all host updates through `receive`. A minimal reducer shape is:

```ts
function reduceHandState(state: MyHandState, update: GameUpdate): MyHandState {
  switch (update.type) {
    case 'move-readable':
      return applyOpponentMove(state, update.readable, update.moverShare);
    case 'message-readable':
      return applyAdvisoryMessage(state, update.readable);
    case 'hand-ended':
      return { ...state, myTurn: false, settlementOutcome: update.outcome };
  }
}
```

If the handler chain never returns a message parser, receiving
`message-readable` is an internal contract violation and may throw. Otherwise,
an advisory message updates game-owned display state but does not imply a turn
change. `hand-ended.outcome` may be null; always mark the addressed member
finished and persist whatever terminal result the frozen mount needs.

Multi-member games keep members in this stable factory order. Krunk stores
`members: readonly [KrunkGameState, KrunkGameState]`; index 0 and index 1 remain
the factory's two members for the hand's lifetime and settle independently.
Its factory assigns the A contribution to member 0 and the B contribution to
member 1, leaving the opposite contribution zero in each member. One mounted
UI renders both members and dispatches each panel's actions with its fixed
index. Each local mutation and host update replaces only that addressed member
slot; it must never spread or overwrite move/handler state in the sibling slot.
The complete persisted hand still contains both members. This demonstrates that
member topology is factory-defined and need not be two symmetric copies of the
proposal stake.
The protocol updates themselves identify games by private protocol ID. Before
calling `GameHand.receive`, the host looks that ID up in the accepted group's
ordered ID list and supplies the corresponding `memberIndex`. In the opposite
direction it maps an intent's `memberIndex` back to the protocol ID. Packages
therefore address Krunk's members as 0 and 1 without receiving or persisting
protocol IDs.

Single-member games use index 0. The host treats `getState()` as opaque
Bencodex-compatible data and saves `{ gameType, state }` generically. Game-owned
persisted state stores member order/indices, not protocol IDs.
Games do not provide envelope serializers, versions, compatibility decoders, or
migrations.

Every playable package must support a frozen mount and `restoreHand`. A finished
session always attempts a cold read-only remount when a valid
`PersistedGameState` exists. During in-place finalization the host restores the
hand from the finalized terminal model before rendering the frozen branch.
`frozen` means terminal, read-only, and structurally without a port; it does not
mean “keep whatever mutable hand happened to be mounted.”

Proposal snapshots persist the exact opaque `parameters` value and all generic
A/B terms in `lastHandProposal`. The compose model separately persists the
selected game, timeout, and submission state; it does not persist a package
form's individual controls. When mounting a counter or retry form, the host
decodes the stored parameters and reorients the stored A/B contributions into
local-sender/peer-receiver `initialValues`. The package then owns a new
temporary draft initialized from those values. Do not add game-specific
proposal save keys or a second persistence codec. Hand state remains saved
generically from `GameHand.getState()`.

“Same terms” and retry comparisons are player-app bookkeeping, not game
semantics. The host compares game type, contributions, timeout, and the complete
opaque parameter value structurally. It also compares each physical player's
A/B role after combining proposal origin with `senderIsPlayerA`; when the other
player proposes a redo, both values flip and the resulting orientation remains
equal. Games do not provide an equality hook.

## Step 6: Build the play UI

Implement `play.tsx` and export a `GameMountRegistration` named `play`. It has
one `render(view)` function. Every render receives the live or restored
`GameHand`, player display names, and `frozen`. Accepted stakes, current
turn/handler, factory-ordered member state, and terminal results come from the
complete hand state rather than parallel host projections. Protocol IDs never
cross this package boundary.

`frozen` is the type discriminant:

- `frozen: false` includes the typed intent port.
- `frozen: true` has no protocol capability.

`frozen` distinguishes a live mount from a read-only terminal mount. It is not
move permission. Your components decide whether each control is enabled from
their own turn, handler, and terminal state; the frozen branch merely makes it
structurally impossible to dispatch a protocol command. Detailed abnormal
termination text remains in player-app status surfaces rather than crossing
this boundary.

```ts
type GameMountView = {
  hand: ConcretePackageHand;
  myName?: string;
  opponentName?: string;
} & (
  | { frozen: false; port: LiveGamePort; appendGameLog(line: string): void }
  | { frozen: true }
);
```

Keep `play.tsx` thin. California Poker's registration is essentially:

```tsx
function CalpokerMount({ view }: { view: GameMountView<CalpokerHand> }) {
  const hand = useCalpokerHand(view);
  return (
    <Calpoker
      frozen={view.frozen}
      myName={view.myName}
      opponentName={view.opponentName}
      playerHand={hand.playerHand.map(String)}
      handleMakeMove={hand.handleMakeMove}
      terminalOutcome={hand.terminalOutcome}
      // Other game-specific presentation props.
    />
  );
}

export const play: GameMountRegistration<CalpokerHand> = {
  render(view) {
    return <CalpokerMount view={view} />;
  },
};
```

See [`games/calpoker/ui/play.tsx`](games/calpoker/ui/play.tsx) for the full
presentation adapter.

The same component may render live and frozen state. Branch on `view.frozen`
before touching `port` or `appendGameLog`; the game-owned state still supplies
all cards, phases, and results in either branch. The host supplies the React key
that starts a new component lifecycle for a new hand.

The host passes accepted terms only to `createHand`; `restoreHand` and the
mounted hand never receive proposal, group, rejection, abandonment, connection,
or on-chain lifecycle objects.

These functions return React elements; they are not imperative drawing
callbacks. React may call them again when session state changes, then preserves
the existing component state and DOM where the element type and key are
unchanged. The host applies its `handKey` to the returned element, which
intentionally starts a fresh component lifecycle for each new hand. Game code
does not need to add a React key or manage this lifecycle itself.

`port.isChannelReady()` reports whether the underlying session has completed
the setup needed to accept game commands. It is a submission gate for effects
that may run while setup is still finishing, especially automatic actions. It
does not report whose turn it is, whether a particular move is legal, or whether
the command will apply synchronously; derive those facts from game-owned state.

Narrow the `GameMountView` on `frozen` before dispatching an intent. The
discriminant narrows directly during render. Inside delayed callbacks and
effects, where TypeScript cannot retain that narrowing, call
`requireLiveGameMount(viewRef.current)` immediately before using `port`; it
throws if a protocol action escapes into a frozen mount. The complete outgoing
contract is:

```ts
type GameIntent =
  | { type: 'state-changed' }
  | { type: 'make-move'; memberIndex: number; readable: Program | null }
  | { type: 'accept-settlement'; memberIndex: number }
  | { type: 'cheat'; memberIndex: number; moverShare: bigint };
```

- Mutate the concrete hand first. `state-changed` tells the player app to reread
  the entire hand and persist a local-only durable change; it works for both
  single- and multi-member hands.
- For an action that changes local state and invokes the protocol, perform both
  mutations before dispatching the protocol intent. The host temporarily retains
  the prior canonical hand and restores it if the synchronous command rejects or
  throws.
- If a durable local queue supplies that action, persist removal of the selected
  item with `state-changed` before mutating and dispatching the protocol action.
  Otherwise the action's rejection checkpoint still contains the selected item,
  so restore or synchronous rollback can submit it repeatedly.
- `make-move` asks the local CLVM handler to process `readable`. `null` means
  CLVM nil.
- `memberIndex` addresses the stable factory-ordered member. The host checks the
  index before mapping it to its private protocol ID.
- `accept-settlement` accepts that member's result.
- `cheat` deliberately invokes the diagnostic illegal-move path with a
  mojo-denominated `moverShare`. It is not a normal gameplay fallback. It is
  optional; among the reference games only Space Poker exposes it, including
  its game-local `cheat^` keyboard shortcut.

Use `accept-settlement` only when the game has already reached a local terminal
state and its rules call for voluntarily accepting that result instead of
making another move. Space Poker's fold path is the reference example. Update
the local terminal state before dispatch, just as for `make-move`.

Two helpers cover nearly every local UI transition. California Poker uses this
shape:

```ts
const viewRef = useRef(view);
viewRef.current = view;

const commitState = (reducer: (state: HandState) => HandState) => {
  const live = requireLiveGameMount(viewRef.current);
  live.hand.update(reducer);
  live.port.dispatch({ type: 'state-changed' });
};

const commitMove = (
  reducer: (state: HandState) => HandState,
  readable: Program | null,
) => {
  const live = requireLiveGameMount(viewRef.current);
  live.hand.update(reducer);
  live.port.dispatch({ type: 'make-move', memberIndex: 0, readable });
};
```

See
[`games/calpoker/ui/useCalpokerHand.ts`](games/calpoker/ui/useCalpokerHand.ts)
for these helpers around manual selections, nil moves, and automatic actions.

Use `commitState` for durable UI facts that do not invoke CLVM, such as card
selection or display order. Use `commitMove` for a protocol action. Mutating
first is required: the host keeps the previous canonical hand as a temporary
synchronous checkpoint and restores it if the command is rejected or throws.

Protocol calls remain Rust-first. After Rust accepts the request as queued or
already applied, the runtime rereads `getState()` and commits that complete
mutated hand canonically. The checkpoint exists only across the synchronous
call; it is not persisted. There is no `pendingCandidates` layer and
`LocalActionApplied` does not promote package state. The canonical hand and
Rust's serialized prepared-action queue are written in the same session
snapshot. The game does not observe whether later actuation involved potato
acquisition, on-chain progress, or protocol redo.

Synchronous `MoveRejected` and command exceptions restore the generic checkpoint
and go to shared host UX. Restoration replaces the hand through
`restoreHand(checkpoint)`; there is no shared mutation setter. Rejection is never
delivered to the game.

This is also the restart rule for automatic actions. After restoration, run the
same ordinary state-driven effect as during live play. A restored pre-action
state may issue the action; a command accepted into Rust's durable queue commits
the advanced handler/turn in the same atomic snapshot and must not issue again
after restore. Do not persist a separate
“automatic action attempted” flag. The player app waits for queued WASM events
to drain before assembling a background snapshot, so the serialized WASM state
and canonical accepted hand state cross the storage boundary together.

California Poker's opening automatic nil move follows this pattern:

```ts
const submittedRef = useRef<string | null>(null);

useEffect(() => {
  if (view.frozen || !state.isPlayerTurn || state.moveNumber !== 0n) return;
  const live = requireLiveGameMount(viewRef.current);
  if (!live.port.isChannelReady()) return;

  const key = `opening:${state.moveNumber}`;
  if (submittedRef.current === key) return;
  submittedRef.current = key;
  commitMove(
    (current) => ({ ...current, moveNumber: 1n, isPlayerTurn: false }),
    null,
  );
}, [view.frozen, state.isPlayerTurn, state.moveNumber, commitMove]);
```

The ref prevents duplicate effects within one React mount; durable correctness
comes from advancing `moveNumber` and turn state in the same canonical commit as
the accepted action. A restored pre-action snapshot still satisfies the effect
and retries. A snapshot taken after Rust durably queued or applied the command
contains the advanced state and does not.

After such a snapshot commits, rehydration must not run the gameplay transition
again. The only effects a committed restore may retry are delivery of a
persisted outbound message to the peer or resubmission of a recorded
transaction to the chain; both transports already deduplicate those retries. If
the latest durable snapshot is still pre-action, the ordinary state-driven
effect may compute the action again because that transition never committed.
That is completion from the last durable state, not replay of committed
gameplay.

The complete incoming contract is:

```ts
interface GameHandInitialization {
  parameters: ProposalParameterValue;
  members: readonly {
    playerAContribution: bigint;
    playerBContribution: bigint;
    ourTurn: boolean;
  }[];
}

type GameUpdate =
  | {
      type: 'move-readable';
      memberIndex: number;
      readable: Program;
      moverShare: bigint;
    }
  | { type: 'message-readable'; memberIndex: number; readable: Program }
  | { type: 'hand-ended'; memberIndex: number; outcome: SettlementOutcome | null };
```

`GameHandInitialization` is supplied only to `createHand`. `members` is the
authoritative ordered package membership, and `parameters` is the exact
Rust-approved opaque proposal value. A typical equal-stake single-member game
asserts that
`members[0].playerAContribution === members[0].playerBContribution`, then stores
that contribution and `members[0].ourTurn`. Assert your expected member count,
contribution topology, and decoded parameters in `createHand`.
- `move-readable` addresses one member of the hand. `readable` is the
  deserialized CLVM readable returned by the opponent-move handler.
  `moverShare` is a mojo-denominated `bigint`.
- `message-readable` carries advisory readable data for one member. It
  does not itself imply a move, turn change, or protocol-state transition.
- `hand-ended` supplies the normalized settlement outcome, when one exists, for
  one member. Multi-member hands receive independent terminal inputs as their
  members finish. Set that member's turn false and retain the outcome in the
  complete state so a frozen mount renders without host terminal maps.

Readables are CLVM values, unlike structured Bencodex proposal parameters.
Rust serializes them as bytes across the WASM boundary; the host parses those
bytes once and gives packages a `Program` in both incoming updates and outgoing
move intents. This deliberately reflects the current CLVM handler engine and
avoids making each package repeat `Program.deserialize`.

`Uint8Array` is JavaScript's byte-oriented typed array and is used for that
serialized boundary representation; it is not an ordinary `number[]`.
`bigint` represents one decoded integer, not a binary buffer. Inside a
`Program`, list structure remains explicit, atoms expose their bytes through
`.atom`, and an atom defined as an integer by the handler contract can be read
with `.toBigInt()`.

Rust has already validated handler output before the package receives it.
Inspect the exact trusted shape your handlers return:

```ts
const items = update.readable.toList();
const count = items[0].toBigInt();
const label = new TextDecoder().decode(items[1].atom);
```

For an outgoing move, construct the handler's documented CLVM input directly:

```ts
const readable = Program.fromList([
  Program.fromBigInt(count),
  Program.fromBytes(new TextEncoder().encode(label)),
]);
port.dispatch({ type: 'make-move', memberIndex: 0, readable });
```

CLVM atoms do not retain a text-versus-bytes distinction. Use UTF-8 decoding
only for fields your handler contract defines as text. Malformed serialization
fails at the host boundary. Packages must not substitute defaults or silently
ignore an unknown move-readable shape; such a mismatch is an internal contract
bug and must reach the player app's general error handling. Explicit shape
assertions are useful only to make that invariant failure clearer.

The terminal outcome vocabulary is:

```ts
type SettlementOutcome =
  | 'accept_settlement'
  | 'settled_cleanly'
  | 'opponent_timed_out'
  | 'forfeited_skipped_reveal'
  | 'lost'
  | 'forfeited_we_accepted'
  | 'we_accepted'
  | 'attempt_to_move_failed'
  | 'timed_out_waiting_for_our_move'
  | 'slashed_opponent'
  | 'opponent_slashed_us'
  | 'opponent_cheated';

```

The player app separately owns reward coin IDs, normalized reward amounts,
terminal labels, cancellation/error classification, and abnormal-termination
overlays. Games receive none of those bookkeeping fields.

These inputs update the machine-owned hand model before React renders. There is
no event observable or local echo. Protocol turn, timeout, replay, spending,
freezing, proposal lifecycle, removal, abandonment, transport, persistence,
and shared error reporting remain host-owned.

`games/host` contains shared protocol vocabulary, not shared game
presentation. Each package owns its controls, amount formatting, settlement
labels, and keyboard shortcuts. `appendGameLog` is the narrow exception: it is
an explicit live-mount callback into the player app's persisted hand history.

## Import boundaries

Game UI code and game tests may import:

- `games/host`, usually through `../../host`
- Other files inside the same game package
- `react` and `clvm-lib`

They must not import from `front-end/` or use the frontend `@/` alias. This
keeps a game portable and prevents circular dependencies. The isolation test
in
[`game_package_isolation.test.ts`](front-end/src/lib/tests/game_package_isolation.test.ts)
enforces this rule.

The following are frontend implementation details, not APIs for games:

- Raw WASM payload types such as `GameStatus`, `LocalActionApplied`,
  `ActionFailed`, and `ProposalMade`
- The session model, `useGameSession`, and the catalog-to-protocol-ID mapping

## Testing checklist

After adding or changing package files, run `./cb.sh` first. It compiles
Chialisp, prepares factory binaries, regenerates Rust-side package artifacts,
and builds the Rust project in the required order. Then run `./ct.sh` for the
full Rust, frontend, and simulator-backed test suite. The frontend test/build
step runs `generate:games`, which regenerates
`front-end/src/generated/gamePackages.ts` from `games/registry.json`. Do not
invoke individual Cargo test commands in place of these repository scripts.

Place frontend package tests beside the game under
`games/<key>/ui/**/*.{test,spec}.{ts,tsx}`. The frontend Jest configuration
discovers that directory automatically. Test the package boundary with a fake
`LiveGamePort`: construct a live `GameMountView`, assert emitted
`memberIndex`/`readable` values, feed `GameUpdate` values to `receive`, and
render the same hand through a frozen view with no port. California Poker's
[`calPoker.test.ts`](games/calpoker/ui/calPoker.test.ts) demonstrates local
state persistence, automatic nil moves, rejection propagation, restoration,
and terminal projection.

The minimum useful test layers are:

1. **Factory:** valid terms produce the expected ordered 10-field records;
   malformed parameters and contribution rules fail.
2. **Handlers:** each legal local move returns the intended move, validator
   chain, next handler, and readable; invalid local UI input rejects.
3. **Validators/referee:** legal moves survive invalid slash attempts and each
   illegal peer move is slashable with the intended evidence.
4. **Package state:** `createHand`, `receive`, `getState`, and `restoreHand`
   preserve the complete game-owned state.
5. **Mount/actions:** live actions mutate then dispatch, automatic actions fire
   only from the required durable phase, and frozen mounts cannot dispatch.

Before considering the game complete, check that:

- The factory returns the expected game records for valid parameters.
- Invalid factory parameters and invalid moves are rejected.
- Both players derive the same initial game.
- Handler and validator tests, in Rust or the package's external harness, cover
  each legal move and important illegal moves.
- The proposal form converts to and from `HandProposal` correctly.
- The package-owned `forwardRef` form exposes `getProposal()`, validates its
  transient controls, and returns sender/receiver contributions plus typed
  parameters; transient form state is seeded on mount and is not persisted.
- Factory parameter encoding and decoding round-trip with exact
  text/bytes/integer typing.
- A fresh `GameHand` initializes from accepted terms and `restoreHand` constructs
  directly from only its generic saved state.
- Opaque saved state, including `Uint8Array`, round-trips without JSON/base64
  conversion and contains no protocol IDs.
- `GameHand.receive` handles move, message, and terminal updates in order, and
  `getState` returns the latest complete hand state.
- Invalid member indices and unknown inbound protocol IDs fail at the host
  boundary; package code never receives an ID.
- Automatic actions are ordinary state-driven effects: a restored pre-action
  state may fire once, while restored queued/applied state must not refire.
- Every reload checkpoint test must drive the restored session beyond that
  checkpoint. Equality immediately after restore proves serialization only;
  post-restore protocol progress proves the state is actually resumable.
- Every outgoing intent is tested for accepted, rejected, and unexpected-failure
  behavior.
- Live and frozen branches of the single mount render the expected game state,
  and the frozen branch cannot dispatch.
- The full project test suite passes through `./ct.sh`.

For detailed handler and validator examples, see
[`HANDLER_GUIDE.md` — Worked Examples](HANDLER_GUIDE.md#worked-examples-reference-games).
