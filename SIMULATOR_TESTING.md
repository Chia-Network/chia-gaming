# Simulator Testing Reference

This document describes the Rust simulator test harness used by the
state-channel integration tests. It is a reference for test authors; debugging
workflow guidance stays in `DEBUGGING_GUIDE.md`.

## Key Files

| File | Role |
|------|------|
| `src/test_support/game.rs` | `GameAction`, `ProposeTrigger`, `ChannelHandlerGame`, and default test constants |
| `src/simulator/tests/potato_handler_sim.rs` | Simulation loop, test runner helpers, and most integration scenarios |
| `src/test_support/calpoker.rs` | Calpoker test helpers such as `prefix_test_moves` |
| `src/test_support/spacepoker.rs` | Space Poker test helpers |
| `src/test_support/debug_game.rs` | Debug game setup helpers for focused channel/on-chain tests |

## Debug Game

The debug game (`b"debug"`) is registered for tests only. It is not a
user-facing reference game. The game gives tests precise control over
`mover_share`, which makes channel and on-chain mechanics easier to exercise
without the complexity of a full game protocol.

`DebugGameTestMove::new(mover_share, slash)` creates a single-move game where
Alice moves and Bob must accept settlement. The `mover_share` value is what Bob,
the new mover after Alice's move, receives on timeout; Alice receives
`amount - mover_share`.

## Explicit Game IDs

`GameAction` variants reference games by explicit `GameID` values, not ordinal
positions in a test script. `GameID` values are deterministic nonces assigned
when proposing a game; each player's nonce counter increments independently.

Typical examples:

- `Move(player, game_id, readable, was_received)` moves in the specified game.
- `AcceptProposal(player, game_id)` accepts the proposal with that exact game ID.
- `AcceptSettlement(player, game_id)` accepts the current game result for that exact game
  ID (off-chain voluntary accept or on-chain timeout-claim intent).
- `ProposeNewGame(player, trigger)` creates a proposal; the resulting `GameID`
  is determined by the proposer's nonce counter at proposal time.

## ProposeTrigger

`ProposeNewGame` and `ProposeNewGameTheirTurn` carry a `ProposeTrigger`:

| Trigger | Fires when |
|---------|------------|
| `Channel` | The proposing player has observed channel creation. |
| `AfterGame(game_id)` | The given game ID has a terminal notification in either player's finished-game set. |

## GameAction Reference

The full `sim-tests` enum lives in `src/test_support/game.rs`.

| Action | Effect |
|--------|--------|
| `ProposeNewGame(player, trigger)` | Player proposes a new game with `my_turn = true` when the trigger fires. |
| `ProposeNewGameTheirTurn(player, trigger)` | Player proposes a new game with `my_turn = false` when the trigger fires. |
| `AcceptProposal(player, game_id)` | Player accepts a pending proposal. The sim loop handles this as a two-phase action because acceptance may need a potato round trip. |
| `CancelProposal(player, game_id)` | Player cancels a pending proposal. |
| `Move(player, game_id, readable, was_received)` | Submit a normal move for the specified game. The final boolean records whether the move was received. |
| `FakeMove(player, game_id, readable, sabotage_bytes)` | Submit a move with custom sabotage bytes for validation/error-path tests. |
| `Cheat(player, game_id, mover_share)` | Queue a move with invalid game data, leaving `mover_share` to the victim on timeout. |
| `AcceptSettlement(player, game_id)` | Accept the current game result for the specified game (off-chain or on-chain). |
| `GoOnChain(player)` | Player initiates unilateral on-chain resolution. |
| `WaitBlocks(n, players_bitmask)` | Farm `n` blocks. The bitmask controls whose coin reports are backlogged: 0 = nobody blocked, 1 = player 0, 2 = player 1, 3 = both. |
| `CleanShutdown(player)` | Initiate cooperative channel shutdown. |
| `ForceDestroyCoin(player, game_id)` | Inject a fake game-coin deletion to test error handling. |
| `ForceUnroll(player)` | Submit an unroll transaction using cached spend info while bypassing normal state checks. |
| `SaveUnrollSnapshot(player)` | Snapshot current unroll spend info for later stale-unroll testing. |
| `ForceStaleUnroll(player)` | Submit an unroll using a previously saved snapshot. |
| `NerfTransactions(player)` | Silently drop all outbound transactions for a player. |
| `UnNerfTransactions(replay)` | Stop dropping outbound transactions for everyone; replay or discard the backlog. |
| `UnNerfTransactionsFor(player)` | Stop dropping outbound transactions for a single player, leaving any other nerfed players and the shared backlog untouched. Lets one side win an on-chain race while the other stays nerfed. |
| `BlockCoinReports(player)` | Stop delivering watched-coin state changes to a player. |
| `UnblockCoinReports(replay)` | Resume watched-coin reports; replay or discard the backlog. |
| `NerfMessages(player)` | Silently drop all outbound peer messages for a player. |
| `UnNerfMessages` | Stop dropping outbound peer messages. |
| `CorruptStateNumber(player, new_state_number)` | Corrupt a player's local state number for edge-case testing. |
| `InjectRawMessage(player, bytes)` | Inject raw inbound bytes to test message validation. |
| `SelfAcceptProposal(player, game_id)` | Force a self-accept by bypassing local parity checks and sending `AcceptProposal` for the player's own game ID. |
| `WrongParityProposal(player)` | Tamper an outbound proposal so it uses a game ID with the wrong parity, testing receiver-side rejection. |
## Sim Loop Mechanics

