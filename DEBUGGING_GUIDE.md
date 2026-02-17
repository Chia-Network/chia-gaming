# Debugging & Testing Reference for chia_gaming

This document captures hard-won knowledge from debugging the calpoker on-chain
tests. It is intended as a reference for future sessions.

## Building and Running Tests

### Docker sim tests

All simulation tests run inside Docker via:

```bash
./docker-sim-tests.sh <filter>
```

- Pass a substring to filter tests: `./docker-sim-tests.sh piss_off_peer`
- Pass empty string for all tests: `./docker-sim-tests.sh ''`
- The script builds a Docker image and runs the test binary inside it.
- The build includes both Rust compilation and chialisp compilation (`build.rs`).

### Waiting for test processes to finish

The `docker-sim-tests.sh` command can take anywhere from 15 seconds (single test)
to 7+ minutes (full suite). `run-all-tests.sh` runs everything and takes ~7–8
minutes. **You must wait for it to complete.** Typical durations:

| Scope | Typical time |
|-------|-------------|
| Single simple test | 15–30s |
| Single on-chain test | 30–60s |
| Single piss_off_peer test | 15–60s |
| `test_play_calpoker_on_chain` (5 tests) | ~55s |
| `piss_off_peer` (5 tests, slash disabled) | ~55s |
| Docker sim full suite (`''`) | 5–8 minutes |
| `run-all-tests.sh` (everything) | ~7–8 minutes |

#### How to run long commands with the Shell tool

The Shell tool's `block_until_ms` parameter controls how long to wait for a
command to finish before backgrounding it. **Set this high enough to cover the
expected runtime** so the command completes inline and you get the exit code and
output immediately. Add buffer since `block_until_ms` includes shell startup
time.

**Good: Set `block_until_ms` to cover expected runtime**

```
Shell(command="./run-all-tests.sh 2>&1", block_until_ms=600000)
```

This blocks until the command finishes (up to 10 minutes), then returns the exit
code and output directly. No polling needed.

**Bad: `block_until_ms: 0` then sleep-and-poll**

Setting `block_until_ms: 0` immediately backgrounds the command, forcing you
into a loop of `sleep` + read terminal file to check for completion. This wastes
tokens, is unreliable, and can miss output.

**Bad: Piping through `tail` in a backgrounded command**

If a command gets backgrounded (either via `block_until_ms: 0` or by exceeding
the timeout), piping through `tail -N` is unreliable — `tail` buffers all
input until the upstream process closes, so the terminal file will show no
output until the very end, and may not capture the final flush at all.

#### Reading large output after completion

When the output is very large (e.g. debug-level test logs), the Shell tool
writes it to a file and returns the path. Use `Read` with a negative offset
to see the tail, or `Grep` to search for specific patterns like
`test result:`, `FAILED`, `error[`, or `Tests OK`.

### Reading test output — avoiding token waste

The debug logging from these tests is **extremely verbose** — tens of thousands
of lines of CLVM hashes, mempool updates, and state dumps. Reading the full
output is a waste of tokens and will overwhelm context.

**Rule: Never read the full output. Always filter.**

### How to check pass/fail

```bash
# Summary of all test results:
./docker-sim-tests.sh '' 2>&1 | grep -E 'RUNNING TEST|\.\.\.\ ok|panic'
```

This gives you lines like:
```
RUNNING TEST test_play_calpoker_happy_path ...
test_play_calpoker_happy_path ... ok
RUNNING TEST some_failing_test ...
panic payload: tx include failed: ...
panic: tx include failed: ...
```

A test that shows `RUNNING TEST` but no `... ok` line (and instead has `panic`
lines) has failed.

### How to find panics in the output

**Critical:** The test runner uses `catch_unwind` to prevent panics from killing
the process. This means:
- A test can panic (fail) but the runner **continues** to the next test.
- The overall exit code is nonzero if any test panicked, but a nonzero exit code
  alone doesn't tell you which test failed.
- A passing exit code (0) with panics in the output is impossible — but you must
  **always grep for `panic`** rather than trusting exit code alone, because you
  might misread which test failed.

