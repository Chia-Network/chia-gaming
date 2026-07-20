# On-Chain Resolution

For the conceptual overview (state channels, coin hierarchy, potato protocol),
see `OVERVIEW.md`. For off-chain game proposals and flow, see
`GAME_LIFECYCLE.md`. For CLVM denial-of-service analysis (execution cost caps,
solution constraints, trust categories), see `CLVM_DOS.md`.

## Table of Contents

- [Going On-Chain: Dispute Resolution](#going-on-chain-dispute-resolution)
- [Clean Shutdown (Advisory)](#clean-shutdown-advisory)
- [Preemption](#preemption)
- [Stale Unroll Handling](#stale-unroll-handling)
- [Zero-Reward Early-Out](#zero-reward-early-out)
- [The Referee](#the-referee)
  - [Referee Puzzle Args](#referee-puzzle-args)
  - [On-Chain Referee Actions](#on-chain-referee-actions)
  - [Referee State Model](#referee-state-model)
  - [Reward Payout Signatures](#reward-payout-signatures)
  - [Off-Chain Validation and Initial State](#off-chain-validation-and-initial-state)
  - [ValidationInfoHash and the Initial Sentinel](#validationinfohash-and-the-initial-sentinel)
- [On-Chain Game State Tracking (our_turn)](#on-chain-game-state-tracking-our_turn)

---

## Going On-Chain: Dispute Resolution

When something goes wrong (opponent offline, invalid move detected, explicit
`GoOnChain` action), the off-chain `OffChainPhase` — which manages the potato
protocol, peer messages, and batch exchanges — is effectively done. A
fundamentally different component, `OnChainPhase`, takes over. It is
driven entirely by blockchain coin-watching events (coin created, coin spent,
timeout reached) rather than peer messages. The `OffChainPhase` creates an
`SpendChannelCoinPhase` replacement, which in turn creates the
`OnChainPhase`. At that point all game actions (moves, `AcceptSettlement`) are routed to the
on-chain handler. It maintains its own `game_map` tracking each game coin's
state. There is no potato, no batching, no turn-taking — just monitoring the
blockchain and submitting transactions in response to what it sees.

### Unified Path

A key design principle is that **self-initiated and opponent-initiated on-chain
transitions follow the same code path**. When a player calls `go_on_chain`, it
builds and submits a channel coin spend from `last_channel_coin_spend_info` and sets a flag to stop
sending peer messages — but from that point on, the actual state machine
progression is driven entirely by **coin-watching events**. The player detects
its own channel coin spend the same way it would detect the opponent's: by
observing the coin disappear from the blockchain. This means there is no
separate "I started this" vs "they started this" logic for the state
transitions themselves.

### Step 1: Channel → Unroll

`go_on_chain` builds a `SpendBundle` from `last_channel_coin_spend_info`
(a `ChannelCoinSpendInfo` containing the solution, conditions, and aggregate
signature). This info is updated by `update_channel_coin_after_receive` on
every potato exchange, so it always reflects the latest co-signed state.
The spend creates the unroll coin on-chain.

When the channel coin spend is detected (by either player), a `ChannelStatus`
notification with state `Unrolling` is emitted and the state number of the
unroll is extracted from the on-chain conditions.

### Step 2: Preempt or Wait

The player compares the on-chain unroll state number against their own latest
state to decide whether to preempt or wait for the timeout path (see
[Preemption](#preemption)). Both outcomes produce the same result: the unroll
coin is spent, creating game coins and reward coins.

When the unroll coin spend is detected, a `ChannelStatus` notification with
state `ResolvedUnrolled` (or `ResolvedStale` if the unroll was stale) is
emitted.

### Step 3: Forward-Align State

`ChannelState::set_state_for_coins` matches each created game coin's puzzle
hash against known states. It searches both `live_games` and
`pending_settlements` (see [AcceptSettlement Lifecycle](GAME_LIFECYCLE.md#acceptsettlement-lifecycle)). All
state tracking is **forward-only** — there is no rewind logic. Two cases:

1. **Coin PH matches `last_referee_puzzle_hash`** (the outcome/post-move PH):
  The game coin is at the latest known state. `our_turn` is set based on
   `is_my_turn()`. No redo needed.
2. **Coin PH matches a `cached_redo_actions` entry's `match_puzzle_hash`**: The
  game coin is at the state *before* our cached move. A redo is needed to
   replay that move on-chain (see [Redo Mechanism](INTERNALS.md#cached_redo_actions-and-the-redo-mechanism)).

Games that existed off-chain but don't match any created coin are reported as
`GameError` (these were accepted games that should have appeared on-chain).

The state created by the unroll is not always the most advanced state known to
the potato protocol.  If our last potato action has not round-tripped, the
virtual game may be one step ahead locally while the latest mutually signed
unroll can only materialize the previous version on-chain.  Redo is the bridge
between those views: replay the cached last move on-chain, then continue from
the actual coin the chain created.

### Step 4: Redo (if needed)

If the game coin landed at the pre-move state, the redo transaction is emitted
immediately during `finish_on_chain_transition` — before the `OnChainPhase`
is created. For each game with a cached move, the code temporarily restores the
referee to the post-move state, generates the spend transaction, and inserts a
`PendingMoveSavedState` entry into the handler's `pending_moves` map. The
`OnChainPhase` never distinguishes between redo transactions and fresh
moves; it just tracks pending spends per game coin and reconciles them when
on-chain confirmation arrives.

### Step 5: Timeout Resolution

Timeout resolution is split into two decoupled halves: **eager submission** of
the timeout claim, and **confirmation-driven** notification when a spend is
actually observed. There is no longer a maturity callback (`coin_timeout_reached`
has been removed); reaching the timelock no longer triggers a spend or a
notification directly.

**Eager submission.** When a game coin is registered with the wallet (via
`register_initial_game_coins`), the handler pre-builds the timeout claim with
`build_timeout_claim` and attaches it to the `Effect::RegisterCoin`'s
`spend: Option<SpendBundle>`. `build_timeout_claim` returns the bundle **only
when the timeout transaction pays us** (the spend creates a coin to our reward
puzzle hash); otherwise it returns `None` and nothing is submitted on our
behalf. The `TransactionManager` then becomes the **sole submitter**: it tracks
each coin's reorg-aware birthday and submits the stored claim once the coin
reaches `birthday + game_timeout`, resubmitting across reorgs (see
[Eager Timeout Submission](INTERNALS.md#eager-timeout-submission-and-confirmation-driven-notifications)).
Handlers never build or submit timeout transactions at maturity.

**Confirmation-driven notification.** Terminal notifications are emitted from
`handle_game_coin_spent` (reached via the `coin_spent` → `coin_puzzle_and_solution`
pipeline) when the game coin's *actual* spend is observed, by interpreting what
the spend created:

- **Our timeout claim confirmed** (spend pays our reward puzzle hash): settlement
  confirmed in our favor — `GameSettled` with an outcome such as `we_accepted`,
  `settled_cleanly`, `slashed_opponent`, or a forfeit variant when `our_share`
  is zero (see [settlement glossary](NAMING_AUDIT.md#settlement-glossary-ux)).
- **Opponent moved/claimed** (spend pays *their* reward puzzle hash): in the
common case our eager claim simply never confirms because the opponent spent
the coin first (a normal move advances the game; a timeout claim against our
pending move yields `GameSettled { outcome: opponent_timed_out }` or
`attempt_to_move_failed`; a timeout claim while we were attempting to slash
yields `opponent_cheated`).

Because notification rides the observed spend rather than the timelock, the
expected "opponent moved instead of timing out" case requires no special
handling — our unconfirmed claim is just dropped and the game advances.

**Accepted games** (`accepted == true`, set by an `AcceptSettlement` action): the
off-chain/on-chain accept only records intent. The eager **timeout claim** is
registered like any other, and `GameSettled` is emitted when the resulting
reward-coin spend is observed — not at accept time.

**Zero-reward skip**: when the timeout would not pay us, `build_timeout_claim`
returns `None`, so the manager submits nothing (avoiding a pointless fee). The
terminal status still resolves from the observed spend: the opponent claims
their reward, and we notify off their confirmed spend.

### Step 6: Clean Shutdown

After all games resolve, a `ChannelStatus` with state `ResolvedClean` is
emitted and the channel can be closed.

**Key code:**

- `src/session_phases/mod.rs` — `go_on_chain`
- `src/session_phases/spend_channel_coin_phase.rs` — `handle_channel_coin_spent`,
`finish_on_chain_transition`
- `src/session_phases/on_chain.rs` — `OnChainPhase`,
`build_timeout_claim`, `register_initial_game_coins`, `handle_game_coin_spent`
- `src/transaction_manager.rs` — `TransactionManager` (eager claim submission)
- `src/channel_state/mod.rs` — `set_state_for_coins`, `game_coin_spent`

---

## Clean Shutdown (Advisory)

Clean shutdown is the cooperative channel closure path: both players agree to
spend the channel coin directly to reward coins, bypassing the unroll/game-coin
mechanism entirely.

### Preconditions

Clean shutdown requires that **no games are active** (`has_active_games()` is
false). The initiator's `drain_queue_into_batch` enforces this — attempting
`CleanShutdown` with active games is an error. Any pending proposals are
cancelled automatically before the shutdown signature is produced.

On the receiver side, if the batch carries `clean_shutdown` but the receiver
still has active games (e.g., due to a misbehaving peer), the receiver
immediately goes on-chain instead of cooperating.

### Protocol Exchange

1. The initiator includes `clean_shutdown: Some((half_sig, conditions))` in
  their next `Batch` message. The half-signature signs the channel coin spend
   to reward conditions (each player's balance goes directly to their reward
   puzzle hash, with no game coins). The `clean_shutdown` field is separate
   from the `actions` list, so it is structurally processed after all actions
   on the receive side. The initiator remains in `OffChainPhase` after sending
   this batch — it does **not** transition to `SpendChannelCoinPhase` yet.
   While waiting for the response, `OffChainPhase` rejects any peer message
   other than `CleanShutdownComplete` as a protocol violation (triggering
   go-on-chain).
2. The responder receives the batch, processes any actions, then combines the
  initiator's half-signature with their own to produce a complete `CoinSpend`.
   They reply with `PeerMessage::CleanShutdownComplete(coin_spend)` — a
   standalone message outside the normal potato flow. The responder transitions
   to `SpendChannelCoinPhase` immediately (it already has the complete spend).
3. The initiator receives `CleanShutdownComplete`, submits the transaction,
   and transitions to `SpendChannelCoinPhase`. Either side can submit the
   completed spend on-chain; duplicate submissions are harmless.

### Assumes Single-Handing

The current implementation assumes **single-handing** (at most one outstanding
proposal at a time). Under this assumption, when the user requests a clean
shutdown, there is never a pending proposal that could interfere — the shutdown
batch is the only thing queued. This allows the front-end to immediately report
`ShuttingDown` status, and allows `OffChainPhase` to reject any unexpected
peer messages while waiting for `CleanShutdownComplete`.

In a future **multi-handing** model, the initiator might have outstanding
proposals when the user requests a shutdown. Those proposals would need to
resolve (accepted, rejected, or cancelled) before the shutdown batch can be
sent. This means:

- The `ShuttingDown` status could not be emitted immediately — the system
  would still be processing proposals.
- The message-rejection guard in `OffChainPhase` (which currently rejects
  everything except `CleanShutdownComplete`) would need to also accept
  proposal-resolution messages during the wind-down phase.
- The precondition check (`has_active_games()`) would need to account for
  proposals that are still in flight.

This is noted here as a future design consideration — the current code is
correct for single-handing.

### Why "Advisory" — Race Handling

Clean shutdown is **advisory, not authoritative**. Both players produce the
same transaction (spending the channel coin directly to reward coins), so
duplicate submissions between them are harmless. The real race is between the
clean shutdown transaction and an **unroll transaction** — either side might
initiate an unroll (via `go_on_chain`) around the same time. Both spend the
channel coin, so only one can land on-chain.

Because of this, the system never blindly trusts that the clean shutdown
landed. When `SpendChannelCoinPhase` is created for the clean shutdown
path, it stores the exact on-chain solution (`ProgramRef`) that was
co-signed for the shutdown.  When the channel coin spend is detected, the
handler compares the on-chain solution directly against the stored one:

1. **Clean shutdown landed:** The on-chain solution matches the expected
   solution byte-for-byte.  The handler emits `ChannelStatus` with state
   `ResolvedClean`.
2. **An unroll landed instead:** The solution does not match.  The handler
   runs the puzzle to extract conditions, then matches `CREATE_COIN` puzzle
   hashes against the `unroll_puzzle_hash_map` to identify which unroll
   state landed.  Since no games are active, the unroll creates only reward
   coins; `finish_on_chain_transition` finds an empty game map and
   transitions to `OnChainPhase`. The outcome is the same correct
   balances, just with more on-chain transactions.

### Griefing Bound

A malicious peer could craft a clean shutdown conditions list that includes
unrecognized opcodes (timelocks, announcements, etc.) alongside the valid
`CREATE_COIN` outputs. The victim's condition parser only checks that the
expected payout exists; it does not reject unknown opcodes.

This is a **griefing vector bounded to time and transaction fees**, not a
fund-safety issue, for two reasons:

1. **CLVM conditions are additive.** In Chialisp, conditions are a flat list
  of outputs and assertions. A `CREATE_COIN` output cannot be cancelled,
   reduced, or redirected by any other condition in the same spend. The only
   effect of additional conditions is to make the *entire spend fail* (e.g. an
   unsatisfied timelock prevents the transaction from being mined). No
   condition can selectively remove or modify another condition's output.
2. **The unroll fallback always exists.** If the clean shutdown spend fails to
  land (because the attacker's extra conditions prevent mining), both sides
   fall back to the unroll path. The unroll path produces the same correct
   balance split — it just costs more time (unroll timeout + game timeouts)
   and more transaction fees. The attacker pays the same cost.

Reward payout destinations are separately protected by `AGG_SIG_UNSAFE`
signatures exchanged during the handshake (see
[Reward Payout Signatures](#reward-payout-signatures)), so the attacker
cannot redirect the victim's share to a different address.

### Key Code

- `src/session_phases/mod.rs` — `pending_clean_shutdown` field,
  `drain_queue_into_batch` (stores shutdown metadata),
  `process_queued_message` (receives `CleanShutdownComplete` and creates
  `SpendChannelCoinPhase`)
- `src/session_phases/spend_channel_coin_phase.rs` —
  `handle_channel_coin_spent`, `handle_unroll_from_channel_conditions`

---

## Preemption

Preemption is the mechanism that prevents stale unrolls from succeeding. When
a player sees the channel coin being spent to an unroll coin, they compare the
on-chain sequence number against their own latest state:


| On-chain SN vs ours | Action                  | Explanation                                                                         |
| ------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| On-chain < ours, opposite parity | **Preempt** (immediate) | Spend the unroll coin immediately with our higher SN and more up-to-date conditions |
| On-chain < ours, same parity | **Wait for timeout** | The parity rule forbids our latest state from preempting this coin; use its compact historical timeout record |
| On-chain == ours    | **Wait for timeout**    | The unroll is at the state we expect; wait for it to resolve                        |
| On-chain > ours     | **Error**               | We've been hacked or something went very wrong                                      |


Preemption is **immediate** — no timelock. This is by design: the preempting
player gets first-mover advantage because they're correcting an out-of-date
unroll. Timeouts require waiting for `unroll_timeout` blocks.

### After Preemption or Timeout

(See the **Parity rule** in the [Unroll Coin](OVERVIEW.md#unroll-coin) section for why only the
opponent can preempt a given unroll.)

Regardless of which path resolved the unroll coin, the result is the same: game
coins and reward coins are created. The game code then uses
`set_state_for_coins` to determine if a redo is needed (see Step 3 above).

**Key code:** `src/channel_state/mod.rs` — `channel_coin_spent`,
`make_preemption_unroll_spend`

## Stale Unroll Handling

When preemption fails (e.g. the preemption transaction is not mined in time)
and the opponent's stale unroll succeeds via timeout, the system enters
**stale unroll handling** rather than treating it as an unrecoverable error.

### Staleness Detection

Staleness is determined by comparing the `on_chain_state` (the sequence
number retrieved from the compact `unroll_puzzle_hash_map` record when the
on-chain `CREATE_COIN` puzzle hash is matched) against the latest received
unroll's state number from `ChannelState`.

The map retains every historical unroll puzzle hash because old does not mean
unspendable: the opponent may still broadcast any earlier unroll carrying the
signatures collected at that time. The durable minimum per hash is the state
number, committed conditions hash, and timeout conditions. Historical full
signatures and preemption conditions are unnecessary because preemption always
uses the latest full record. The browser preserves this compact map inside the
raw binary cradle stored in IndexedDB.

The latest received unroll state number comes from
`self.latest_received_unroll.as_ref().map(|t| t.coin.state_number)`, and
staleness is computed as:

`is_stale = latest_received_state.is_some_and(|t| on_chain_state + 1 < t)`


| Condition                                                                        | Classification                                     |
| -------------------------------------------------------------------------------- | -------------------------------------------------- |
| `timeout_state_number()` is `None`, or `on_chain_state + 1 >= timeout_state_number()` | **Current or Redo** — use existing logic           |
| `on_chain_state + 1 < timeout_state_number()`                                   | **Stale** — opponent unrolled to an outdated state |


This means staleness is judged relative to the local timeout snapshot state,
not from a separate `last_received_state` tracker.

### Dispatch in `finish_on_chain_transition`

Current and redo states use the normal on-chain flow described above (Steps
3–5).  When the state is **stale**, `finish_on_chain_transition` takes a
different path:

- A `ChannelStatus` notification with state `ResolvedStale` is emitted,
reporting the actual amount in our reward coin (found by scanning the unroll
output conditions for our reward puzzle hash).
- Each on-chain game coin is matched against live games and pending accepts
by puzzle hash **and** amount:
  - If `coin_ph == live_game.last_referee_puzzle_hash` and amounts match →
  game is alive at its current state.
  - If `coin_ph` matches a `cached_redo_actions` entry's
  `match_puzzle_hash` for the same game and amounts match → game needs a
  redo move.
  - Otherwise → `GameError` (the coin is present but we can't identify what
  state it's in).
- Games not found in the unroll outputs receive one of two notifications
depending on whether the game was fully established or still in-flight:
  - `**EndedCancelled`** — the game was a recently accepted proposal whose
  potato round-trip hadn't completed (tracked as a `ProposalAccepted`
  entry in `cached_redo_actions`). The opponent hadn't acknowledged the
  accept when they published the stale unroll, so the game coin never
  existed in that state. The accept was simply rolled back.
  - `**GameError`** — the game was an established live game (its accept
  was acknowledged by a complete round-trip) that should have been
  present in the unroll but wasn't. This indicates genuinely adversarial
  or buggy behavior.
- The channel handler does **not** enter `Failed` state; remaining games
continue on-chain.

### Why Stale Coins Are Not Recovered

When a game coin appears in the stale unroll outputs but at an older state
than what was played off-chain, the system treats it as a terminal error
rather than attempting to resume the game from the stale state. This is
intentional for several reasons:

1. **Rarity.** This can only happen when you're having trouble posting
  transactions (preemption failed, your timeout was too slow, etc.). In
   that situation you're likely unable to transact reliably anyway.
2. **Opponent divergence.** If the game were resumed from the stale state,
  the opponent could play a *different* move than they did off-chain. The
   code logic and UX for handling that divergence (re-validating a
   different move history, surfacing "they changed their move" to the
   player) are complex and error-prone.
3. **One terminal condition.** The current approach guarantees exactly one
  terminal event per game — either the game was matched and continues
   normally, or it gets a `GameError`/`EndedCancelled`. There is no
   ambiguous middle state where a game is "maybe recoverable."

### Notifications


| Notification                                     | When                                                                                     |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| `ChannelStatus { state: ResolvedStale, ... }`    | Always emitted when `is_stale` is true; balances reflect the actual unroll outcome       |
| `GameError { id, reason }`                       | Per-game: coin present but unrecognizable, or established live game missing from outputs |
| `EndedCancelled { id }`                          | Per-game: pending accept (in-flight) absent from outputs — the accept was rolled back    |


**Key code:** `src/session_phases/spend_channel_coin_phase.rs` —
`finish_on_chain_transition`, `src/channel_state/mod.rs` —
`set_state_for_coins`

---

## Zero-Reward Early-Out and Auto-Accept

When our share of a game is zero, there is no reason to wait for on-chain
timeouts, submit transactions, or perform redo moves — those operations cost
time and transaction fees for no reward.  In these cases the system immediately
emits `GameSettled { our_share: 0, outcome: … }` (a forfeit outcome from the
[settlement glossary](NAMING_AUDIT.md#settlement-glossary-ux)) and removes the
game from tracking.

Conversely, when our share is the full game amount or the game is terminal with
a positive share, there is no reason to make another move — the best possible
outcome is already available via timeout.  In these cases the system
auto-accepts: it queues an `AcceptSettlement` action and marks the game as
`game_finished = true`, triggering a clean end.

### Rationale

1. **No rational incentive (zero reward).**  When our share is zero the
  opponent has nothing to gain by playing (they already have everything) and
   we have nothing to claim.  Waiting for a timeout is pure overhead.
2. **Optimal outcome already reached (auto-accept).**  When we get 100% on
  timeout or the game is over and we get a positive share, making a move can
   only decrease our share or cost fees for no benefit.
3. **Avoids unnecessary transactions.**  Submitting a redo move or timeout
  claim that yields zero reward wastes block space and fees.
4. **Clean terminal signal.**  The UX immediately learns the game settled,
  rather than waiting many blocks for a timeout that produces nothing.

### Auto-Accept Detection

`should_auto_settle(game_id, is_my_turn)` returns true when:

- `is_my_turn` is true, AND
- `our_share == game_amount` (claim — we get 100%), OR
- `is_game_over() && our_share > 0` (terminal clean end — game is finished
  and we get a positive share).

When both conditions are true (game is over AND our share is the full
amount), the result is the same: auto-accept fires.

Auto-accept detection runs at two sites in `handle_game_coin_spent`:

1. **`Expected` path** — opponent moved or a timeout confirmed, creating a
  new game coin.  If the new coin is our turn and auto-accept triggers, the
   game is marked `game_finished = true` and `AcceptSettlement` is queued.
2. **`Moved` path** — opponent made a move that advances the game.  Same
  auto-accept check as the Expected path.

`build_timeout_claim` is self-gating: it returns `None` when the timeout
transaction would not pay us (our reward puzzle hash is absent from the
spend's output conditions).  This means timeout claims are only registered
for coins where the timeout actually benefits us — no explicit skip logic is
needed for our-turn coins where the timeout favors the opponent.

### Zero-Reward Trigger Points

The zero-reward early-out fires at five distinct points.

**At unroll completion** (scanned in `finish_on_chain_transition` right after
`set_state_for_coins` populates the `game_map`):

1. **Pending redo with zero reward.**  A move was sent off-chain but the
  potato hadn't come back.  The unroll lands at the pre-move state and a redo
   is queued.  If the post-redo `our_current_share` would be zero, the redo is
   skipped and `GameSettled { outcome: forfeited_skipped_reveal, our_share: 0 }`
   fires.  Checked via `is_redo_zero_reward()`.
2. **Pending AcceptSettlement with zero share.**  An `AcceptSettlement` was called
  off-chain but the potato round-trip hadn't completed.  The coin matches via
   `pending_settlements` with `timeout_claim_armed = true`.  If our share is zero,
   `GameSettled { outcome: forfeited_we_accepted, our_share: 0 }` fires
   immediately instead of waiting for the on-chain timeout.
3. **Opponent's turn, mover_share == coin_amount.**  The move was
  acknowledged (no redo needed).  It's the opponent's turn and
   `mover_share == coin_amount`, meaning the opponent gets everything on
   timeout and has no incentive to move.  `GameSettled { outcome: forfeited_opponent_won, our_share: 0 }`
   fires.  This only applies when it's the opponent's turn — when it's our turn
   and `mover_share == coin_amount`, *we* get everything and auto-accept fires
   instead (see above).

**During on-chain play** (action requested by UX):

4. **On-chain move would produce mover_share == coin_amount.**  In
  `do_on_chain_move`, after computing the move result, if the new
   `mover_share == game_amount` (we as the new waiter get zero), the move is
   not submitted and `GameSettled { outcome: forfeited_skipped_reveal, our_share: 0 }`
   fires. This applies to terminal moves too: if playing the terminal move gives
   the opponent everything, we have no reward to claim and no incentive to spend
   fees or reveal more state. Games that need to prevent a player from
   withholding a losing terminal move must encode that incentive in the prior
   state's `mover_share`.
5. **On-chain AcceptSettlement with zero share.**  In `do_on_chain_action`'s
  `AcceptSettlement` handler, if `get_game_our_current_share() == 0`, the game
   is removed and `GameSettled { outcome: forfeited_we_accepted, our_share: 0 }`
   fires instead of building a timeout claim.

### AcceptSettlement Handler

The `AcceptSettlement` handler covers three cases:

1. **Zero share (forfeit):** `our_share == 0` — game is removed,
  `GameSettled { outcome: forfeited_we_accepted, our_share: 0 }` is emitted.
  No timeout claim is built.
2. **Nonzero share (voluntary accept or auto-accept):** The handler builds a
  **timeout claim** via `build_timeout_claim` and registers it with the wallet
  (via `RegisterCoin`) for submission at maturity.  When the claim confirms,
  `GameSettled` arrives with `we_accepted` or `settled_cleanly`.
3. **Not our turn:** The handler marks `timeout_claim_armed = true` (the
  timeout claim was already registered eagerly at coin registration time).

### Already handled (no new code)

Off-chain `AcceptSettlement` with zero reward is already handled by
`drain_cached_accept_settlements` in `src/channel_state/mod.rs`, which emits
`GameSettled { outcome: accept_settlement, our_share }` with whatever share
amount applies, including zero.

**Key code:** `src/session_phases/spend_channel_coin_phase.rs` —
`finish_on_chain_transition` (unroll scan),
`src/session_phases/on_chain.rs` — `should_auto_settle`, `do_on_chain_move`
(scenario 4), `do_on_chain_action` (scenario 5),
`build_timeout_claim`, `register_initial_game_coins`,
`src/channel_state/mod.rs` — `is_redo_zero_reward`,
`get_game_our_current_share`, `get_game_amount`

---

## The Referee

The referee is the on-chain puzzle that enforces game rules. Each game coin is
curried with `RefereePuzzleArgs` that encode the full game state.

### Referee Puzzle Args

```rust
RefereePuzzleArgs {
    mover_pubkey,           // public key of the player whose turn it is
    waiter_pubkey,          // public key of the player waiting
    timeout,                // blocks before timeout can be claimed
    amount,                 // total amount in the game
    game_move: GameMoveDetails {
        basic: GameMoveStateInfo {
            move_made,      // the actual move data
            max_move_size,  // maximum allowed move size
            mover_share,    // how much the mover gets if the result settles
        },
        validation_info_hash,     // ValidationInfoHash commitment, or None for terminal
        validation_program_hash,  // optional raw validator program hash when known
    },
    previous_validation_info_hash,  // ValidationInfoHash: Initial sentinel, or previous validation info hash
    validation_program,     // the chialisp program that validates moves
    nonce,                  // role-namespaced counter; also serves as the GameID
    referee_coin_puzzle_hash, // puzzle hash of the referee puzzle itself
}
```

Players are identified by **public keys** (not puzzle hashes) in the referee
args. After each move, the new game coin swaps `mover_pubkey` and
`waiter_pubkey` — the previous mover becomes the waiter, and vice versa. This
is how the referee enforces alternating turns.

`**mover_share` semantics.** On any game coin, `mover_share` is the amount the
current mover receives if the current result is accepted, folded, or claimed by
timeout (the waiter receives `amount - mover_share`). These are the same
settlement operation reached from different contexts: a player may accept/fold
off-chain, or the opponent may claim the same result on-chain after the relative
timelock expires. However, `mover_share` is *set by the previous move*: when a
player moves, they declare `new_mover_share` as part of their move, and because
roles swap, the value they declare becomes what their *opponent* (the new
mover) would receive if that result is settled. In other words, when you set
`mover_share` in your move you are choosing how much to leave the other player
if they accept/fold or fail to respond. A game handler that wants to maximize
its own settlement reward sets `mover_share` to zero (giving the opponent
nothing); a fair split sets it to whatever the game rules dictate.

The reward destination puzzle hashes are not curried into the referee — instead
they are revealed at timeout or slash via `AGG_SIG_UNSAFE` (see
[Reward Payout Signatures](#reward-payout-signatures)).

### Game IDs and Nonces

A `GameID` *is* the nonce — a `u64` that serves as both the referee puzzle
differentiator and the canonical identifier used by the API and UI. When
serialized to CLVM for referee puzzle hashes, it goes through the standard
CLVM integer encoding (the same encoding `usize::to_clvm` uses).

Nonces are **role-namespaced**: the initiator (the player who starts with the
potato) allocates even nonces (0, 2, 4, …) and the responder allocates odd
nonces (1, 3, 5, …). Each player increments by 2, so their nonces never
collide with the opponent's. Because the nonce is curried into the referee
puzzle, distinct nonces guarantee distinct puzzle hashes even for otherwise
identical game parameters.

When receiving a proposal, the `ChannelState` validates that the incoming
nonce has the correct parity for the sender's role and is monotonically
increasing (nonces may be skipped if the sender proposed and cancelled
a game before the potato arrived). Both players use the same `GameID` to
refer to the game for its entire lifecycle.

### On-Chain Referee Actions

The referee runs validator programs to enforce game rules on-chain. For how
validators relate to off-chain handlers, see `HANDLER_GUIDE.md`.

The referee puzzle (`referee.clsp`) accepts three types of solutions:

1. **Timeout** (`args = (mover_payout_ph, waiter_payout_ph)`):
  - Requires `ASSERT_HEIGHT_RELATIVE >= TIMEOUT`
  - Creates a coin of `MOVER_SHARE` to `mover_payout_ph` (if nonzero)
  - Creates a coin of `AMOUNT - MOVER_SHARE` to `waiter_payout_ph` (if nonzero)
  - Requires `AGG_SIG_UNSAFE` from each player for their respective
  `"x" || payout_ph` (only for nonzero shares)
  - Used when the current mover fails to act in time
  - **Both players' reward coins are created in a single transaction** —
  whichever player submits the timeout spend creates coins for both sides
2. **Move** (`args = (new_move, infohash_c, new_mover_share, new_max_move_size)`):
  - Runs the mover's puzzle to authorize the spend
  - Creates a new game coin with swapped mover/waiter and updated state;
  `new_mover_share` becomes the opponent's (new mover's) share on timeout
  - Requires `ASSERT_BEFORE_HEIGHT_RELATIVE` (must move before timeout)
  - Requires `AGG_SIG_ME MOVER_PUBKEY (shatree args)` on the move args
3. **Slash** (`args = (previous_state, previous_validation_program, evidence, mover_payout_ph)`):
  - Proves a previous move was invalid by running the validation program
  - Slash succeeds (creates `CREATE_COIN mover_payout_ph AMOUNT`, slasher
  takes the full game amount) when the validator returns nil *or* returns
  values whose infohash or max_move_size don't match the curried commitments
  - If the validator *raises* (CLVM exception), the slash transaction itself
  fails to mine — this is why validators must classify malicious moves as
  slashable before any evidence-sensitive code can raise (see `CLVM_DOS.md`,
  "Game-Specific Responsibilities")
  - Validator raises are acceptable only for invalid slash attempts, such as
  malformed evidence against an otherwise valid move. A malicious move itself
  must be classified as slashable before evidence-sensitive code can raise.
  - Requires `AGG_SIG_UNSAFE MOVER_PUBKEY ("x" || mover_payout_ph)` — the same
  pre-signed payout authorization used by timeouts, so no additional signing
  is needed at slash time

### Referee State Model

The referee maintains two sets of args at all times:

- `**args_for_this_coin()`** — the args used to curry the **current** coin
  puzzle. This is what `on_chain_referee_puzzle_hash()` computes.
- `**spend_this_coin()`** — the args used to curry the **next** coin puzzle
  (the coin created when this one is spent). This is what
  `outcome_referee_puzzle_hash()` computes.

These accessors are exposed on `Referee` (and delegated through
`MyTurnReferee` / `TheirTurnReferee`). Internally, my-turn/their-turn state
stores corresponding current/next args fields.

**Off-chain**, game coins are *virtual*: they don't exist on the blockchain,
but their spends are validated by running real chialisp execution exactly as
if they were on-chain. The two sets of args stay in sync because the unroll
commitment is updated at each move. If the channel unrolls, these virtual
coins become real on-chain coins.

**On-chain after unroll**, the real coin is created at the state captured by
the last unroll commitment. But off-chain moves may have advanced the virtual
coin beyond that point. A *redo* replays those subsequent moves on-chain to
bring the real coin up to date. After a redo, the actual coin's puzzle hash
corresponds to `outcome_referee_puzzle_hash()` rather than
`on_chain_referee_puzzle_hash()`, because the on-chain moves create coins
with the "next state" args while the referee's internal `create_this_coin`
still reflects the original unroll-state args.

The `get_transaction_for_timeout` function handles this by checking the coin's
actual puzzle hash against both accessors and using whichever matches.

`last_referee_puzzle_hash` on `LiveGame` always tracks
`outcome_referee_puzzle_hash()` — the post-move puzzle hash. This is the
expected "latest state" puzzle hash used by `set_state_for_coins` to determine
whether the game coin is at the latest state or needs a redo.

**Key code:** `src/referee/mod.rs` — `args_for_this_coin`,
`spend_this_coin`, `on_chain_referee_puzzle_hash`, `outcome_referee_puzzle_hash`

### Reward Payout Signatures

Reward destination puzzle hashes are **not** curried into the referee puzzle.
Instead, they are revealed at timeout or slash as solution arguments, and each
player proves they authorized their payout destination via `AGG_SIG_UNSAFE`.
Each player caches the opponent's signature during the handshake, so either
player can submit the timeout transaction and it will pay both sides correctly.
A player cannot redirect the opponent's reward because only the opponent's
private key can produce a valid signature for a given puzzle hash.

**How it works:**

1. During the **handshake**, each player signs `"x" || reward_puzzle_hash`
  (a 33-byte message: the ASCII byte `'x'` followed by their 32-byte reward
   puzzle hash) and sends the signature to the other player.
2. The `RefereeFixedContext` struct stores both `reward_puzzle_hash` (ours) and
  `their_reward_puzzle_hash` along with `their_reward_payout_signature`.
3. When a **timeout** is submitted, the solution provides both payout puzzle
  hashes. The referee puzzle emits `AGG_SIG_UNSAFE` conditions requiring the
   mover's signature on `"x" || mover_payout_ph` and the waiter's signature
   on `"x" || waiter_payout_ph` (only for nonzero shares).
4. `get_transaction_for_timeout` in `src/referee/mod.rs` assembles the
  aggregate signature:
  - If our share is nonzero: sign our own `reward_puzzle_hash` with our
  private key
  - If their share is nonzero: include the pre-exchanged
  `their_reward_payout_signature`
  - Shares of zero are omitted from both the conditions and the aggregate
  signature

This design means reward puzzle hashes don't need to be curried into every
game coin — they're only revealed once, in the final timeout or slash spend.

Both players' reward payout signatures are **cached** in `RefereeFixedContext` at game
creation time: `my_reward_payout_signature` (signed by us) and
`their_reward_payout_signature` (received during handshake). This avoids
redundant BLS signing during timeout and slash construction — the cached
signatures are simply aggregated into the spend bundle.

The slash path also uses `AGG_SIG_UNSAFE` with the same `"x" || payout_ph`
format, so the pre-exchanged reward signature covers both timeout and slash
payouts.

**Key code:** `src/common/standard_coin.rs` — `sign_reward_payout`,
`reward_payout_message`, `verify_reward_payout_signature`;
`src/referee/types.rs` — `RefereeFixedContext` (caches both signatures)

### Off-Chain Validation and Initial State

There is no special "off-chain mode" in `RefereePuzzleArgs`. Earlier versions
used a sentinel argument to tell handlers they were being run off-chain, but
that made handler logic hard to follow. The current code constructs normal
referee arguments with real mover and waiter pubkeys, substitutes the incoming
move and validation program, and uses the same state-update program that would
be used by the on-chain referee when validating peer moves.

When a move has a follow-on state, the state update is run off-chain first to
validate the move and derive that state before the receiving player's
their-turn handler interprets it. A terminal move is still a normal move, but
it sets the next validation program to nil, so there is no follow-on state to
derive for future moves. The their-turn handler still interprets the move and
may provide slash evidence. Any evidence it provides is checked by running the
normal state-update program with that evidence.

This keeps off-chain and on-chain validation semantics aligned. Some games may
repeat a small amount of logic between their on-chain validator and off-chain
handler code, but avoiding a separate off-chain signal keeps the handler
contract simpler.

### ValidationInfoHash and the Initial Sentinel

The terminology is easy to mix up:

- A `validation_program_hash` is the tree hash of a validator program by
  itself.
- A validation info hash is
  `sha256(validation_program_hash, shatree(state))`. It commits to both the
  validator program and the state that program validates.

The referee coin stores validation info hashes, not bare program hashes. The
current move's commitment is stored in `game_move.validation_info_hash`, and the
previous move's commitment is stored in `previous_validation_info_hash`. These
fields use the `ValidationInfoHash` enum, which has three variants with
distinct CLVM encodings:

| Variant   | CLVM encoding         | Truthy? | When used |
|-----------|-----------------------|---------|-----------|
| `None`    | `()` (nil / empty atom) | No    | Game over — no further moves, only slash or timeout |
| `Initial` | `0x78` (`'x'`, 1 byte) | Yes   | Initial game coin — no previous move exists |
| `Hash(h)` | 32-byte atom          | Yes    | Normal play — validation info hash |

The initial game coin's `previous_validation_info_hash` is set to `Initial`
(the single-byte sentinel `0x78`). This is truthy in CLVM, which matters
because the referee puzzle checks truthiness of `previous_validation_info_hash`
to decide whether moves are allowed — a falsy (nil) value means the game can
only slash or timeout. The sentinel is a single byte rather than a full hash
to save on-chain space, since there is no real previous validation program to
reference and slashing is impossible when no moves have been made.

Each move propagates the current validation info hash (`INFOHASH_B`) into the
next coin's `previous_validation_info_hash` (`INFOHASH_A`). The move solution
also supplies `infohash_c` for the next validator/state pair; on the move path
the referee accepts this optimistically, and on the slash path it recomputes
the infohash from the validator return and checks that it matches. There is no
separate code path for the initial state — the same derivation logic applies
uniformly to all moves.

The raw validation program hash is not always carried alongside the referee
coin. It is available when the code has the validation program itself (for
example when invoking a their-turn handler or constructing a slash), but the
durable on-chain commitment is the validation info hash. `GameMoveDetails`
therefore keeps the raw program hash in the optional
`validation_program_hash` field separately from the required
`validation_info_hash` commitment.

This is an on-chain size/cost optimization. Honest move spends present only the
compact validation info hash for the next validator/state pair; they do not
reveal the validation program or state separately. Those larger pieces are
revealed only on the slash path, where the referee needs them to recompute the
infohash and prove that the optimistic move commitment was invalid.

**Key code:** `src/referee/types.rs` — `ValidationInfoHash`,
`RefereePuzzleArgs`;
`src/referee/my_turn.rs`, `src/referee/their_turn.rs`;
`clsp/referee/onchain/referee.clsp`

---

## On-Chain Game State Tracking (our_turn)

The `OnChainPhase` maintains a `game_map: HashMap<CoinString, OnChainGameState>` that tracks each game coin's state, including an `our_turn`
flag.

### How our_turn is Set

- **Initial game coin** (from unroll): Set by `set_state_for_coins`. If a redo
is needed, `our_turn = true` (we need to submit the redo). Otherwise,
`our_turn = is_my_turn()` based on the referee state.
- **After opponent's move** (`TheirSpend::Expected` or `TheirSpend::Moved`):
`our_turn = true` — the opponent just moved, so now it's our turn.

### our_turn Correction for Pending Redos

In the `TheirSpend(Expected)` path of `handle_game_coin_spent`, the channel
handler's referee may be one step ahead of the on-chain state (because we
already processed the next move off-chain but the response was dropped). In
this case, `game_is_my_turn()` returns `false` (the referee thinks it is the
opponent's turn), but on-chain it is actually *our* turn to submit the redo.

When a redo is generated via `take_cached_move_for_game`, `our_turn` is set to
`true` to reflect the on-chain reality. Without this correction, the spend that
resolves the intermediate redo coin would be misread (see below), producing
wrong notifications.

### How our_turn and the Observed Spend Determine Notifications

Notifications are **confirmation-driven**: they are emitted from
`handle_game_coin_spent` when the game coin's actual spend is observed, not when
the timelock matures. `our_turn` records whose move the on-chain state is
waiting on, and the handler combines it with what the *observed spend* created
to decide the terminal status:

- **Spend pays our reward puzzle hash** → our claim confirmed:
`GameSettled` with outcomes such as `we_accepted`, `settled_cleanly`, or
`slashed_opponent`.
- **Spend pays the opponent's reward puzzle hash** → the opponent acted first:
a normal move advances the game, a timeout claim against our pending move
yields `opponent_timed_out` or `attempt_to_move_failed`, and a timeout claim
while we were attempting to slash yields `opponent_cheated`.

`our_turn` is a key input, but not the only one: the accepted-state and the
pending-slash / pending-move bookkeeping on `OnChainGameState` also steer the
branch. In particular, an opponent's timeout claim against our pending `OurMove`
coin can yield `attempt_to_move_failed` (rather than being misread as a win
against a stale, optimistically-advanced referee state).

Both players maintain independent `game_map`s, and both should have
complementary `our_turn` values for the same game coin.

### Timeout-Claim-Armed On-Chain Coins

`timeout_claim_armed: true` means this side has already armed the on-chain
timeout-claim path for the game coin (eager register or explicit
`AcceptSettlement`).  It does not mean the observed on-chain coin is already
terminal.  The real chain coin might still represent the version captured by
the unroll, which can be one step behind the local potato state, so an armed
coin may still advance to another game coin before timeout finality.

When that happens, `handle_game_coin_spent` keeps tracking the created coin and
registers the next timeout claim under `"timeout-claim-armed game coin advanced by redo"`.
The `timeout_claim_armed` flag is carried forward: once the actual chain state
reaches a reward-coin spend, the terminal `GameSettled` notification is emitted
from the observed conditions.

### Moves for Finished Games Are Discarded

When a game coin's resolving spend is observed, the game is removed from
`game_map` and `live_games`. If a user-queued `Move` for that game is still on
the `game_action_queue`, it is discarded when popped: `do_on_chain_action` checks
`get_current_coin` and falls through to `process_queued_action` if the game is gone, and
`do_on_chain_move` checks `my_move_in_game` — returning `None` (game absent)
causes a discard, while `Some(false)` (game alive, not our turn) causes a
requeue. This prevents stale moves from crashing or looping after a legitimate
timeout.
