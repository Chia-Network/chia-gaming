# How to Add a Game

This guide explains the pieces you need to add a game and how they fit
together. Start with the package layout and the step-by-step checklist. The API
reference near the end is useful when you are implementing each file.

A game has three main parts:

1. **CLVM rules** define valid moves and protect both players if a dispute goes
   on-chain.
2. **A small Rust module** loads the compiled CLVM into the game engine.
3. **A TypeScript/React UI** lets players propose a hand, play it, and restore
   it after a refresh.

You do not need to understand every part of the player application. Game code
uses the public interfaces in [`games/host/index.ts`](games/host/index.ts) and
[`games/host/ui.tsx`](games/host/ui.tsx). Keep your game behind those
interfaces so it remains independent of this particular frontend.

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
    onchain/              # Checks moves during an on-chain dispute
    *_generate.clinc      # Handles moves while the game is off-chain
  rust/
    mod.rs                # Loads the compiled factory for the Rust engine
    tests/                # CLVM, handler, validator, and simulator tests
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

## Step 1: Register the game

Add the key to [`games/registry.json`](games/registry.json):

- Use the `production` list for a playable game with a UI.
- Use the `test` list for a game that exists only in automated tests.

That is the only catalog you edit by hand. The build generates the Rust
registration, frontend imports, test aggregation, and factory preset list.

Two identifiers appear in the code:

- The **catalog key** is the readable name from `registry.json`. The frontend
  uses it in saves and when choosing a UI package.
- The **protocol ID** is the first generated game's initial validation puzzle
  hash (`initial_validation_program_hash`). Peers use that puzzle hash to
  identify the game on the wire. It is not a hash of the factory code.

Normally your game code only deals with the catalog key. The host converts
between the key and protocol ID at the WASM boundary.

## Step 2: Implement the CLVM rules

The factory receives the parameters for a proposed hand and returns the game
or games that the peers will run. It must be deterministic: both peers run the
same factory with the same parameters and must get the same result.

Most factories create one game. A factory may create several games that must
be accepted or cancelled together; the code calls these an atomic group.
Krunk is the reference example for that case.