Panic output looks like this in the log:
```
panic payload: tx include failed: move_number=10 tx_name=Some("false accept transaction") ...
   2: std::panicking::panic_with_hook
   ...
panic: tx include failed: ...
```

The `panic payload:` line has the actual error message. The `panic:` line at
the end repeats it after the backtrace. Either one is useful for grep.

### How to get targeted debug info without the spew

```bash
# Just the last 30 lines (usually shows the final result or panic):
./docker-sim-tests.sh test_name 2>&1 | tail -30

# Specific debug lines you added:
./docker-sim-tests.sh test_name 2>&1 | grep -E 'TIMEOUT|SET_STATE|panic'

# Trace both players' coin spent events:
./docker-sim-tests.sh test_name 2>&1 | grep -E 'game coin spent result|THEIR TURN MOVE|timeout coin|TIMEOUT'

# Just the puzzle hash debug from get_transaction_for_timeout:
./docker-sim-tests.sh test_name 2>&1 | grep -E 'TIMEOUT PUZZLE|TIMEOUT COIN|panic'
```

**Do NOT:**
- Read the full terminal file of a running/completed test
- Use `cat` or `read` on the terminal output file without offset/limit
- Pipe to `head` with a large number — most of the early output is docker build
  cache and rust doc indexing noise

### Test registration

Tests are registered in two places:
- `src/test_support/calpoker.rs` — `sim_tests()` function, calpoker-specific tests
- `src/simulator/tests/potato_handler_sim.rs` — `piss_off_peer_tests()` and others

Tests are pushed into a `Vec` of `(name, closure)` pairs. To disable a test,
comment out the `res.push(...)` call.

## Architecture: State Channels

### Coin lifecycle

```
funding tx -> channel coin -> unroll coin -> game coin(s)
```

1. **Channel coin**: Created by both players funding the channel. Spent by mutual
   agreement (both signatures) to create the unroll coin.
2. **Unroll coin**: Has a sequence number. Can be preempted by a higher sequence
   number from the opponent. When it "unrolls" (times out), it creates game coin(s).
3. **Game coin**: Curried with `RefereePuzzleArgs`. Can be spent by:
   - A **move** (advancing the game state, creating a new game coin)
   - A **timeout/accept** (ending the game, paying out rewards)
   - A **slash** (proving the opponent cheated)

### Going on-chain

When a player goes on-chain (`GameAction::GoOnChain` or error detection):
1. The channel coin is spent to create the unroll coin
   (`do_channel_spend_to_unroll` in `potato_handler/mod.rs`)
2. The unroll coin times out and creates game coin(s)
3. The game coin's puzzle hash comes from `puzzle_hash_for_unroll` — the last
   known state at the time of the unroll
4. `set_state_for_coin` rewinds the referee to match the game coin's puzzle hash
5. If moves need to be replayed, redo transactions are generated

### Key functions for going on-chain

- `PotatoHandler::do_channel_spend_to_unroll` — submits channel coin spend
- `ChannelHandler::get_channel_coin_spend_to_unroll_bundle` — builds the SpendBundle
- `ChannelHandler::compute_expected_unroll_coin` — predicts the unroll coin
- `ChannelHandler::set_state_for_coins` — aligns referee states with game coins
- `LiveGame::set_state_for_coin` — rewinds a single game's referee
- `Referee::rewind` — searches ancestor chain for matching state

## The Referee State Model

### Two key accessor methods

Every referee state has two sets of args:

- **`args_for_this_coin()`** = `create_this_coin` field — the args that were used
  to curry the puzzle of the "current" coin (for unroll purposes)
- **`spend_this_coin()`** = `spend_this_coin` field — the args that will be used
  to curry the puzzle of the coin created when the current coin is spent

### Puzzle hash methods

- **`on_chain_referee_puzzle_hash()`** = `curry_hash(args_for_this_coin())`
  — hash of the current coin's puzzle
- **`outcome_referee_puzzle_hash()`** = `curry_hash(spend_this_coin())`
  — hash of the next coin's puzzle (after a move)

### Off-chain vs on-chain semantics

**Off-chain**: `args_for_this_coin()` tracks what the unroll coin would create.
`puzzle_hash_for_unroll` is updated at each move to match. Everything stays in sync.

