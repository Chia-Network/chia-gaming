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

Also implement `durableState.reduceEvent`. This reducer updates the saved UI
state when the host reports:

- `accepted-group`: the proposal was accepted and the hand started.
- `game-status`: the protocol state or readable game data changed.
- `local-turn`: the local turn flag changed.
- `settled`: the game finished.
- `remove-group`: this group was removed.
- `abandoned`: the session was abandoned.
- `feature-state`: the game UI committed one of its own state changes.

Keep the reducer pure. Given the same current state and event, it must return
the same next state.

If your `HandProposal` has extra fields, implement
`persistence.encodeExtras` and `persistence.decodeExtras` in
`handProposal.ts`. This saves the proposal itself; `stateCodec` saves the
in-progress or finished UI state.

## Step 6: Build the play UI

Implement `play.tsx` and export a `GameMountRegistration` named `play`. It has
two rendering functions:

- `renderLive(session, names)` renders a hand that can still send commands.
- `renderFrozen(view, options)` renders a finished or restored hand without
  allowing protocol commands.

The live view provides active game IDs, accepted game amounts, gameplay events,
turn callbacks, durable game state, and display names. The frozen view provides
the same accepted-game information in read-only form with final results.
Neither view receives the `HandProposal`: use the `accepted-group` reducer to
copy any game-specific proposal settings into durable state when the hand
starts.

These functions return React elements; they are not imperative drawing
callbacks. React may call them again when session state changes, then preserves
the existing component state and DOM where the element type and key are
unchanged. The host applies its `handKey` to the returned element, which
intentionally starts a fresh component lifecycle for each new hand. Game code
does not need to add a React key or manage this lifecycle itself.

Use `requireLiveGameHandSource` before sending a command. This prevents a
finished or historical view from accidentally acting on the live protocol.
Use `terminalGameHandSource` when constructing a read-only source.

The main command boundary is `commitLocalGameAction`. Submit one of these
`LocalGameCommand` values:

- `make-move` for a normal game action.
- `accept-settlement` when the player agrees to finish the game.
- `cheat` only for game-specific testing or deliberate cheat controls.

The host sends normalized `GameplayEvent` values to the UI:

- `OpponentMoved` contains readable data from an opponent's move.
- `GameMessage` contains an informational game message.
- `MoveRejected` explains why a local move was rejected.
- `Settled` reports the final settlement.
- `GameError` reports a failed action or terminal operation.

These events are intentionally independent of the raw WASM notification
format. A game should not import frontend session code to interpret WASM
messages.

The host also provides shared UI helpers through `games/host`, including
`AmountInput`, `useGameHost`, amount formatting, settlement labels, and
`GameTerminalModel`.

## Import boundaries

Game UI code and game tests may import:

- `games/host`, usually through `../../host`
- Other files inside the same game package
- `react`, `rxjs`, and `clvm-lib`

They must not import from `front-end/` or use the frontend `@/` alias. This
keeps a game portable and prevents circular dependencies. The isolation test
in
[`game_package_isolation.test.ts`](front-end/src/lib/tests/game_package_isolation.test.ts)
enforces this rule.

The following are frontend implementation details, not APIs for games:

- Raw WASM payload types such as `GameStatus`, `ActionFailed`, and
  `ProposalMade`
- [`front-end/src/lib/wasm/gameplayEvents.ts`](front-end/src/lib/wasm/gameplayEvents.ts)
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
- `durableState.reduceEvent` handles starting, playing, settling, removing, and
  restoring a hand.
- Live and frozen views render the expected game state.
- The full project test suite passes through `./ct.sh`.

For detailed handler and validator examples, see
[`HANDLER_GUIDE.md` — Worked Examples](HANDLER_GUIDE.md#worked-examples-reference-games).
