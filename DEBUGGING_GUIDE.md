# Debugging & Testing Reference

For architecture and design, see `OVERVIEW.md`. This document covers how
to build, run tests, read output, and debug failures.

## Building and Running Tests

### Use `./cb.sh` and `./ct.sh`

**Always use `./ct.sh` to run tests. Never use `cargo test` directly.** The
script handles feature flags (`--features sim-server`), output capture
(`--nocapture`), log rotation, and wraparound test ordering.

- **`./cb.sh`** — Build the test binary without running tests. Passes extra
  args to cargo (e.g. `./cb.sh --release`). Uses the same compilation profile
  as `./ct.sh`, so running `./ct.sh` after `./cb.sh` does not recompile.
- **`./ct.sh`** — Run sim tests.
  - `./ct.sh` — runs all tests in normal order. **This is the default.**
  - `./ct.sh accept_finished` — starts at the first test matching
    `accept_finished`, wraps around through all tests. The test you care about
    runs first, then you confirm nothing else broke.
  - `./ct.sh -o accept_finished` — runs **only** test(s) matching
    `accept_finished`. Useful for isolating a single test's output.
  - If the argument doesn't match any test name, you get an error listing all
    available tests.

### Running tests directly (without scripts)

If you must bypass the scripts, replicate what `ct.sh` does:

```bash
cargo test --lib --features sim-server -- --nocapture
```

The `--lib` flag skips doc-test compilation (which adds ~14s even when there
are no doc-tests).

To start from a specific test (wraparound):
```bash
SIM_TEST_FROM=accept_finished cargo test --lib --features sim-server -- --nocapture
```

To run only matching test(s):
```bash
SIM_TEST_ONLY=accept_finished cargo test --lib --features sim-server -- --nocapture
```

### Test debugging workflow

When a test fails, use this sequence:

1. **Isolate**: `./ct.sh -o failing_test` — run only that test while debugging.
   Individual tests are fast (1–5s), so iteration is quick.
2. **Full suite from that test**: Once the test passes, switch to
   `./ct.sh failing_test` (no `-o`). This runs all tests starting from the
   one you just fixed, then wraps around. The tests *before* it in the
   default order already passed on the run that discovered the failure, so
   there's no reason to re-run them first — start from the fix and cover
   the rest.

### Typical durations

| Scope | Typical time |
|-------|-------------|
| Single simple test | 1–3s |
| Single on-chain test | 3–5s |
| Full sim suite (parallel) | ~30s |
| Build (`./cb.sh`) | ~10–20s (incremental) |

### Environment variables

| Variable | Effect |
|----------|--------|
| `SIM_TEST_FROM=name` | Start the test rotation at the first test matching `name`, wrap around (`./ct.sh name`) |
| `SIM_TEST_ONLY=name` | Run only test(s) matching `name` (`./ct.sh -o name`) |
| `SIM_TIMING=1` | Print detailed timing for each simulation step (farm_block, new_block, push_transactions, deliver_message) |
| `RUST_LOG=debug` | Enable `log::debug!` output (normally suppressed) |

### Test registration

Tests are registered via `test_funs()` functions that return closures. All
closures are collected and executed in parallel using `std::thread::scope` with
a shared work queue sized to `available_parallelism()`. To disable a test,
comment out its `res.push(...)` call in the relevant `test_funs()` function.

## Reading Test Output

The output from `./ct.sh` is designed to be read directly. A passing run ends
with a line like `All 48 tests passed in 28.31s`. A failing run prints
`PANIC IN TEST:` inline as each failure occurs, then ends with a summary:

```
--- 3 FAILED TEST(S) ---

  FAIL: test_foo
  some error message

  FAIL: test_bar
  another error message

45 passed, 3 failed in 32.15s
```

All tests run to completion regardless of failures — a single panic does not
abort the suite. This lets you see every broken test in one run.

### Pass/fail

The exit code is reliable: nonzero means at least one test panicked. Each test
prints `RUNNING TEST <name> ...` when it starts and `<name> ... ok (<time>)`
when it finishes. Failed tests print `PANIC IN TEST: <name>` inline instead.

### Panics

Each test body is wrapped in `catch_unwind`. When a test panics, the runner
prints `PANIC IN TEST: <name>` and `panic payload:` with the error message
inline, then continues running remaining tests. Example mid-run output:

```
PANIC IN TEST: test_notification_accept_finished
panic payload: tx include failed: move_number=10 tx_name=Some("false accept transaction") ...
```

The `PANIC IN TEST:` line identifies which test panicked (even when multiple
tests run in parallel). The `panic payload:` line has the error details.
All failures are collected and printed again in the summary at the end.

### Saving output

If you need to save output for later, pipe through `tee`:

```bash
./ct.sh 2>&1 | tee /tmp/test-output.log
```

Use `2>&1` because some output goes to stderr.