Each game returned by the factory includes its starting state, move handlers,
and validation programs. See
[the factory return format](clsp/handler_api.md#game-factory) for the exact
fields.

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

## Step 3: Add the Rust loader

The Rust engine cannot execute a `.clsp` source file directly. Implement
`games/<key>/rust/mod.rs` so it can load the compiled factory:

- `prepared_factory(allocator)` returns the factory used for real proposals.
- `probe_parameters(allocator)` returns one representative, valid parameter
  value. During registration, the engine runs the factory with those parameters
  and reads the first returned game's initial validation puzzle hash. That is
  the protocol ID; the factory itself is never hashed as an identifier.

For most games, this module only loads compiled hex. It should not duplicate
the game rules; those remain in CLVM. Krunk is an unusual example because its
loader also supplies a compiled dictionary tree.

Add handler and validator tests under `games/<key>/rust/tests/`. Use
[`SIMULATOR_TESTING.md`](SIMULATOR_TESTING.md) when a test needs the blockchain
simulator.

## Step 4: Define how a hand is proposed

The proposal flow has three representations:

```text
editable form draft → HandProposal → CLVM factory parameters
```

Keeping these representations separate makes each boundary clear:

- The **draft** is temporary form state. It may be incomplete or invalid while
  the player is typing.
- A **`HandProposal`** is a complete, validated offer sent to the other player.
  Every proposal includes `gameType`, both players' contributions, and a
  timeout. A game can add fields of its own.
- **Factory parameters** are the CLVM value passed to the game factory.

Implement the React form in `handProposalForm.tsx`. It receives the current
draft, an `onChange` callback, and an `onSubmit` callback through
`HandProposalFormProps`. Export it as:

```ts
export function HandProposalForm(props: HandProposalFormProps<MyDraft>) {
  // ...
}
```

### Proposal form API

The complete package-facing form contract is:

```ts
interface HandProposalFormProps<TDraft> {
  draft: TDraft;
  disabled: boolean;
  maxPerHandMojos: bigint | null;
  onChange: (update: Partial<TDraft>) => void;
  onSubmit: () => void;
}
```

- `draft` is the current game-specific draft. Treat it as immutable.
- `disabled` is true after submission while the host is preventing another
  proposal. Disable every editable control and submit action when it is true.
- `maxPerHandMojos` is the largest currently available contribution per player,
  in mojos. `null` means the host cannot provide a balance-derived limit; it
  does not make an otherwise invalid draft valid.
- `onChange(update)` sends a partial draft update to the host. The host passes
  the current draft and this update to `draft.update`; the form must not assume
  that a shallow merge is sufficient.
- `onSubmit()` asks the host to submit. The host calls `draft.toHandProposal`,
  validates the result and the balance limit again, and does nothing if those
  checks fail. The form may use normal form submission or call this callback
  from its submit button.

The host owns the game selector and `gameTimeout`; they are deliberately absent
from this interface. The game form owns only game-specific draft fields. A form
must not send a proposal or call protocol APIs itself.

Implement the conversion and validation in `handProposal.ts`. Its registration
must provide:

- `draft.default` to create an initial form value.
- `draft.update` to apply a form change.
- `draft.toHandProposal` to produce a valid proposal, or `null` if the draft is
  not ready to submit.
- `draft.fromHandProposal` to repopulate the form from an existing proposal.
- `validateHandProposal` to validate a complete proposal.
- `handProposalsEqual` to compare two proposals.
- `describeHandProposal` to write a short, readable summary for the receiving
  player.
- `lifecycle.proposalSenderGoesFirst` to say which player takes the first turn.

Use `equalHandProposalBase` when your equality check only needs to add
game-specific fields to the common proposal comparison.

The same registration translates between a `HandProposal` and CLVM:

- `toFactoryParameters(handProposal, iStarted)` creates the typed parameter
  object for an outgoing proposal.
- `factoryParameters.encode` converts that object into a CLVM program.
- `factoryParameters.decode` safely parses an untrusted CLVM program.
- `decodeHandProposal(base, params)` reconstructs and validates the proposal
  received from the peer.

The host provides `readClvmProgram`, `readClvmAtom`, `readClvmFlag`, and
`readClvmList` to help write strict decoders.

### Proposal and factory-parameter decoder API

Common proposal terms are always supplied separately from the game factory
parameters:

```ts
interface HandProposalBase {
  myContribution: bigint;
  theirContribution: bigint;
  gameTimeout: bigint;
}

type HandProposal = HandProposalBase & {
  gameType: string;
  // A package may add validated game-specific fields.
};

interface FactoryParameterCodec<TParams> {
  decode(value: unknown): TParams | null;
  encode(params: TParams): Program;
}

interface ProposalCodec<TParams> {
  factoryParameters: FactoryParameterCodec<TParams>;
  toFactoryParameters(handProposal: HandProposal, iStarted: boolean): TParams;
  decodeHandProposal(base: HandProposalBase, params: TParams): HandProposal | null;
}
```

`toFactoryParameters` receives validated proposal terms and whether this client
started the session. It returns the typed game-specific value consumed by
`factoryParameters.encode`. `encode` returns the CLVM `Program` passed to the
factory; the host handles serialization.

Decoding is intentionally two-stage:

1. `factoryParameters.decode(value)` receives untrusted data, normally
   serialized CLVM bytes. It must validate the complete CLVM shape and every
   value, returning typed parameters or `null`. Malformed peer data is expected
   at this boundary and must not throw.
2. `decodeHandProposal(base, params)` combines the already-decoded common terms
   with the typed parameters. It must reject contradictions between duplicated
   values, add the package's `gameType` and game-specific proposal fields, run
   the complete proposal validation, and return `null` on any mismatch.

The host verifies that a non-null proposal has the registration's catalog
`gameType`. Do not trust a type assertion or silently repair inconsistent peer
data.

The strict CLVM readers have these exact contracts:

```ts
readClvmProgram(value: unknown): Program | null;
readClvmAtom(program: Program): bigint | null;
readClvmFlag(program: Program): boolean | null;
readClvmList(program: Program, length: number): readonly Program[] | null;
```

- `readClvmProgram` accepts only a `Uint8Array` containing one deserializable
  program.
- `readClvmAtom` accepts only a value convertible to a CLVM integer.
- `readClvmFlag` accepts exactly integer `0` or `1`.
- `readClvmList` accepts a proper list with exactly `length` members.

These helpers validate representation, not game rules. The decoder must still
check positivity, ranges, cross-field relationships, and consistency with
`HandProposalBase`. Test a valid encode/decode round trip, malformed bytes,
wrong list lengths and shapes, invalid values, and another game's parameter
encoding.

## Step 5: Save and update the UI state

The protocol state in Rust is not enough to restore every detail of a React
UI. For example, a card game may need to save revealed cards or the currently
selected cards. Define that game-owned UI state in `serialize.ts`.

Create `stateCodec` with `defineGameStateCodec`. The codec:

- Identifies the state with your catalog key and a version.
- Checks unknown data with `isState`.
- Encodes and decodes `PersistedGameState`.
- Lists the game IDs represented by the state.
- Says whether a finished hand can be shown again after a refresh with
  `canRemountFinished`.

Do not accept malformed saved data by casting it. `decode` is a trust boundary,
so `isState` must verify every field your UI relies on.

Also implement the three `durableState` operations:

- `initialize` creates one keyed hand from the normalized `hand-started` input.
- `reduceInput` applies `opponent-moved`, `game-message`, `move-rejected`, and
  `hand-ended`.
- `applyFeatureState` places an accepted local feature state into the hand
  envelope. This matters for a multi-ID package such as Krunk.

Keep the reducer pure. Given the same current state and event, it must return
the same next state.

If your `HandProposal` has extra fields, implement
`persistence.encodeExtras` and `persistence.decodeExtras` in
`handProposal.ts`. This saves the proposal itself; `stateCodec` saves the
in-progress or finished UI state.

## Step 6: Build the play UI

Implement `play.tsx` and export a `GameMountRegistration` named `play`. It has
one `render(view)` function. Every render receives the current decoded-state
envelope, ordered and active IDs, accepted amounts, terminal results, names, and
`frozen`.

`frozen` is the type discriminant:

- `frozen: false` includes the typed intent port.
- `frozen: true` has no protocol capability.

The host applies proposal terms through `durableState.initialize`; the mounted
hand never receives proposal, group, abandonment, connection, or on-chain
lifecycle objects.

These functions return React elements; they are not imperative drawing
callbacks. React may call them again when session state changes, then preserves
the existing component state and DOM where the element type and key are
unchanged. The host applies its `handKey` to the returned element, which
intentionally starts a fresh component lifecycle for each new hand. Game code
does not need to add a React key or manage this lifecycle itself.

Use `requireLiveGameHandSource` before dispatching an intent. The complete
outgoing contract is:

```ts
type GameIntent<TState> =
  | { type: 'update-local-state'; state: TState }
  | { type: 'make-move'; gameId: string; readable: Program | null; state: TState }
  | { type: 'accept-settlement'; gameId: string; state: TState }
  | { type: 'cheat'; gameId: string; moverShare: bigint; state: TState };
```

- `update-local-state` persists game-owned UI state without a protocol command.
  It is currently available only to a single-ID hand; multi-ID packages update
  a member through a protocol intent.
- `make-move` asks the local CLVM handler to process `readable`. `null` means
  CLVM nil. `state` is the candidate game-owned feature state for `gameId`.
- `accept-settlement` accepts the result for `gameId` and carries the candidate
  feature state to persist on acceptance.
- `cheat` deliberately invokes the diagnostic illegal-move path with a
  mojo-denominated `moverShare` and candidate feature state. It is not a normal
  gameplay fallback.

The host keeps command execution and candidate state atomic. If Rust applies the
action immediately, the candidate commits immediately. If Rust queues it, the
host persists the candidate separately from canonical `handState` and projects
it for live rendering until Rust reports that the action was applied. The game
does not observe whether this delay involved potato acquisition, on-chain
progress, or protocol redo.

`move-rejected` discards the pending projection without committing it.
Unexpected `ActionFailed` errors discard the pending candidate and go to shared
host error UX. For an applied intent, the host commits `state` through
`durableState.applyFeatureState(currentHand, gameId, state)`. Therefore `state`
is the state of the addressed game feature; it is the whole hand only when the
package's hand and feature state are the same type.

The complete incoming contract is:

```ts
type ProposalGroupOrigin = 'local' | 'peer';

interface GameHandInitialization {
  id: string;
  gameIds: readonly string[];
  iStarted: boolean;
  canAct: boolean;
  origin: ProposalGroupOrigin;
  handProposal: HandProposal;
}

type GameInput<TInit = GameHandInitialization> =
  | { type: 'hand-started'; init: TInit }
  | {
      type: 'opponent-moved';
      gameId: string;
      readable: Uint8Array;
      moverShare: string;
    }
  | { type: 'game-message'; gameId: string; readable: Uint8Array }
  | { type: 'move-rejected'; gameId: string; tag: string; message: string }
  | { type: 'hand-ended'; gameId: string; terminal: GameTerminalModel };
```

- `hand-started` initializes or extends one accepted hand. `init.id` is the game
  ID whose acceptance triggered this input; `gameIds` is the authoritative
  ordered membership and may contain more than one ID. A multi-ID group can
  receive this input as its member acceptances arrive, so `initialize(current,
input)` must preserve already-initialized member state. `iStarted` identifies
  the local session initiator, `canAct` is the initial local action capability,
  `origin` says whether the accepted proposal was local or peer-authored, and
  `handProposal` contains the validated accepted terms. These are normalized
  initialization facts, not proposal-lifecycle events.
- `opponent-moved` addresses one member of the hand. `readable` is the
  serialized CLVM readable returned by the opponent-move handler.
  `moverShare` is a decimal mojo string because it originated at the WASM
  boundary.
- `game-message` carries serialized advisory readable data for one member. It
  does not itself imply a move, turn change, or protocol-state transition.
- `move-rejected` reports an expected local-handler rejection for one member.
  `tag` is the game-defined machine-readable category and `message` is its
  displayable explanation. The candidate state from the rejected intent was not
  committed. A game with expected validation feedback, such as Krunk, should
  present it as domain feedback. A game that considers rejection unreachable
  should still display the supplied error rather than silently ignoring it; it
  must not add retry or redo behavior.
- `hand-ended` supplies the normalized terminal model for one member. Multi-ID
  hands receive independent terminal inputs as their members finish.

The exact terminal payload is:

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

type GameTerminalType =
  | 'none'
  | 'settled'
  | 'insufficient-balance'
  | 'ended-cancelled'
  | 'game-error';

interface GameTerminalModel {
  type: GameTerminalType;
  outcome: SettlementOutcome | null;
  label: string | null;
  myReward: string | null;
  rewardCoinHex: string | null;
}
```

`outcome` is the normalized protocol settlement outcome when one exists.
`myReward` is a decimal mojo string, and `rewardCoinHex` is the reward coin ID
as hexadecimal. `label` is host-provided presentation text. A game should
branch on structured `type` and `outcome`, not parse `label`.

These inputs update the machine-owned hand model before React renders. There is
no event observable or local echo. Protocol turn, timeout, replay, spending,
freezing, proposal lifecycle, removal, abandonment, transport, persistence,
and shared error reporting remain host-owned.

The host also provides shared UI helpers through `games/host`, including
`AmountInput`, `useGameHost`, amount formatting, settlement labels, and
`GameTerminalModel`.

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
- [`front-end/src/lib/gameProposalCodec.ts`](front-end/src/lib/gameProposalCodec.ts)
- The session model, `useGameSession`, and the catalog-to-protocol-ID mapping

## Testing checklist

Before considering the game complete, check that:

- The factory returns the expected game records for valid parameters.
- Invalid factory parameters and invalid moves are rejected.
- Both players derive the same initial game.
- Handler and validator tests cover each legal move and important illegal
  moves.
- The proposal form converts to and from `HandProposal` correctly.
- Factory parameter encoding and decoding round-trip.
- The state codec rejects malformed values and round-trips valid state.
- `durableState` handles every incoming input and validates every local state.
- Every outgoing intent is tested for accepted, rejected, and unexpected-failure
  behavior.
- Live and frozen branches of the single mount render the expected game state,
  and the frozen branch cannot dispatch.
- The full project test suite passes through `./ct.sh`.

For detailed handler and validator examples, see
[`HANDLER_GUIDE.md` — Worked Examples](HANDLER_GUIDE.md#worked-examples-reference-games).
