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
   Individual tests are fast (<1s for most, ~3s for on-chain), so iteration is quick.
2. **Full suite from that test**: Once the test passes, switch to
   `./ct.sh failing_test` (no `-o`). This runs all tests starting from the
   one you just fixed, then wraps around. The tests *before* it in the
   default order already passed on the run that discovered the failure, so
   there's no reason to re-run them first — start from the fix and cover
   the rest.

### Typical durations

| Scope | Typical time |
|-------|-------------|
| Single simple test | <1s |
| Single on-chain test | ~3s |
| Full sim suite (parallel) | ~8s |
| Build (`./cb.sh`) | ~1s after a Rust edit; ~0s for hex-only changes |

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
with a line like `All 195 tests passed in 8.19s`. A failing run prints
`PANIC IN TEST:` inline as each failure occurs, then ends with a summary:

```
--- 3 FAILED TEST(S) ---

  FAIL: test_foo
  some error message

  FAIL: test_bar
  another error message

192 passed, 3 failed in 8.42s
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

Simulation tests exercise the full off-chain/on-chain game lifecycle by running
two `GameSession` instances against a local `Simulator` blockchain.
For the complete `GameAction` catalog, explicit `GameID` rules, `ProposeTrigger`
semantics, and test-writing reference, see `SIMULATOR_TESTING.md`.

### Debugging Stalled Simulation Tests

The sim loop advances `move_number` only when the next action's trigger
condition is satisfied. If a test stalls, first compare the next pending action
against the event state in `LocalTestUIReceiver`:

- Proposal actions wait for `channel_created` or a terminal notification for
  the referenced `GameID`.
- Move actions wait for `game_accepted_ids` or `opponent_moved_in_game` to
  contain the referenced `GameID`.
- `AcceptProposal` is two-phase: first it waits for the proposal to arrive,
  then it waits for `ProposalAccepted`, `InsufficientBalance`, or
  `ProposalCancelled` after `accept_proposal` has been called.
- Global actions such as `GoOnChain`, `WaitBlocks`, `AcceptSettlement`, and
  `CleanShutdown` are unconditional once they become the next scripted action.

The sim loop panics after 200 iterations with a diagnostic message including
`move_number`, `can_move`, and the next pending action. Use that message to ask:
what event would make the next action ready, and why did the event not happen?
Common causes are using the wrong explicit `GameID`, waiting on a proposal that
was never delivered, or expecting `AcceptProposal` to resolve before the player
gets the potato.

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
3. **Rebuild** (`tools/build-chialisp.sh` + `./cb.sh`; ~85s total).
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
2. `bash tools/build-chialisp.sh` (~85s)
3. `./cb.sh` (rebuild the test binary; ~1s after a Rust edit, ~0s otherwise —
   `.hex` files are loaded at runtime, not compiled in)
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
  commands. The Rust sim suite runs in well under 30 seconds (~8s); the
  slowest step is the chialisp rebuild (~80s when `.clsp` sources change),
  so 2 minutes is a safe ceiling. Both scripts print overall elapsed time
  at completion.
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
