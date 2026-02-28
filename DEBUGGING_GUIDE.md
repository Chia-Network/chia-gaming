# Debugging & Testing Reference for chia_gaming

This document captures hard-won knowledge from debugging the calpoker on-chain
tests. It is intended as a reference for future sessions.

## Building and Running Tests

### Use `./cb` and `./ct`

**Always use the helper scripts.** They handle feature flags, output capture,
log rotation, and wraparound test ordering so you don't have to.

- **`./cb`** — Build with sim-tests feature. Passes extra args to cargo
  (e.g. `./cb --release`).
- **`./ct`** — Run all sim tests.
  - `./ct` — runs all tests in normal order.
  - `./ct accept_finished` — starts at the first test matching `accept_finished`,
    runs through the end, wraps back to the beginning, and finishes right before
    where it started. Every test runs exactly once. Use this when debugging a
    specific failure: the test you care about runs first, then you confirm nothing
    else broke.
  - If the argument doesn't match any test name, you get a clear error listing
    all available tests.

Prefer `./ct some_test_name` over raw `cargo test` invocations. The scripts
set `SIM_TEST_FROM` and `--nocapture` correctly. Running `cargo test` directly
without the right flags is error-prone and wastes time.

### Running tests directly (without scripts)

If you must bypass the scripts, replicate what `ct` does:

```bash
cargo test --features sim-tests -- --nocapture
```

To start from a specific test (wraparound):
```bash
SIM_TEST_FROM=accept_finished cargo test --features sim-tests -- --nocapture
```

- A single on-chain test takes 30–60s locally; the full sim suite takes 5–8 min.
- Each iteration of the simulation loop involves expensive CLVM evaluation, so
  a 200-step stall can take a long time before the assertion fires.

### Capturing output to a file

If you need to save test output for later filtering, pipe through `tee`:
```bash
./ct 2>&1 | tee /tmp/test-output.log
```

Then filter as needed:
```bash
rg "resync|SEND_POTATO" /tmp/test-output.log
```

### Waiting for test processes to finish

Typical durations:

| Scope | Typical time |
|-------|-------------|
| Single simple test | 15–30s |
| Single on-chain test | 30–60s |
| Full sim suite | 3–5 minutes |

### How to check pass/fail

```bash
# Summary of all test results:
./ct 2>&1 | rg "RUNNING TEST|ok|panic"
```

This gives you lines like:
```
RUNNING TEST test_play_calpoker_happy_path ...
test_play_calpoker_happy_path ... ok
RUNNING TEST some_failing_test ...
panic payload: tx include failed: ...
```

A test that shows `RUNNING TEST` but no `... ok` line (and instead has `panic`
lines) has failed.

### How to find panics in the output

**Critical:** The test runner uses `catch_unwind` to prevent panics from killing
the process. This means:
- A test can panic (fail) but the runner **continues** to the next test.
- The overall exit code is nonzero if any test panicked.
- **Always grep for `panic`** rather than trusting exit code alone.

Panic output looks like this in the log:
```
panic payload: tx include failed: move_number=10 tx_name=Some("false accept transaction") ...
   2: std::panicking::panic_with_hook
   ...
```

The `panic payload:` line has the actual error message.

### How to get targeted debug info without the spew

```bash
# Last 50 lines (usually shows the final result or panic):
tail -50 /tmp/test-output.log

# Specific debug lines:
rg "TIMEOUT|SET_STATE|panic" /tmp/test-output.log

# Trace both players' coin spent events:
rg "COIN-SPENT|THEIR_TURN|TIMEOUT|REDO" /tmp/test-output.log

# Trace unroll/preemption:
rg "CHANNEL_COIN_SPENT|PREEMPTION|UNROLL" /tmp/test-output.log

# Trace the redo mechanism:
rg "SET_STATE_FOR_COINS|GET_REDO|FINISH_REDO|DO_REDO" /tmp/test-output.log
```

