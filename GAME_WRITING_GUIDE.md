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
    factory_probe.clsp    # Returns one representative valid parameter value
    factory_args.clvm.bin # Optional generated curry arguments
    onchain/              # Checks moves during an on-chain dispute
    *_generate.clinc      # Handles moves while the game is off-chain
  rust/
    mod.rs                # Optional Rust helpers; no factory loading
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

The generator passes those three exports through `defineGamePackage`. This is
the compile-time boundary that proves the proposal draft, complete hand state,
factory parameters, form, and mount belong to one coherent package. The
generated keyed registry exposes a non-generic runtime facade; game-specific
types are not cast to a fictitious broad package type.

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

Starting-player policy belongs to each factory record, not necessarily to one
proposal-wide flag. Krunk emits two records with opposite
`sender_goes_first` values so each player picks a word once. If a future game
makes starting order a user-negotiated term, include it in that package's
normalized proposal, description, equality, and persistence. If it is derived
from session role, validate the encoded parameter against the supplied decode
context instead of displaying it as a term.

Each game returned by the factory includes its starting state, move handlers,
and validation programs. See
[the factory return format](clsp/handler_api.md#game-factory) for the exact
fields. Return each player's contribution separately; the host derives the
total amount. Return the initial validator program itself; the host derives its
tree hash and uses the first record's hash as the protocol game ID.

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

Add `games/<key>/clsp/factory_probe.clsp`, a no-argument Chialisp program
which returns one representative valid parameter value for `factory.clsp`.
For example, Calpoker's probe is:

```clojure
(include *standard-cl-23*)

(export () (list 1 1))
```

The build compiles both files, curries any `factory_args.clvm.bin` into the
factory, and runs the probe against that prepared factory. It records the first
returned game's initial validation puzzle hash as the protocol ID and emits one
prepared binary factory for runtime use. The factory itself is never hashed as
an identifier.

Factory loading, binary serialization, caching, and registration are player
implementation details. A game package does not implement Rust loader
functions. If a generated external data set must be curried into the factory,
write it as a proper list of arguments at
`games/<key>/clsp/factory_args.clvm.bin`; Krunk's signed dictionary generator
is the example. Probe programs and factory-argument files are build inputs;
the browser downloads neither of them.

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

The same registration translates between a `HandProposal` and structured
Bencodex proposal parameters:

- `toProposalParameters(handProposal, iStarted)` creates the typed parameter
  object for an outgoing proposal.
- `proposalParameters.encode` converts that object into Bencodex-compatible
  values.
- `proposalParameters.decode` safely validates untrusted Bencodex values.
- `decodeHandProposal(base, params, context)` reconstructs and validates the
  proposal received from the peer.

Game frontend code must not construct, deserialize, or inspect CLVM here. Rust
converts the structured values to CLVM immediately before invoking the factory.

### Proposal-parameter decoder API

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

interface HandProposalDecodeContext {
  origin: 'local' | 'peer';
  iStarted: boolean;
  expectedSenderGoesFirst: boolean;
}

interface ProposalCodec<TParams> {
  proposalParameters: ProposalParameterCodec<TParams>;
  toProposalParameters(handProposal: HandProposal, iStarted: boolean): TParams;
  decodeHandProposal(
    base: HandProposalBase,
    params: TParams,
    context: HandProposalDecodeContext,
  ): HandProposal | null;
}
```

`toProposalParameters` receives validated proposal terms and whether this client
started the session. It returns the typed game-specific value consumed by
`proposalParameters.encode`. `encode` returns only Bencodex-compatible values.
The host carries those values across WASM and the peer wire and performs the
generic conversion to the CLVM object passed to the factory.

Decoding is intentionally two-stage:

1. `proposalParameters.decode(value)` receives untrusted Bencodex values. It
   must validate the complete list/scalar shape and every value, returning typed
   parameters or `null`. Malformed peer data is expected at this boundary and
   must not throw.
2. `decodeHandProposal(base, params, context)` combines the already-decoded
   common terms with the typed parameters. It must reject contradictions
   between duplicated values, validate any proposer-relative policy represented
   by its parameters, add the package's `gameType` and game-specific proposal
   fields, run the complete proposal validation, and return `null` on any
   mismatch.

The host verifies that a non-null proposal has the registration's catalog
`gameType`. Do not trust a type assertion or silently repair inconsistent peer
data. Incoming `ProposalMade` notifications must contain an explicit positive
timeout and explicit `parameters`; missing fields are decode failures.

For example, Calpoker encodes `[perPlayerStake, senderGoesFirst]`, Space Poker
encodes `[perPlayerStake, betUnit, senderGoesFirst]`, and Krunk encodes its stake
as a single `bigint`. Their decoders check exact list lengths, JavaScript value
types, positivity, cross-field relationships, and consistency with
`HandProposalBase`. Test a valid encode/decode round trip, wrong list lengths
and types, invalid values, and another game's parameter encoding.

## Step 5: Own one hand instance

The protocol state in Rust is not enough to restore every detail of a React UI.
For example, a card game may need revealed cards and current selections. Define
one complete game-owned state type and implement `createHand(init)`. The host
calls it once for each accepted hand.

The returned `GameHand<TState>` exposes `receive(update)` and `getState()`.
`setInitialState(state)` and `installState(state)` are host-only restoration and
optimistic-state operations. `createGameHand(initialState, reducer)` supplies
this small mutable shell around a pure reducer.

The initial state must copy every accepted fact the play UI needs from
`GameHandInitialization`: ordered routing IDs, stakes and game-specific proposal
terms, local role, and the initial game turn. Derive the initial turn from the
validated proposal convention plus `origin` and `iStarted`; the host does not
pass a second `canAct` answer.

Multi-ID games keep all members in the one complete state; Krunk, for example,
stores ordered `gameIds`, the accepted per-player stake, and
`games: Record<string, KrunkGameState>`. Single-ID games likewise keep their
routing ID and accepted terms in state. The host treats `getState()` as opaque
Bencodex-compatible data and saves `{ gameType, state }` generically.
Games do not provide state serializers, versions, validators, restore decoders,
or migrations.

Set package-level `canRemountFinished` when the same hand UI can be mounted
read-only from a terminal save.

If your `HandProposal` has extra fields, implement
`persistence.encodeExtras` and `persistence.decodeExtras` in
`handProposal.ts`. This saves the proposal itself; hand state is saved
generically from `GameHand.getState()`.

## Step 6: Build the play UI

Implement `play.tsx` and export a `GameMountRegistration` named `play`. It has
one `render(view)` function. Every render receives the live or restored
`GameHand`, player display names, and `frozen`. IDs, accepted stakes, current
turn/handler, active members, and terminal results come from the complete hand
state rather than parallel host projections.

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
  hand: GameHandState<unknown>;
  handOrigin: 'fresh' | 'restored' | 'terminal';
  myName?: string;
  opponentName?: string;
} & (
  | { frozen: false; port: LiveGamePort; appendGameLog(line: string): void }
  | { frozen: true }
);
```

The host passes accepted terms to `createHand`; the mounted hand never receives
proposal, group, rejection, abandonment, connection, or on-chain lifecycle
objects.

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
  CLVM nil. `state` is the complete candidate hand state.
- `accept-settlement` accepts the result for `gameId` and carries the candidate
  complete hand state to persist on acceptance.
- `cheat` deliberately invokes the diagnostic illegal-move path with a
  mojo-denominated `moverShare` and complete candidate state. It is not a normal
  gameplay fallback.

The host keeps command execution and candidate state atomic. If Rust applies the
action immediately, the candidate commits immediately. If Rust queues it, the
host checkpoints the prior state, installs the complete candidate in the live
hand, and persists both until Rust reports that the action was applied. The game
does not observe whether this delay involved potato acquisition, on-chain
progress, or protocol redo.

Move rejection and unexpected `ActionFailed` restore the generic checkpoint and
go to shared host UX. Rejection is never delivered to the game. On confirmation
the installed candidate becomes canonical.

This is also the restart rule for automatic actions. After restoration, run the
same ordinary state-driven effect as during live play. A restored pre-action
state may issue the action; a restored queued or applied candidate already
contains the advanced handler/turn and must not. Do not persist a separate
“automatic action attempted” flag.

The complete incoming contract is:

```ts
type ProposalGroupOrigin = 'local' | 'peer';

interface GameHandInitialization {
  gameIds: readonly string[];
  iStarted: boolean;
  origin: ProposalGroupOrigin;
  handProposal: HandProposal;
}

type GameUpdate =
  | {
      type: 'move-readable';
      gameId: string;
      readable: Uint8Array;
      moverShare: string;
    }
  | { type: 'message-readable'; gameId: string; readable: Uint8Array }
  | { type: 'hand-ended'; gameId: string; outcome: SettlementOutcome | null };
```

`GameHandInitialization` is supplied once to `createHand`. `gameIds` is the
authoritative ordered membership, `iStarted` identifies the local session
initiator, `origin` identifies the proposal author, and `handProposal` contains
validated accepted terms. A typical single-ID initialization copies
`gameIds[0]` and `handProposal.myContribution` into state and computes whether
the local player is the proposal's first mover. Assert your expected member
count and proposal game type in `createHand`.
- `move-readable` addresses one member of the hand. `readable` is the
  serialized CLVM readable returned by the opponent-move handler.
  `moverShare` is a decimal mojo string because it originated at the WASM
  boundary.
- `message-readable` carries serialized advisory readable data for one member. It
  does not itself imply a move, turn change, or protocol-state transition.
- `hand-ended` supplies the normalized settlement outcome, when one exists, for
  one member. Multi-ID hands receive independent terminal inputs as their
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

The host also provides shared UI helpers through `games/host`, including
`AmountInput`, `useGameHost`, amount formatting, and settlement labels.

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
- A fresh `GameHand` initializes from accepted terms and a restored hand accepts
  its generic saved state before updates.
- `GameHand.receive` handles move, message, and terminal updates in order, and
  `getState` returns the latest complete hand state.
- Every outgoing intent is tested for accepted, rejected, and unexpected-failure
  behavior.
- Live and frozen branches of the single mount render the expected game state,
  and the frozen branch cannot dispatch.
- The full project test suite passes through `./ct.sh`.

For detailed handler and validator examples, see
[`HANDLER_GUIDE.md` — Worked Examples](HANDLER_GUIDE.md#worked-examples-reference-games).