## Project-Specific Diagnostics

### Simulation stalls

The `simulation stalled` panic message includes `move_number`, `can_move`,
and `next_action`. These map directly to the structured diagnosis questions:
which action was the sim loop waiting to fire, and why didn't its trigger
condition become true?

### Puzzle hash mismatches

Trace both the **expected** hash (what was curried/committed earlier) and the
**actual** hash (what was revealed/reconstructed). The divergence between
their input data is the bug.

## Simulation Test Infrastructure

### Overview

Simulation tests exercise the full off-chain/on-chain game lifecycle by running
two `SynchronousGameCradle` instances against a local `Simulator` blockchain.
Each test defines a sequence of `GameAction` steps; the sim loop
(`run_game_container_with_action_list_with_success_predicate` in
`src/simulator/tests/potato_handler_sim.rs`) executes them while handling
message delivery, block farming, and notification dispatch.

### Key files

| File | Role |
|------|------|
| `src/test_support/game.rs` | Defines the `GameAction` enum, `ProposeTrigger` (sim-tests feature gate) |
| `src/simulator/tests/potato_handler_sim.rs` | Sim loop, test runner helpers, most tests |
| `src/test_support/calpoker.rs` | `prefix_test_moves`, calpoker-specific tests |
| `src/test_support/debug_game.rs` | Debug-game setup helpers |

### Explicit GameIDs

`GameAction` variants reference games by explicit `GameID` values — not ordinal
indices. `GameID` values are deterministic nonces assigned when proposing a
game; each player's nonce counter increments independently (even for one
player, odd for the other, depending on who holds the initial potato).

- `Move(player, game_id, readable, share)` — move in the specified game
- `AcceptProposal(player, game_id)` — accept the proposal with this game ID
- `ProposeNewGame(player, trigger)` — propose a new game; the `GameID` is
  determined by the nonce counter at proposal time

### `ProposeTrigger`

`ProposeNewGame` and `ProposeNewGameTheirTurn` carry a `ProposeTrigger` that
specifies when the action is ready to fire:

- `ProposeTrigger::Channel` — fires when `channel_created` is true for the
  proposing player.
- `ProposeTrigger::AfterGame(game_id)` — fires when `game_id` has a terminal
  notification in either player's `game_finished_ids`.

### GameAction variants

**Game lifecycle (event-triggered):**
- `Move(player, game_id, readable, share)` — Player makes a move. Triggered
  when `game_accepted_ids` or `opponent_moved_in_game` contains the game ID.
