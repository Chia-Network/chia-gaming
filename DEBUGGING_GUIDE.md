# Debugging & Testing Reference for chia_gaming

This document captures hard-won knowledge from debugging the calpoker on-chain
tests. It is intended as a reference for future sessions.

## Building and Running Tests

### Use `./cb.sh` and `./ct.sh`

**Always use `./ct.sh` to run tests. Never use `cargo test` directly.** The
`./ct.sh` script handles feature flags (`--features sim-tests`), output capture
(`--nocapture`), log rotation, and wraparound test ordering. Running `cargo test`
manually is error-prone: you might forget `--features sim-tests`, forget
`--nocapture`, or use `--filter` which hides output from other tests.

- **`./cb.sh`** — Build with sim-tests feature. Passes extra args to cargo
  (e.g. `./cb.sh --release`).
- **`./ct.sh`** — Run all sim tests.
  - `./ct.sh` — runs all tests in normal order. **This is the default.** Always
    run all tests with no filter. The full output includes `--nocapture` so you
    see all debug output, panics, and event dumps without needing a second run.
  - `./ct.sh accept_finished` — starts at the first test matching
    `accept_finished`, runs through the end, wraps back to the beginning, and
    finishes right before where it started. Every test runs exactly once. Use
    this when debugging a specific failure: the test you care about runs first,
    then you confirm nothing else broke.
  - If the argument doesn't match any test name, you get a clear error listing
    all available tests.

**Do NOT use `cargo test` with `--filter` or test name arguments.** This runs
only matching tests and hides output from others, forcing you to re-run just to
see what happened. Use `./ct.sh` with no arguments to get everything in one
pass, then grep the output for the specific test or error you care about.

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

To run a single test by name (useful for profiling):
```bash
SIM_TEST_ONLY=test_referee_play_debug_game_alice_slash cargo test --lib --features sim-tests -- --nocapture
```

- The full sim suite takes ~30s with parallelism on a modern laptop.
- Individual tests range from ~1–5s each.
- Each iteration of the simulation loop involves CLVM evaluation, so
  a 200-step stall can take a long time before the assertion fires.

### Capturing output to a file

If you need to save test output for later filtering, pipe through `tee`:
```bash
./ct.sh 2>&1 | tee /tmp/test-output.log
```

Then filter as needed:
```bash
rg "RUNNING TEST|panic" /tmp/test-output.log
```

### Waiting for test processes to finish

Typical durations (after CLVM and parallelism optimizations):

| Scope | Typical time |
|-------|-------------|
| Single simple test | 1–3s |
| Single on-chain test | 3–5s |
| Full sim suite (parallel) | ~30s |
| Build (`./cb.sh`) | ~10–20s (incremental) |

### How to check pass/fail

The test runner's exit code is reliable: nonzero means a test failed. A panic
kills the process immediately (`std::process::exit(1)` in the panic hook), so
the failing test is always the last one in the output.

```bash
# Summary of all test results:
./ct.sh 2>&1 | rg "RUNNING TEST|ok|panic"
```

This gives you lines like:
```
RUNNING TEST test_play_calpoker_happy_path ...
test_play_calpoker_happy_path ... ok
RUNNING TEST some_failing_test ...
panic payload: tx include failed: ...
```

A test that shows `RUNNING TEST` but no `... ok` line (and instead has `panic`
lines) has failed. Since panics kill the process, the failing test is always the
last `RUNNING TEST` in the output.

### How to find panics in the output

The panic hook prints a `panic payload:` line followed by a full backtrace, then
exits the process immediately. The failing test is always the last one — look at
the tail of the output.

Panic output looks like this in the log:
```
panic payload: tx include failed: move_number=10 tx_name=Some("false accept transaction") ...
   2: std::panicking::panic_with_hook
   ...
```

The `panic payload:` line has the actual error message.

### How to get targeted debug info

Internal debug output uses `log::debug!` and only appears when `RUST_LOG` is
set (e.g., `RUST_LOG=debug`). The test runner itself emits `RUNNING TEST` and
`panic payload:` lines via `eprintln!`, which are always visible.

For ad-hoc debugging, add targeted `eprintln!()` calls with a distinctive
prefix so you can grep for them. Remove after the issue is fixed.

```bash
# Last 50 lines (usually shows the final result or panic):
tail -50 /tmp/test-output.log

# Find the failing test and its panic:
rg "RUNNING TEST|panic" /tmp/test-output.log
```

### Test registration and parallel execution

Tests are registered in multiple files, each providing a `test_funs()` function
that returns `Vec<(&'static str, &'static (dyn Fn() + Send + Sync))>`:

- `src/test_support/calpoker.rs` — calpoker-specific tests
- `src/simulator/tests/potato_handler_sim.rs` — notification tests, debug game tests, stale unroll tests
- `src/tests/channel_handler.rs` — channel handler unit tests

All test closures are collected into a single `Vec` and executed in parallel
using `std::thread::scope` with a shared work queue. The number of threads
is `std::thread::available_parallelism()` (typically the number of CPU cores).
Each test's name and elapsed time are printed when it completes.

