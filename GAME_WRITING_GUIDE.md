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
the detailed CLVM function signatures, use
[`clsp/handler_api.md`](clsp/handler_api.md).

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
    serialize.ts          # Saved UI state and state transitions
    play.tsx              # Live and finished-hand React views
    styles.css            # Optional game-specific styles
```

The frontend catalog is generated, so do not create `ui/index.ts`. Each UI
file has a conventional export that the generator discovers:

- `handProposal.ts` has a default export containing the game registration.
- `handProposalForm.tsx` exports `HandProposalForm`.
- `play.tsx` exports `play`.

The generator passes those three exports through the frontend-owned
`defineGamePackage`. This is the compile-time boundary that proves the proposal
draft, complete hand state, concrete hand type, factory parameters, form, and
mount belong to one coherent package. The generated keyed registry then exposes
a frontend-only erased runtime facade.

## Step 1: Register the game

Add the key to [`games/registry.json`](games/registry.json):

- Use the `production` list for a playable game with a UI.
- Use the `test` list for a game that exists only in automated tests.

That is the only catalog you edit by hand. The build generates frontend imports
and the factory preset list for every production package. When `rust/mod.rs` or
`rust/tests/mod.rs` exists, it also generates the corresponding Rust module or
internal test-suite aggregation.

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

The result is a nonempty proper list. Every member is a proper list with exactly
these 10 fields:

```clojure
(player_a_contribution player_b_contribution player_a_goes_first initial_move
 initial_max_move_size initial_state initial_mover_share my_turn_handler
 their_turn_handler initial_validator)
```

`player_a_goes_first` is canonical nil or `1`. The two handlers have a stable
meaning and order: `my_turn_handler` is run by whichever player goes first;
`their_turn_handler` is run by the waiting player. Member order is factory
order and never flips between peers.

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

A handler can reject a local action with an error tag and message. The UI
receives that as `MoveRejected`. A validator returning no valid result means
the move is invalid and can be used as evidence in an on-chain dispute.

Read [`HANDLER_GUIDE.md`](HANDLER_GUIDE.md) for an explanation and worked
examples. Use [`clsp/handler_api.md`](clsp/handler_api.md) for exact argument
and return shapes. [`CLVM_DOS.md`](CLVM_DOS.md) covers cost and size limits.

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
  { disabled, maxPerHandMojos, defaultContribution, onSubmit },
  ref,
) {
  const [amount, setAmount] = useState(defaultContribution);
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
  initialProposal: HandProposal | null;
  onSubmit: () => void;
}
```

- `disabled` is true after submission while the host is preventing another
  proposal. Disable every editable control and submit action when it is true.
- `maxPerHandMojos` is the largest currently available contribution per player,
  in mojos. `null` means the host cannot provide a balance-derived limit; it
  does not make an otherwise invalid draft valid.
- `defaultContribution` seeds a fresh mounted form. `initialProposal` may seed a
  counter/retry form; decode it only with the package codec.
- `onSubmit()` asks the host to call the active handle. `getProposal()` returns
  either `{ ok: true, senderContribution, receiverContribution, parameters }`
  or `{ ok: false, error }`. The form displays its own validation error.

The host owns the game selector and `gameTimeout`; they are deliberately absent
from this interface. The game form owns only game-specific draft fields. A form
must not send a proposal or call protocol APIs itself.

The game also owns its form controls, amount-unit choices, formatting, and
validation copy. Amounts cross the package boundary as absolute mojo `bigint`
values. There is deliberately no shared game UI component or currency-formatting
service: reference games may duplicate small controls so their presentation
implementations remain independent.