Each iteration of the sim loop:

1. Farms a block and builds a `WatchReport` from the new coin set.
2. Flushes and dispatches for each player in order, player 0 then player 1.
3. Delivers outbound messages to the other player's inbound queue.
4. Dispatches notifications to `LocalTestUIReceiver`.
5. Processes the next scripted action if its trigger condition is satisfied.

Because flushing happens in fixed order, a message sent by player 1 takes one
extra iteration to reach player 0 compared to the reverse direction. This is
expected; event-driven triggers wait for the notifications that make an action
ready instead of relying on fixed iteration counts.

## Strict Mode: Why Double-Submission Fails Tests

The simulator runs in a **strict mode** that `panic!`s instead of returning a
soft error when a transaction can't be included. The triggers are in
`Simulator::push_transactions` (`src/simulator/mod.rs`): a rejected spend
bundle, spending a coin that is already spent or not found, a violated
`ASSERT_HEIGHT_RELATIVE` / `ASSERT_BEFORE_HEIGHT_ABSOLUTE` timelock, an
undeclared fee, and -- the one test authors hit most often -- **two different
transactions in the mempool that spend the same coin** ("conflicting
transactions in mempool").

### This is a deliberate fail-fast, not real-chain behavior

On a real blockchain, two parties broadcasting transactions that spend the same
coin is normal and harmless. It happens routinely when a peer misbehaves, when
the two sides are temporarily disconnected, or simply when both independently
decide to go on chain at once. The chain resolves it for free: only one spend of
a given coin can ever be confirmed, and the other is rejected. The protocol is
designed to tolerate this.

Strict mode intentionally turns that harmless situation into an immediate test
failure. The goal is to surface as many problems as possible: an unexpected
conflict almost always means a bug worth investigating (e.g. a transaction being
resubmitted from a stale intent, or a coin being spent down two paths at once).
Failing loudly at the exact point of conflict is far easier to debug than
chasing a divergent outcome many blocks later. In non-strict mode the same code
path returns a graceful `code: 3 / e: 9` rejection, mirroring the real chain --
but tests run strict.

### What is and isn't a conflict

- **Identical resubmission is fine.** A bundle with the same fingerprint as one
  already in the mempool is de-duplicated (`code: 1`), so a party rebroadcasting
  its *own* transaction every block (see the `TransactionManager` resubmission
  loop in `INTERNALS.md`) never trips strict mode.
- **The real invariant** strict mode helps protect is that a single party must
  never put two *different* competing transactions on chain itself -- for
  example, holding a good clean-shutdown transaction and *also* trying to
  unroll. That is a genuine bug; cross-party competition is not.

### The opt-out: nerf the loser

Because cross-party conflicts are legitimate, a test that drives both sides
toward spending the same coin must decide which side is "supposed to win" and
nerf the other with `NerfTransactions`. Some common patterns:

- When a test forces a specific spend on chain with `ForceUnroll` /
  `ForceStaleUnroll`, keep *both* managers' transactions nerfed across the race
  so the forced spend is the sole spend of that coin, then `UnNerfTransactions`
  / `UnNerfTransactionsFor` once it has landed (its input coin is now spent, so
  the manager's rebroadcast of any competing spend is gated off).
- Use `UnNerfTransactionsFor(player)` when only one side should resume
  submitting -- e.g. the winner still needs to submit a follow-up timeout claim
  while the loser only observes. `UnNerfTransactions` clears the nerf for
  everyone at once and would re-open the conflict.
- Remember that nerfing a player's transactions does not stop its coin reports:
  a nerfed player still *observes* the on-chain spend and reacts to it, which is
  exactly what exercises opponent-spend detection.

## Event-Driven Triggers

The sim loop advances `move_number` only when the next action's trigger
condition is satisfied.

| Trigger function | Fires when | Used by |
|------------------|------------|---------|
| `move_ready` | `game_accepted_ids` or `opponent_moved_in_game` contains the game ID for the moving player. | `Move`, `FakeMove` |
| `accept_proposal_ready` | Phase 1: proposal received. Phase 2: accept resolved. | `AcceptProposal` |
| `propose_ready` | `Channel` or `AfterGame(game_id)` trigger has fired. | `ProposeNewGame`, `ProposeNewGameTheirTurn` |
| `global_move` | Always ready. | `GoOnChain`, `WaitBlocks`, `AcceptSettlement`, `CleanShutdown`, fault injection |
| `can_move` | Set only after resync. | Resync path |

`LocalTestUIReceiver` tracks the event state used by these triggers:
`received_proposal_ids`, `game_accepted_ids`, `opponent_moved_in_game`,
`game_finished_ids` (populated when `GameSettled` arrives), `accepted_proposal_ids`, and `channel_created`.

## Two-Phase AcceptProposal

`AcceptProposal` is asynchronous. Calling `accept_proposal` queues the accept,
but balance checks and game creation happen only when the player holds the
potato. If the player does not have the potato, the handler sends
`RequestPotato` and waits.

The sim loop handles this in two phases:

1. Phase 1 calls `accept_proposal` once the proposal is received, records the
   game ID in `accepted_proposal_ids`, and leaves `move_number` unchanged.
2. Phase 2 advances the script once `ProposalAccepted`, `InsufficientBalance`,
   or `ProposalCancelled` appears for that game ID.

## Writing a Test

1. Build a `Vec<GameAction>` using explicit `GameID` values for variants that
   require them.
2. Explicitly `ProposeNewGame` and `AcceptProposal` to start a game; the sim
   loop does not auto-propose or auto-accept.
3. Call `run_calpoker_container_with_action_list`,
   `run_game_container_with_action_list_with_success_predicate`, or another
   helper appropriate for the scenario.
4. Inspect the returned `GameRunOutcome` for notifications, balances, and
   events.
5. Register the test in the relevant `test_funs()` list.

`prefix_test_moves(allocator, game_id)` returns the five hardcoded Calpoker
moves for the given `GameID`. It only works for the first game in a
deterministic-seed run; subsequent games produce different cards, so use timeout
or other resolution strategies.

## Stall Detection

The sim loop panics after 200 iterations with a diagnostic message including
`move_number`, `can_move`, and the next pending action. If a test stalls, check
whether the trigger condition for the next action can ever be satisfied.

`NerfTransactions`, `NerfMessages`, and `BlockCoinReports` are useful for
asymmetric scenarios, but remember that they block different surfaces:
transactions, peer messages, and watched-coin reports respectively.