To disable a test, comment out the `res.push(...)` call in the relevant
`test_funs()` function.

### Environment variables for test debugging

| Variable | Effect |
|----------|--------|
| `SIM_TEST_FROM=name` | Start the test rotation at the first test matching `name`, wrap around |
| `SIM_TEST_ONLY=name` | Run only the single test matching `name` (useful for profiling) |
| `SIM_TIMING=1` | Print detailed timing diagnostics for each simulation step (farm_block, new_block, push_tx, deliver_message) |
| `RUST_LOG=debug` | Enable `log::debug!` output (normally suppressed) |

## The Redo Mechanism (Forward-Only)

All state transitions are **forward-only**. There is no rewind logic. When a
game goes on-chain, the system either recognizes the game coin is at the latest
state, or it replays exactly one cached move via `RedoMove`.

### How set_state_for_coins works

After the unroll coin resolves (timeout or preemption), game coins are created.
`set_state_for_coins` matches each coin's puzzle hash:

1. **Coin PH matches a `cached_last_actions` entry's `match_puzzle_hash`**: Needs
   redo. The game coin is at the state before our cached move. Queue `RedoMove`.
2. **Coin PH == `last_referee_puzzle_hash`**: Latest state. No redo needed.
3. **Neither**: Error.

## Timeouts and Timelocks

### Three distinct timeouts

| Timeout | What it does | On-chain condition | Test value |
|---------|--------------|--------------------|------------|
| `channel_timeout` | Watcher safety timeout for channel coin | None (watcher-level only) | 100 |
| `unroll_timeout` | Relative timelock on unroll coin | `ASSERT_HEIGHT_RELATIVE` | 5 |
| `game_timeout` | Relative timelock on game coin (referee) | `ASSERT_HEIGHT_RELATIVE` | 10 |

### Common pitfall: wrong timeout for RegisterCoin

Game coins must be registered with the watcher using their specific
`game_timeout` (from `OnChainGameState.game_timeout`), NOT `channel_timeout`.
Using `channel_timeout` (100) for game coins causes the watcher to wait far too
long before firing timeout transactions, leading to simulation stalls.

Similarly, `ChannelHandler::new` must receive `unroll_timeout` (not
`channel_timeout`) for the unroll coin timelock. The `make_channel_handler`
call in `potato_handler/mod.rs` passes `self.unroll_timeout`.

### Simulator enforcement

The simulator panics if a transaction with an unsatisfied `ASSERT_HEIGHT_RELATIVE`
(condition code 82) is submitted. This catches bugs where timeout transactions
are submitted too early. Timeout transactions should be submitted at the exact
block where the timelock is satisfiable.

## Preemption

### How it works

When the channel coin is spent, both players see the unroll coin's sequence
number. Each player compares it against their own state:

- **On-chain SN < ours**: Preempt immediately (no timelock) with our
  higher-numbered state.
- **On-chain SN == ours**: Wait for timeout.
- **On-chain SN > ours**: Hard error.

Preemption is immediate; timeouts wait. This prevents conflicting transactions.

## Resync and Simulation Stalls

When a game coin is spent with redo data, `handle_game_coin_spent` returns
resync info (a `ResyncInfo` value separate from the effects list). The
simulation loop responds by walking `move_number` backward to find the last
`Move` or `Cheat` action.

### The player-check fix

The walkback now verifies that the found action belongs to the **correct
player** (the one whose resync triggered the walkback). If the action is for
a different player, `move_number` is restored to its saved value. Without this
check, the simulation would find a Move for the wrong player, fail to execute
it, and stall.

### Stall pattern (resolved)

Before the fix:
1. Resync fires for player A
2. Walkback finds `Move(B, ...)` — wrong player
3. Sim tries to execute it, `is_my_move` returns false
4. `move_number -= 1`, back to the same Move
5. Infinite loop → `simulation stalled` at 200 steps

After the fix:
1. Resync fires for player A
2. Walkback finds `Move(B, ...)` — wrong player
3. Player check detects mismatch, restores `move_number`
4. Sim continues with the next action (e.g., `WaitBlocks`, `Shutdown`)

### How to diagnose stalls

The `simulation stalled` panic message includes `move_number`, `can_move`, and
`next_action`. If the stall involves a redo, add `eprintln!` in
`handle_game_coin_spent` and the resync walkback to trace which player triggered
it and what action was found.

### Test design: turn alignment after redo

Because the redo automatically replays the last cached move, the turn advances
one step beyond what the unroll produces. Tests that use `Cheat(N)`,
`Accept(N)`, or other turn-dependent actions must use the right number of
off-chain moves to ensure the correct player's turn after the redo:

| Moves | Last move by | After redo, turn is | Good for |
|-------|-------------|--------------------|----|
| 2 | Bob | Alice | `ForceDestroyCoin` on Alice's turn |
| 3 | Alice | Bob | `Cheat(1)`, `ForceDestroyCoin` on Bob's turn |
| 4 | Bob | Alice | `Cheat(0)`, `Accept(0)` |