**On-chain after moves**: The actual coin's puzzle hash may correspond to
`outcome_referee_puzzle_hash()` rather than `on_chain_referee_puzzle_hash()`.
This is because on-chain moves create coins with the "next state" args, but
the referee's `create_this_coin` tracks the "unroll state" args.

**This mismatch was the root cause of the WRONG_PUZZLE_HASH errors.** The fix
(in `get_transaction_for_timeout`) checks the coin's actual puzzle hash against
both accessors and uses whichever matches.

### State transitions

```
MyTurn Initial
  -> make_move() -> TheirTurn AfterOurTurn
      args_for = current_puzzle_args (= MyTurn.spend_this_coin())
      spend    = new_puzzle_args (rc_puzzle_args)
      move_spend = OnChainRefereeMoveData { before_args, after_args }

TheirTurn AfterOurTurn
  -> their_turn_move_off_chain() -> MyTurn AfterTheirTurn
      args_for = old_args (= TheirTurn.spend_this_coin())
      spend    = referee_args (rc_puzzle_args)
      move_spend = inherited from TheirTurn.get_move_info()
```

### Ancestor chain

Each referee state has a `parent` field pointing to the previous state.
`generate_ancestor_list` traverses this chain. The `rewind` function searches
ancestors for a state whose `on_chain_referee_puzzle_hash()` matches a given
puzzle hash.

## On-Chain Move Processing

### `their_turn_coin_spent` (on-chain path)

Called when an on-chain game coin is spent. Two paths in `Referee::their_turn_coin_spent`:

1. **Expected** (in `referee/mod.rs`): The coin's puzzle hash matches
   the referee's current `on_chain_referee_puzzle_hash()`. This is the "redo replay"
   case — the move was already known from the off-chain state. Returns
   `TheirTurnCoinSpentResult::Expected` with the new coin's puzzle hash. The referee
   is returned unchanged (`self.clone()`).

2. **TheirTurn** (line ~448): The move is new (not in the ancestor chain). Delegates
   to `TheirTurnReferee::their_turn_coin_spent` which processes the move via
   `their_turn_move_off_chain`. Returns `TheirTurnCoinSpentResult::Moved` with the
   new coin string and puzzle hash.

### `on_chain_our_move`

Called when we need to replay our own move on-chain. Calls `internal_make_move`
(advancing the referee) then `get_transaction_for_move` (building the spend).

### `get_transaction_for_move`

Uses `move_spend.before_args` to reconstruct the puzzle of the coin being spent.
Uses `move_spend.after_args` (via `to_move()`) to compute the new coin's puzzle hash.

### `get_transaction_for_timeout`

Reconstructs the puzzle of the coin being spent for a timeout/accept. After the
fix, it checks the coin's puzzle hash against both `on_chain_referee_puzzle_hash()`
and `outcome_referee_puzzle_hash()` and uses whichever matches.

## Key Files

| File | Purpose |
|------|---------|
| `src/referee/mod.rs` | Core referee logic, `Referee` enum, dispatching |
| `src/referee/my_turn.rs` | `MyTurnReferee`, `make_move`, state transitions |
| `src/referee/their_turn.rs` | `TheirTurnReferee`, `their_turn_coin_spent`, `their_turn_move_off_chain` |
| `src/referee/types.rs` | `RefereePuzzleArgs`, `OnChainRefereeMoveData`, curry functions |
| `src/channel_handler/mod.rs` | `ChannelHandler`, `game_coin_spent`, `accept_or_timeout_game_on_chain` |
| `src/channel_handler/types/live_game.rs` | `LiveGame`, `set_state_for_coin`, wraps referee |
| `src/channel_handler/types/unroll_coin.rs` | Unroll coin puzzle/solution generation |
| `src/potato_handler/mod.rs` | `PotatoHandler`, handshake state machine, `do_channel_spend_to_unroll` |
| `src/potato_handler/on_chain.rs` | `OnChainPotatoHandler`, `handle_game_coin_spent`, `coin_timeout_reached` |
| `src/simulator/tests/potato_handler_sim.rs` | Test infrastructure, `run_calpoker_container_with_action_list` |
| `src/test_support/calpoker.rs` | Calpoker-specific test setup and registration |

