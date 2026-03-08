# Debugging & Testing Reference

For architecture and design, see `ARCHITECTURE.MD`. This document covers how
to build, run tests, read output, and debug failures.

## Building and Running Tests

### Use `./cb.sh` and `./ct.sh`

**Always use `./ct.sh` to run tests. Never use `cargo test` directly.** The
script handles feature flags (`--features sim-tests`), output capture
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
cargo test --lib --features sim-tests -- --nocapture
```

The `--lib` flag skips doc-test compilation (which adds ~14s even when there
are no doc-tests).

To start from a specific test (wraparound):
```bash
SIM_TEST_FROM=accept_finished cargo test --lib --features sim-tests -- --nocapture
```

To run only matching test(s):
```bash
SIM_TEST_ONLY=accept_finished cargo test --lib --features sim-tests -- --nocapture
```

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
| `SIM_TIMING=1` | Print detailed timing for each simulation step (farm_block, new_block, push_tx, deliver_message) |
| `RUST_LOG=debug` | Enable `log::debug!` output (normally suppressed) |

### Test registration

Tests are registered via `test_funs()` functions that return closures. All
closures are collected and executed in parallel using `std::thread::scope` with
a shared work queue sized to `available_parallelism()`. To disable a test,
comment out its `res.push(...)` call in the relevant `test_funs()` function.

## Reading Test Output

The output from `./ct.sh` is designed to be read directly. A passing run ends
with a line like `All 48 tests passed in 28.31s`. A failing run ends with the
panic — the process exits immediately on panic, so the failure is always the
last thing printed.

### Pass/fail

The exit code is reliable: nonzero means a test panicked. Each test prints
`RUNNING TEST <name> ...` when it starts and `<name> ... ok (<time>)` when it
finishes. A test that starts but doesn't print `ok` is the one that failed.

### Panics

The panic hook prints a `panic payload:` line with the error message, followed
by a backtrace, then exits immediately. Example:

```
panic payload: tx include failed: move_number=10 tx_name=Some("false accept transaction") ...
   2: std::panicking::panic_with_hook
   ...
```

The `panic payload:` line has the information you need.

### Saving output

If you need to save output for later, pipe through `tee`:

```bash
./ct.sh 2>&1 | tee /tmp/test-output.log
```

Use `2>&1` because some output goes to stderr.

## Debugging Techniques

### Ad-hoc debug output

Add targeted `eprintln!()` calls with a distinctive prefix (e.g. `MY_DEBUG:`)
to the function you're investigating. This is always visible without any
env vars. Remove after the issue is fixed.

For existing debug output, set `RUST_LOG=debug` to enable `log::debug!` calls
throughout the codebase.

Set `SIM_TIMING=1` to see per-step timing in the simulation loop (useful for
finding which step is slow).

### Diagnosing simulation stalls

The `simulation stalled` panic message includes `move_number`, `can_move`,
and `next_action`. Ask:

- What state did it stall on?
- Was it supposed to have gotten there, or somewhere else?
- If it was supposed to get there, what was supposed to happen next?
- Why didn't it?

### Diagnosing puzzle hash mismatches

When a puzzle hash mismatch occurs, there are two sides to compare:

- What was hashed to produce the **expected** value, and where did it come from?
- What was hashed for the **attempted reveal**, and where did it come from?

The divergence between these two answers is the bug.

## Mistakes to Avoid

- **Don't use `cargo test` directly.** Use `./ct.sh`. The script handles
  feature flags, output capture, and test ordering.
- **Don't use `head` to read test output.** Early output is build noise. Just
  read the end.
- **Don't run tests in the background.** Run `./ct.sh` and `./cb.sh` in the
  foreground and wait for them to finish. Background execution with sleep-based
  polling wastes time and makes output harder to capture.
- **AI agents: always run `./cb.sh` and `./ct.sh` in the foreground** with a
  high `block_until_ms` (120000 ms / 2 minutes). Never background these
  commands. The full test suite completes in ~30 seconds; builds are faster.
  Both scripts print overall elapsed time at completion.