Implement the package registration in `handProposal.ts`. It provides the one
typed parameter codec, `describeHandProposal`, and `handProposalsEqual`.
`describeHandProposal` decodes `handProposal.parameters` through that codec and
must fail if the player app cannot project the Rust-approved value.

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
  handProposal: HandProposal;
  members: readonly { amount: bigint; ourTurn: boolean }[];
}
```

The initial state must copy every accepted fact the play UI needs: stakes and
game-specific proposal terms from `handProposal`, plus member amounts and local
initial turns from `members`. Assert the expected member count and game type.
Protocol IDs, proposal origin, and session `iStarted` are deliberately
inaccessible to packages.

Multi-member games keep members in this stable factory order. Krunk stores
`members: readonly [KrunkGameState, KrunkGameState]`; index 0 and index 1 remain
the factory's two members for the hand's lifetime and settle independently.
Single-member games use index 0. The host treats `getState()` as opaque
Bencodex-compatible data and saves `{ gameType, state }` generically. Game-owned
persisted state stores member order/indices, not protocol IDs.
Games do not provide envelope serializers, versions, compatibility decoders, or
migrations.

Every playable package must support a frozen mount and `restoreHand`. A finished
session always attempts a cold read-only remount when a valid
`PersistedGameState` exists.

Proposal snapshots persist the exact opaque `parameters` value and all generic
A/B terms. Do not add game-specific proposal save keys or a second persistence
codec. Hand state remains saved generically from `GameHand.getState()`.

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
termination text remains in the player-app overlay rather than crossing this
boundary.

```ts
type GameMountView = {
  hand: ConcretePackageHand;
  handOrigin: 'fresh' | 'restored' | 'terminal';
  myName?: string;
  opponentName?: string;
} & (
  | { frozen: false; port: LiveGamePort; appendGameLog(line: string): void }
  | { frozen: true }
);
```

The host passes accepted terms only to `createHand`; `restoreHand` and the
mounted hand never receive proposal, group, rejection, abandonment, connection,
or on-chain lifecycle objects.

These functions return React elements; they are not imperative drawing
callbacks. React may call them again when session state changes, then preserves
the existing component state and DOM where the element type and key are
unchanged. The host applies its `handKey` to the returned element, which
intentionally starts a fresh component lifecycle for each new hand. Game code
does not need to add a React key or manage this lifecycle itself.

Narrow the `GameMountView` on `frozen` before dispatching an intent. The
complete outgoing contract is:

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
- `make-move` asks the local CLVM handler to process `readable`. `null` means
  CLVM nil.
- `memberIndex` addresses the stable factory-ordered member. The host checks the
  index before mapping it to its private protocol ID.
- `accept-settlement` accepts that member's result.
- `cheat` deliberately invokes the diagnostic illegal-move path with a
  mojo-denominated `moverShare`. It is not a normal gameplay fallback. It is
  optional; among the reference games only Space Poker exposes it, including
  its game-local `cheat^` keyboard shortcut.

Protocol calls remain Rust-first. After Rust accepts or queues the request, the
runtime rereads `getState()` as the complete candidate. An immediately applied
candidate becomes canonical. A queued candidate is persisted beside the
unchanged canonical checkpoint until Rust reports application. The game does
not observe whether this delay involved potato acquisition, on-chain progress,
or protocol redo.

Move rejection and unexpected `ActionFailed` restore the generic checkpoint and
go to shared host UX. Synchronous command rejection and cleanup do the same.
Restoration replaces the hand through `restoreHand(checkpoint)`; there is no
shared mutation setter. Rejection is never delivered to the game.

This is also the restart rule for automatic actions. After restoration, run the
same ordinary state-driven effect as during live play. A restored pre-action
state may issue the action; a restored queued or applied candidate already
contains the advanced handler/turn and must not. Do not persist a separate
“automatic action attempted” flag.

The complete incoming contract is:

```ts
interface GameHandInitialization {
  handProposal: HandProposal;
  members: readonly { amount: bigint; ourTurn: boolean }[];
}

type GameUpdate =
  | {
      type: 'move-readable';
      memberIndex: number;
      readable: Uint8Array;
      moverShare: string;
    }
  | { type: 'message-readable'; memberIndex: number; readable: Uint8Array }
  | { type: 'hand-ended'; memberIndex: number; outcome: SettlementOutcome | null };
```

`GameHandInitialization` is supplied only to `createHand`. `members` is the
authoritative ordered package membership and `handProposal` contains validated
accepted terms. A typical single-member initialization reads `members[0].amount`
and `members[0].ourTurn`. Assert your expected member count and proposal game
type in `createHand`.
- `move-readable` addresses one member of the hand. `readable` is the
  serialized CLVM readable returned by the opponent-move handler.
  `moverShare` is a decimal mojo string because it originated at the WASM
  boundary.
- `message-readable` carries serialized advisory readable data for one member. It
  does not itself imply a move, turn change, or protocol-state transition.
- `hand-ended` supplies the normalized settlement outcome, when one exists, for
  one member. Multi-member hands receive independent terminal inputs as their
  members finish. Set that member's turn false and retain the outcome in the
  complete state so a frozen mount renders without host terminal maps.

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

Before considering the game complete, check that:

- The factory returns the expected game records for valid parameters.
- Invalid factory parameters and invalid moves are rejected.
- Both players derive the same initial game.
- Handler and validator tests, in Rust or the package's external harness, cover
  each legal move and important illegal moves.
- The proposal form converts to and from `HandProposal` correctly.
- The package-owned `forwardRef` form exposes `getProposal()`, validates its
  transient controls, and returns sender/receiver contributions plus typed
  parameters; transient form state is not persisted.
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
- Every outgoing intent is tested for accepted, rejected, and unexpected-failure
  behavior.
- Live and frozen branches of the single mount render the expected game state,
  and the frozen branch cannot dispatch.
- The full project test suite passes through `./ct.sh`.

For detailed handler and validator examples, see
[`HANDLER_GUIDE.md` — Worked Examples](HANDLER_GUIDE.md#worked-examples-reference-games).