- `AcceptProposal(player, game_id)` — Two-phase: phase 1 calls
  `accept_proposal` when the proposal is received; phase 2 advances past when
  the accept resolves (see [Two-phase AcceptProposal](#two-phase-acceptproposal)).
- `ProposeNewGame(player, trigger)` — Propose (`my_turn=true`). Triggered by
  `ProposeTrigger`.
- `ProposeNewGameTheirTurn(player, trigger)` — Propose (`my_turn=false`).

**Game lifecycle (global — fire unconditionally):**
- `AcceptTimeout(player, game_id)` — Accept the game result.
- `CleanShutdown(player)` — Cooperative channel closure.
- `CancelProposal(player, game_id)` — Cancel a proposed game.

**On-chain / fault injection (global):**
- `GoOnChain(player)` — Unilaterally go on chain.
- `GoOnChainThenMove(player)` — Go on chain and immediately make a move.
- `WaitBlocks(n, players)` — Farm `n` blocks. `players` is a bitmask (0 = both).
- `NerfTransactions(player)` / `UnNerfTransactions(replay)` — Drop/restore
  outbound transactions.
- `NerfMessages(player)` / `UnNerfMessages` — Drop/restore outbound messages.
- `Cheat(player, game_id, mover_share)` — Queue a move with invalid data.
- `ForceDestroyCoin(player, game_id)` — Destroy a game coin on-chain.
- `ForceUnroll(player)` / `ForceStaleUnroll(player)` — Submit an unroll outside
  normal flow.

### Sim loop mechanics

Each iteration of the sim loop:

1. **Farm a block** and build a `WatchReport` from the new coin set.
2. **Flush and dispatch** for each player (in order 0, then 1):
   - Call `flush_and_collect` to process inbound messages, settle channel
     setup, retry pending messages, flush potato-gated actions, and collect
     all outbound events.
   - Deliver outbound messages to the other player's inbound queue.
   - Dispatch notifications to `LocalTestUIReceiver`.
3. **Process the next action** from the script if a trigger condition is met.

Because flushing happens in fixed order (player 0 first), a message sent by
player 1 takes one extra iteration to reach player 0 compared to the reverse
direction. This asymmetry is natural and expected — the event-driven triggers
automatically wait for the right notifications before firing.

### Event-driven triggers

The sim loop advances `move_number` only when the next action's trigger
condition is satisfied. There are no polling loops or retry counters.

| Trigger function | Fires when | Used by |
|------------------|------------|---------|
| `move_ready` | `game_accepted_ids` or `opponent_moved_in_game` contains the game ID for the moving player | `Move`, `FakeMove` |
| `accept_proposal_ready` | Phase 1: proposal received. Phase 2: accept resolved (see below) | `AcceptProposal` |
| `propose_ready` | `ProposeTrigger::Channel` → `channel_created`. `AfterGame(n)` → game `n` finished | `ProposeNewGame`, `ProposeNewGameTheirTurn` |
| `global_move` | Always (unconditional) | `GoOnChain`, `WaitBlocks`, `AcceptTimeout`, `CleanShutdown`, etc. |
| `can_move` | Set only after resync (on-chain recovery) | Resync path |

`LocalTestUIReceiver` tracks the event state:

- `received_proposal_ids: Vec<GameID>` — populated by `ProposalMade`
- `game_accepted_ids: HashSet<GameID>` — populated by `ProposalAccepted`
- `opponent_moved_in_game: HashSet<GameID>` — populated by `OpponentMoved`
- `game_finished_ids: HashSet<GameID>` — populated by terminal notifications
- `accepted_proposal_ids: Vec<GameID>` — tracks which accepts have been called
- `channel_created: bool` — populated by `ChannelCreated`

### Two-phase AcceptProposal

`AcceptProposal` is inherently asynchronous: calling `accept_proposal` queues
the accept, but the actual processing (balance check, game creation) happens
only when the player holds the potato. If the player doesn't have the potato,
a `RequestPotato` is sent and the accept waits for the potato round-trip.

The sim loop handles this with a two-phase approach:

- **Phase 1** (proposal received, accept not yet called): `accept_proposal` is
  called on the cradle, and the game ID is added to `accepted_proposal_ids`.
  `move_number` is NOT advanced — the sim loop stays on the same action.
- **Phase 2** (accept called, resolution observed): the trigger fires again
  once one of these notifications appears for the game ID:
  `ProposalAccepted`, `InsufficientBalance`, or `ProposalCancelled`.
  The handler sees the accept was already called, skips the call, and
  `move_number` advances past.

This ensures that subsequent actions (e.g. `GoOnChain`) cannot fire before the
accept's effects have been observed.

### Test design conventions

Tests that are not explicitly testing on-chain scenarios should end with
`CleanShutdown` and verify a successful cooperative closure. On-chain tests
use `GoOnChain` followed by `WaitBlocks` for unroll and game timeouts.

Tests should NOT make assumptions about which player holds the potato at any
given time. Any action that requires the potato (proposing, accepting, moving)
will automatically request it if needed and wait for the round-trip. Effects
like `InsufficientBalance` or `ProposalAccepted` only fire when the potato
arrives and the queued action is actually processed — this delay is normal and
the event-driven triggers account for it.

Tests should NOT require artificial pauses or polling — the event-driven
triggers handle all necessary waiting. If a test stalls, the trigger condition
for the next action is never satisfied, which means either:

1. A notification or message is being lost or delayed unexpectedly.
2. The trigger condition doesn't match the actual event flow.

### Writing a new test

1. Build a `Vec<GameAction>` describing the scenario using explicit `GameID`
   values for every variant that needs one.
2. Every test must explicitly `ProposeNewGame` and `AcceptProposal` to start
   a game — there is no auto-propose/accept.
3. Call `run_calpoker_container_with_action_list` (or the `_with_success_predicate`
   variant for custom termination).
4. Inspect the returned `GameRunOutcome` for notifications, balances, and events.
5. Register the test by adding a `res.push(("test_name", &|| { ... }))` entry
   in the relevant `test_funs()` function.

Example — two-game test where the initiator proposes both games:

```rust
let mut moves = vec![
    GameAction::ProposeNewGame(0, ProposeTrigger::Channel),
    GameAction::AcceptProposal(1, GameID(0)),
];
moves.extend(prefix_test_moves(&mut allocator, GameID(0)));
moves.push(GameAction::AcceptTimeout(0, GameID(0)));
moves.push(GameAction::ProposeNewGame(0, ProposeTrigger::AfterGame(GameID(0))));
moves.push(GameAction::AcceptProposal(1, GameID(2)));
moves.push(GameAction::WaitBlocks(11, 0));
moves.push(GameAction::AcceptTimeout(0, GameID(2)));
moves.push(GameAction::CleanShutdown(0));

let outcome = run_calpoker_container_with_action_list(&mut allocator, &moves)
    .expect("should complete");
```

`prefix_test_moves(allocator, game_id)` returns the 5 hardcoded calpoker
moves for the given `GameID`. It only works for the first game in a
deterministic-seed run; subsequent games produce different cards, so use
timeout or other resolution strategies.

### Stall detection

The sim loop panics after 200 iterations with a diagnostic message including
`move_number`, `can_move`, and the next pending action. If a test stalls, check
whether the trigger condition for the next action can ever be satisfied.

## Debugging Chialisp (CLVM)

**Note:** This section covers the current state of chialisp debugging,
which lacks print statements and stack traces. Once those are available,
prefer them over the technique below.

### The problem

CLVM programs have no print/log facility. When a program crashes (raises,
returns wrong values, or hits a type error like `Requires Int Argument`),
the error message gives you the CLVM opcode and a NodePtr but no source
location or call stack.

### Diagnostic asserts via `(x ...)`

The only way to probe execution is to make the program fail at a known
point using `(x "MARKER" values...)`. The `x` operator raises an
exception whose payload appears in the Rust error message as
`Raise(NodePtr(...))`.

**Critical rule:** You must put the `(x ...)` **in the return path**, not
in a side binding. The chialisp compiler optimizes away unused bindings,
so this does nothing:

```clsp
; WRONG — compiler optimizes this away, never executes
(assign
    _dbg (x "HERE")
    real_result (some_computation)
    real_result
)
```

Instead, replace the return expression itself:

```clsp
; RIGHT — this is the return value, so it must execute
(assign
    intermediate (some_computation)
    (x "DBG_POINT" intermediate)
)
```

### Binary search technique

1. **Pick the midpoint** of the suspected code path.
2. **Replace the return** at that point with `(x "MID" relevant_values)`.
3. **Rebuild** (`tools/build-chialisp.sh` + `./cb.sh`; ~70s total).
4. **Run the failing test** (`./ct.sh -o test_name`).
5. **Interpret:**
   - If the error changes to `Raise(...)` with your marker → execution
     reached that point. The bug is downstream.
   - If the error stays the same (e.g. `PathIntoAtom`) → the crash is
     before your marker. The bug is upstream.
6. **Repeat**, narrowing the range by half each time.

### Checking specific values

Once you've found the crashing expression, you can probe sub-expressions:

```clsp
; What is this value? Is it an atom or a pair?
(x "CHECK_VAL" (strlen some_value) some_value)
```

Or use conditional asserts to test specific properties:

```clsp
; Only crash if the value is wrong
(if (= (strlen val) 32)
    (real_computation val)
    (x "BAD_LEN" (strlen val) val)
)
```

### Chialisp rebuild cycle

Each chialisp change requires:
1. `rm -f .build-chialisp.cache` (force rebuild)
2. `bash tools/build-chialisp.sh` (~60–70s)
3. `./cb.sh` (recompile Rust, picks up new .hex files, ~1–2s incremental)
4. Run the test

To speed things up, delete only the affected hex files instead of the
cache:
```bash
find clsp -name '*.hex' -path '*/spacepoker/*' -delete
```

### Cleanup

Remove all diagnostic `(x ...)` calls after the bug is fixed. They are
not documentation. Search for your marker prefix (e.g. `DBG_`) to find
them all.

## Mistakes to Avoid

- **Don't use `cargo test` directly.** Use `./ct.sh`. The script handles
  feature flags, output capture, and test ordering.
- **Don't filter test output.** Don't use `head`, `tail`, `grep`, or any
  truncation. Read the complete output — early output is build noise, but the
  middle contains per-test diagnostics you'll need when something fails.
- **Don't run tests in the background.** Run `./ct.sh` and `./cb.sh` in the
  foreground and wait for them to finish. Background execution with sleep-based
  polling wastes time and makes output harder to capture.
- **AI agents: always run `./cb.sh` and `./ct.sh` in the foreground** with a
  high `block_until_ms` (120000 ms / 2 minutes). Never background these
  commands. The full test suite completes in ~30 seconds; builds are faster.
  Both scripts print overall elapsed time at completion.
- **Don't use `sleep` to wait for processes.** When waiting for a command to
  finish, set `block_until_ms` to a value higher than the expected runtime.
  The tool returns as soon as the process exits or the timeout elapses,
  whichever comes first. Using `sleep` wastes time and blocks interruption.
- **On macOS/Linux, use `kill -0` instead of `sleep` for waiting.**
  `sleep N` always waits the full N seconds even if the process finished
  immediately. This alternative checks once per second whether the process
  is still running and exits as soon as it isn't:

  ```bash
  # kill -0 sends no signal — it only checks whether the PID exists
  for i in $(seq 60); do kill -0 <pid> 2>/dev/null || break; sleep 1; done
  ```

  This is strictly better than `sleep 60`: identical worst case (60s if
  the process truly takes that long), but returns within 1 second of
  process exit instead of wasting the remaining time. Use a higher count
  when the expected runtime is longer.

  `kill -0` is POSIX and works on macOS and Linux, not Windows.