### Test registration

Tests are registered in two places:
- `src/test_support/calpoker.rs` — `sim_tests()` function, calpoker-specific tests
- `src/simulator/tests/potato_handler_sim.rs` — notification tests, debug game tests, etc.

Tests are pushed into a `Vec` of `(name, closure)` pairs. To disable a test,
comment out the `res.push(...)` call.

## The Redo Mechanism (Forward-Only)

All state transitions are **forward-only**. There is no rewind logic. When a
game goes on-chain, the system either recognizes the game coin is at the latest
state, or it replays exactly one cached move via `RedoMove`.

### How set_state_for_coins works

After the unroll coin resolves (timeout or preemption), game coins are created.
`set_state_for_coins` matches each coin's puzzle hash:

1. **Coin PH == `cached_last_action.match_puzzle_hash`**: Needs redo. The game
   coin is at the state before our last move. Queue `RedoMove`.
2. **Coin PH == `last_referee_puzzle_hash`**: Latest state. No redo needed.
3. **Neither**: Error.

### Diagnostic output

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

### Diagnostic output

- `CHANNEL_COIN_SPENT: → preemption path` — preemption triggered
- `CHANNEL_COIN_SPENT: → timeout path` — waiting for timeout
- `PREEMPTION: old_sn=... unroll_sn=... preempt_source_sn=...`

## ResyncMove and Simulation Stalls

When a game coin is spent with redo data, `handle_game_coin_spent` emits
`Effect::ResyncMove`. The simulation loop responds by walking `move_number`
backward to find the last `Move` or `Cheat` action.

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

```bash
rg "SIM_RESYNC|simulation stalled|SIM_MOVE" /tmp/test-output.log
```

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
| `src/potato_handler/on_chain.rs` | `OnChainPotatoHandler`, `handle_game_coin_spent`, `coin_timeout_reached` |
| `src/simulator/tests/potato_handler_sim.rs` | Test infrastructure, `run_calpoker_container_with_action_list` |
| `src/test_support/calpoker.rs` | Calpoker-specific test setup and registration |

## Debugging Tips

### Process and output management

1. **Use `./ct` and `./cb`.** They handle feature flags and test ordering.

2. **Pipe through `tee` if you need to re-filter later.** Otherwise the direct
   output is fine — debug spew has been cleaned up.

3. **The first panic kills the rest of the test output.** Look at the tail of
   the output to find the relevant failure.

### Finding and interpreting failures

4. **Distinguish between the two players' output.** Debug lines from
   `on_chain.rs` are prefixed with `false` or `true` = `is_initial_potato()`.
   `false` = player 0 (Alice), `true` = player 1 (Bob).

5. **For `simulation stalled` panics**, the panic message includes
   `move_number`, `can_move`, and `next_action`. Check whether the next action
   is for the correct player and whether the redo changed the expected turn.

### Code-level debugging

6. **Add targeted `eprintln!()` calls** to the specific function you're
   investigating. Use a distinctive prefix (e.g., `MY_DEBUG:`) so you can
   grep for it. Remove after the issue is fixed.

7. **Trace the coin lifecycle** when debugging puzzle hash mismatches:
   - What puzzle hash was the coin created with?
   - What do `on_chain_referee_puzzle_hash()` and `outcome_referee_puzzle_hash()` return?
   - Did the coin go through the `Expected` or `Moved` path?
   - Was a redo triggered? Did the PH match?
   - Does `last_referee_puzzle_hash` match the coin PH?

### Mistakes to avoid

- **Don't use `head` to read test output** — early output is build noise.
- **Don't assume exit code 0 means all tests passed.** Always grep for `panic`.
- **Don't forget `2>&1`** when piping test output. Some output goes to stderr.
- **Don't run tests in the background.** Run `./ct` or `./cb` in the foreground
  and wait for them to finish. Background execution with sleep-based polling
  wastes time and makes output harder to capture.