## Common Errors and What They Mean

| Error | Meaning |
|-------|---------|
| `WRONG_PUZZLE_HASH (error 8)` | The puzzle provided to spend a coin doesn't hash to the coin's puzzle hash. Usually means the referee state is out of sync with the on-chain coin. |
| `MINTING_COIN (error 20)` | Trying to create a coin that already exists. Often benign (duplicate tx submission). The test harness tolerates this. |
| `simulation stalled` | The simulation loop hit `num_steps` limit without completing. Check `move_number`, `next_action`, and `can_move` in the panic message. |
| `ClvmErr(Raise(...))` | The chialisp program raised an error. Check the solution being passed and the puzzle it's being run against. |
| `ASSERT_HEIGHT_RELATIVE violated` | A timeout transaction was submitted before the timelock was satisfiable. Check which timeout value is being used. |
| `Conflicting transactions in mempool` | Two transactions try to spend the same coin. This should never happen — preemption is immediate while timeouts wait. |
| `shut_down without finishing handshake` | A Shutdown action was issued while the game was still in an on-chain transition state. |

## Key Files

| File | Purpose |
|------|---------|
| `src/referee/mod.rs` | Core referee logic, `Referee` enum, dispatching |
| `src/referee/my_turn.rs` | `MyTurnReferee`, `make_move`, state transitions |
| `src/referee/their_turn.rs` | `TheirTurnReferee`, `their_turn_coin_spent`, `their_turn_move_off_chain` |
| `src/referee/types.rs` | `RefereePuzzleArgs`, `OnChainRefereeMoveData`, curry functions |
| `src/channel_handler/mod.rs` | `ChannelHandler`, `game_coin_spent`, `set_state_for_coins`, preemption |
| `src/channel_handler/types/live_game.rs` | `LiveGame`, wraps referee, `last_referee_puzzle_hash` |
| `src/channel_handler/types/on_chain_game_state.rs` | `OnChainGameState`: `our_turn`, `game_timeout`, etc. |
| `src/channel_handler/types/unroll_coin.rs` | Unroll coin puzzle/solution generation |
| `src/potato_handler/mod.rs` | `PotatoHandler`, handshake, `do_channel_spend_to_unroll` |
| `src/potato_handler/on_chain.rs` | `OnChainGameHandler`, `handle_game_coin_spent`, `coin_timeout_reached` |
| `src/simulator/tests/potato_handler_sim.rs` | Test infrastructure, `run_calpoker_container_with_action_list` |
| `src/test_support/calpoker.rs` | Calpoker-specific test setup and registration |

## Debugging Tips

### Process and output management

1. **Always use `./ct.sh` with no filter.** Run the full suite and grep the
   output. Never use `cargo test` directly or with `--filter` — it hides output
   you'll need later and forces re-runs.

2. **Pipe through `tee` if you need to re-filter later.** Otherwise the direct
   output is fine — debug spew has been cleaned up.

3. **A panic kills the process immediately.** The failing test is always the
   last one in the output. Look at the tail to find it.

### Finding and interpreting failures

4. **Distinguish between the two players' output.** Debug lines from
   `on_chain.rs` are prefixed with `false` or `true` = `is_initial_potato()`.
   `false` = player 0 (Alice), `true` = player 1 (Bob).

5. **For `simulation stalled` panics**, the panic message includes
   `move_number`, `can_move`, and `next_action`. Check whether the next action
   is for the correct player and whether the redo changed the expected turn.

### Code-level debugging

6. **Add targeted `eprintln!()` calls** with a distinctive prefix (e.g.,
   `MY_DEBUG:`) to the specific function you're investigating so you can grep
   for it. Internal debug output uses `log::debug!` and requires `RUST_LOG` to
   be visible; `eprintln!` is always visible. Remove after the issue is fixed.

7. **Trace the coin lifecycle** when debugging puzzle hash mismatches:
   - What puzzle hash was the coin created with?
   - What do `on_chain_referee_puzzle_hash()` and `outcome_referee_puzzle_hash()` return?
   - Did the coin go through the `Expected` or `Moved` path?
   - Was a redo triggered? Did the PH match?
   - Does `last_referee_puzzle_hash` match the coin PH?

### Mistakes to avoid

- **Don't use `cargo test` with filters** — use `./ct.sh` and grep the full output.
- **Don't use `head` to read test output** — early output is build noise.
- **Exit code is reliable.** Nonzero means a test panicked.
- **Don't forget `2>&1`** when piping test output. Some output goes to stderr.
- **Don't run tests in the background.** Run `./ct.sh` or `./cb.sh` in the
  foreground and wait for them to finish. Background execution with sleep-based
  polling wastes time and makes output harder to capture.
- **AI agents: always run `./cb.sh` and `./ct.sh` in the foreground** with a
  high `block_until_ms` (120000 ms / 2 minutes). Never background these
  commands. The full test suite completes in ~30 seconds; builds are faster.
  Both scripts print overall elapsed time at completion.