## Common Errors and What They Mean

| Error | Meaning |
|-------|---------|
| `WRONG_PUZZLE_HASH (error 8)` | The puzzle provided to spend a coin doesn't hash to the coin's puzzle hash. Usually means the referee state is out of sync with the on-chain coin. |
| `MINTING_COIN (error 20)` | Trying to create a coin that already exists. Often benign (duplicate tx submission). The test harness tolerates this. |
| `simulation stalled` | The simulation loop hit `num_steps` limit without completing. Usually means a Shutdown action is missing or the game never finishes. |
| `ClvmErr(Raise(...))` | The chialisp program raised an error. In the slash context, this means the slash validation logic rejected something. |
| `shut_down without finishing handshake` | A Shutdown action was issued while the game was still in an on-chain transition state. The test harness defers shutdown actions until the handshake reaches a terminal state. |

## Known Issues (as of this writing)

- **`piss_off_peer_slash`**: Disabled. Fails with `ClvmErr(Raise(...))`. The
  on-chain slash logic needs debugging. The chialisp slash validation program
  rejects the slash evidence.

## Debugging Tips

### Process and output management

1. **Always pipe through grep or tail.** The raw output is 10k–100k+ lines.
   Reading it wastes tokens and gives you nothing useful. Filter first.

2. **Use `time` on every test command** so you know actual durations and can
   set better timeouts next time.

3. **Set generous `block_until_ms`** (600000 = 10 min) for test runs. The docker
   build step alone can take 2+ minutes on a cache miss.

4. **Don't poll terminal files with sleep loops.** Pipe the command directly
   with grep/tail and it will block until the process finishes naturally.

5. **After a code change, always `cargo build` locally first** before running
   docker-sim-tests. This catches compilation errors in seconds instead of
   minutes (docker rebuild is slow). The docker build will also compile, but
   local builds give faster feedback.

### Finding and interpreting failures

6. **Always grep for `panic` in every test run.** The catch_unwind mechanism
   means a test can panic, the runner prints the panic, and then continues to
   the next test and even exits 0 if the panicking test was the only one.
   Wait — actually, the runner does propagate the panic to the exit code. But
   the point stands: scan for `panic` to see WHICH test failed and WHY.

7. **The panic message is the key diagnostic.** Look for `panic payload:` or
   `panic:` lines. Common patterns:
   - `tx include failed: ... WRONG_PUZZLE_HASH` — referee state out of sync
   - `simulation stalled` — missing Shutdown or infinite loop
   - `should finish: ClvmErr(Raise(...))` — chialisp rejected something
   - `assertion failed` — a Rust assert in the test or game logic

8. **Distinguish between the two players' output.** Debug lines from
   `on_chain.rs` are prefixed with `false` or `true` = `is_initial_potato()`.
   `false` = player 0 (Alice), `true` = player 1 (Bob). When tracing a
   puzzle hash mismatch, you need to follow one player's perspective through
   the whole flow.

### Code-level debugging

9. **Add targeted `debug!()` calls** to the specific function you're
   investigating. Don't add broad logging — the output is already very verbose.
   Remove or reduce debug logging after the issue is fixed.

10. **Trace the coin lifecycle** when debugging puzzle hash mismatches:
    - What puzzle hash was the coin created with?
    - What do `args_for_this_coin()` and `spend_this_coin()` return?
    - Did the coin go through the `Expected` or `Moved` path?
    - Was `on_chain_our_move` called after?
    - Does the rewind find the correct ancestor?

11. **Test entry point**: `run_calpoker_container_with_action_list` is the
    main function for running calpoker simulation tests.

### Mistakes to avoid (learned the hard way)

- **Don't assume exit code 0 means all tests passed.** Always grep for `panic`.
- **Don't read full terminal output files.** They can be huge.
- **Don't use `head` to read test output** — the first 1000+ lines are docker
  layer caching and rust doc indexing, not test output.
- **Don't add sleep-based polling.** The pipe-and-wait pattern is simpler and
  more reliable.
- **Don't forget `2>&1`** when piping docker-sim-tests output. Some output
  goes to stderr.
