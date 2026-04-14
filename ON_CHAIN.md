# On-Chain Resolution

For the conceptual overview (state channels, coin hierarchy, potato protocol),
see `OVERVIEW.md`. For off-chain game proposals and flow, see
`GAME_LIFECYCLE.md`.

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
  - [Off-Chain Validation Signal and Initial State](#off-chain-validation-signal-and-initial-state)
- [On-Chain Game State Tracking (our_turn)](#on-chain-game-state-tracking-our_turn)

---

## Going On-Chain: Dispute Resolution

When something goes wrong (opponent offline, invalid move detected, explicit
`GoOnChain` action), the off-chain `PotatoHandler` — which manages the potato
protocol, peer messages, and batch exchanges — is effectively done. A
fundamentally different component, `OnChainGameHandler`, takes over. It is
driven entirely by blockchain coin-watching events (coin created, coin spent,
timeout reached) rather than peer messages. The `PotatoHandler` creates an
`SpendChannelCoinHandler` replacement, which in turn creates the
`OnChainGameHandler`. At that point all game actions
(moves, accept-timeouts) are routed to the on-chain handler. It maintains its
own `game_map` tracking each game coin's state. There is no potato, no
batching, no turn-taking — just monitoring the blockchain and submitting
transactions in response to what it sees.

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

`ChannelHandler::set_state_for_coins` matches each created game coin's puzzle
hash against known states. It searches both `live_games` and
`pending_accept_timeouts` (see [AcceptTimeout Lifecycle](GAME_LIFECYCLE.md#accepttimeout-lifecycle)). All
state tracking is **forward-only** — there is no rewind logic. Two cases:

1. **Coin PH matches `last_referee_puzzle_hash`** (the outcome/post-move PH):
  The game coin is at the latest known state. `our_turn` is set based on
   `is_my_turn()`. No redo needed.
2. **Coin PH matches a `cached_last_actions` entry's `match_puzzle_hash`**: The
  game coin is at the state *before* our cached move. A redo is needed to
   replay that move on-chain (see [Redo Mechanism](INTERNALS.md#cached_last_actions-and-the-redo-mechanism)).

Games that existed off-chain but don't match any created coin are reported as
`GameError` (these were accepted games that should have appeared on-chain).

### Step 4: Redo (if needed)

If the game coin landed at the pre-move state, the redo transaction is emitted
immediately during `finish_on_chain_transition` — before the `OnChainGameHandler`
is created. For each game with a cached move, the code temporarily restores the
referee to the post-move state, generates the spend transaction, and inserts a
`PendingMoveSavedState` entry into the handler's `pending_moves` map. The
`OnChainGameHandler` never distinguishes between redo transactions and fresh
moves; it just tracks pending spends per game coin and reconciles them when
on-chain confirmation arrives.

### Step 5: Timeout Resolution

Once the game coin is at the latest known state, `coin_timeout_reached`
handles resolution when the `game_timeout` relative timelock expires. The
behavior depends on whose turn it is:

- **Our turn, already accepted off-chain** (`accepted == true`): We already
decided to accept the current `mover_share` split. A timeout transaction is
submitted (if our reward is nonzero) and `WeTimedOut` is emitted. The
`WeTimedOut` notification fires here, not when accept_timeout was originally
called — the off-chain call only records intent.
- **Our turn, not yet accepted**: The game waits for a local `AcceptTimeout`
action from the UI before submitting.
- **Opponent's turn**: The opponent hasn't moved within the timelock. We claim
the timeout by submitting the timeout transaction (if our reward is nonzero)
and `OpponentTimedOut` is emitted.

**Zero-reward skip**: In both our-turn and opponent-turn cases, if our reward
is zero the timeout transaction is not submitted (avoiding a pointless
transaction fee). The notification still fires so the game lifecycle is cleanly
resolved; the opponent is expected to claim their reward.

### Step 6: Clean Shutdown

After all games resolve, a `ChannelStatus` with state `ResolvedClean` is
emitted and the channel can be closed.

**Key code:**

- `src/potato_handler/mod.rs` — `go_on_chain`
- `src/potato_handler/spend_channel_coin_handler.rs` — `handle_channel_coin_spent`,
`finish_on_chain_transition`
- `src/potato_handler/on_chain.rs` — `OnChainGameHandler`
- `src/channel_handler/mod.rs` — `set_state_for_coins`,
`accept_or_timeout_game_on_chain`, `game_coin_spent`

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
   on the receive side.
2. The responder receives the batch, processes any actions, then combines the
  initiator's half-signature with their own to produce a complete `CoinSpend`.
   They reply with `PeerMessage::CleanShutdownComplete(coin_spend)` — a
   standalone message outside the normal potato flow.
3. Either side can then submit the completed spend on-chain.

### Why "Advisory" — Race Handling

Clean shutdown is **advisory, not authoritative**. Both players produce the
same transaction (spending the channel coin directly to reward coins), so
duplicate submissions between them are harmless. The real race is between the
clean shutdown transaction and an **unroll transaction** — either side might
initiate an unroll (via `go_on_chain`) around the same time. Both spend the
channel coin, so only one can land on-chain.

Because of this, the system never blindly trusts that the clean shutdown
landed. When the channel coin is detected as spent, `SpendChannelCoinHandler`
inspects the actual spend conditions:

1. **Clean shutdown landed:** The conditions contain a `CreateCoin` matching
   the expected change coin (puzzle hash and amount). The handler transitions
   to an `OnChainGameHandler` with an empty game map and `resolved_clean: true`,
   which emits `ChannelStatus` with state `ResolvedClean`.
2. **An unroll landed instead:** The conditions do not match (or, when the
   player's expected reward is zero, they contain a `Rem` — which clean
   shutdown conditions never include). The handler continues with unroll
   logic, comparing the on-chain state number against the local state to
   decide preempt vs timeout. Since no games are active, the unroll creates
   only reward coins; `finish_on_chain_transition` finds an empty game map
   and transitions to `OnChainGameHandler`. The outcome is the same correct
   balances, just with more on-chain transactions.

### Key Code

- `src/potato_handler/spend_channel_coin_handler.rs` —
`handle_channel_coin_spent`, `handle_unroll_from_channel_conditions`

---

## Preemption

Preemption is the mechanism that prevents stale unrolls from succeeding. When
a player sees the channel coin being spent to an unroll coin, they compare the
on-chain sequence number against their own latest state:


| On-chain SN vs ours | Action                  | Explanation                                                                         |
| ------------------- | ----------------------- | ----------------------------------------------------------------------------------- |
| On-chain < ours     | **Preempt** (immediate) | Spend the unroll coin immediately with our higher SN and more up-to-date conditions |
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

**Key code:** `src/channel_handler/mod.rs` — `channel_coin_spent`,
`make_preemption_unroll_spend`

## Stale Unroll Handling

When preemption fails (e.g. the preemption transaction is not mined in time)
and the opponent's stale unroll succeeds via timeout, the system enters
**stale unroll handling** rather than treating it as an unrecoverable error.

### Staleness Detection

Staleness is determined by comparing the `on_chain_state` (the sequence number
extracted from the channel coin's `REM` conditions when the unroll coin was
created) against `timeout_state_number()` from `ChannelHandler`.

`timeout_state_number()` returns the state number captured in the handler's
timeout snapshot (`self.timeout.as_ref().map(|t| t.coin.state_number)`), and
staleness is computed as:

`is_stale = timeout_state_number().is_some_and(|t| on_chain_state + 1 < t)`


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
  - If `coin_ph` matches a `cached_last_actions` entry's
  `match_puzzle_hash` for the same game and amounts match → game needs a
  redo move.
  - Otherwise → `GameError` (the coin is present but we can't identify what
  state it's in).
- Games not found in the unroll outputs receive one of two notifications
depending on whether the game was fully established or still in-flight:
  - `**EndedCancelled`** — the game was a recently accepted proposal whose
  potato round-trip hadn't completed (tracked as a `ProposalAccepted`
  entry in `cached_last_actions`). The opponent hadn't acknowledged the
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


**Key code:** `src/potato_handler/spend_channel_coin_handler.rs` —
`finish_on_chain_transition`, `src/channel_handler/mod.rs` —
`set_state_for_coins`

---

## Zero-Reward Early-Out

When our share of a game is zero, there is no reason to wait for on-chain
timeouts, submit transactions, or perform redo moves — those operations cost
time and transaction fees for no reward.  In these cases the system immediately
emits `WeTimedOut { our_reward: 0, reward_coin: None }` and removes the game
from tracking.

### Rationale

1. **No rational incentive.**  When our share is zero the opponent has nothing
  to gain by playing (they already have everything) and we have nothing to
   claim.  Waiting for a timeout is pure overhead.
2. **Avoids unnecessary transactions.**  Submitting a redo move or timeout
  claim that yields zero reward wastes block space and fees.
3. **Clean terminal signal.**  The UX immediately learns the game is over,
  rather than waiting many blocks for a timeout that produces nothing.

### Trigger Points

The early-out fires at five distinct points.

**At unroll completion** (scanned in `finish_on_chain_transition` right after
`set_state_for_coins` populates the `game_map`):

1. **Pending redo with zero reward.**  A move was sent off-chain but the
  potato hadn't come back.  The unroll lands at the pre-move state and a redo
   is queued.  If the post-redo `our_current_share` would be zero, the redo is
   skipped and `WeTimedOut(0)` fires.  Checked via `is_redo_zero_reward()`.
2. **Pending AcceptTimeout with zero share.**  An `AcceptTimeout` was called
  off-chain but the potato round-trip hadn't completed.  The coin matches via
   `pending_accept_timeouts` with `accepted = true`.  If our share is zero,
   `WeTimedOut(0)` fires immediately instead of waiting for the on-chain
   timeout.
3. **Opponent's turn, mover_share == coin_amount.**  The move was
  acknowledged (no redo needed).  It's the opponent's turn and
   `mover_share == coin_amount`, meaning the opponent gets everything on
   timeout and has no incentive to move.  `WeTimedOut(0)` fires.  This
   only applies when it's the opponent's turn — when it's our turn and
   `mover_share == coin_amount`, *we* get everything and the UX should
   trigger claiming it.

**During on-chain play** (action requested by UX):

1. **On-chain move would produce mover_share == coin_amount.**  In
  `do_on_chain_move`, after computing the move result, if the new
   `mover_share == game_amount` (we as the new waiter get zero) and the move
   is non-terminal (`max_move_size > 0`), the move is not submitted and
   `WeTimedOut(0)` fires.  Terminal moves (`max_move_size == 0`) are always
   submitted because they resolve the game.
2. **On-chain AcceptTimeout with zero share.**  In `do_on_chain_action`'s
  `AcceptTimeout` handler, if `get_game_our_current_share() == 0`, the game
   is removed and `WeTimedOut(0)` fires instead of setting `accepted = true`
   and waiting for the timeout.

### Already handled (no new code)

Off-chain `AcceptTimeout` with zero reward is already handled by
`drain_cached_accept_timeouts` in `src/channel_handler/mod.rs`, which emits
`WeTimedOut` with whatever `our_share_amount` is, including zero.

**Key code:** `src/potato_handler/spend_channel_coin_handler.rs` —
`finish_on_chain_transition` (unroll scan),
`src/potato_handler/on_chain.rs` — `do_on_chain_move` (scenario 4),
`do_on_chain_action` (scenario 5), `src/channel_handler/mod.rs` —
`is_redo_zero_reward`, `get_game_our_current_share`, `get_game_amount`

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
            mover_share,    // how much the mover gets if timeout occurs
        },
        validation_info_hash,  // hash of the validation program + state
    },
    previous_validation_info_hash,  // hash from the prior move (None for initial state)
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
current mover receives if the coin times out (the waiter receives
`amount - mover_share`). However, `mover_share` is *set by the previous move*:
when a player moves, they declare `new_mover_share` as part of their move, and
because roles swap, the value they declare becomes what their *opponent* (the
new mover) would receive on timeout. In other words, when you set `mover_share`
in your move you are choosing how much to leave the other player if they fail
to respond. A game handler that wants to maximize its own timeout reward sets
`mover_share` to zero (giving the opponent nothing); a fair split sets it to
whatever the game rules dictate.

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

When receiving a proposal, the `ChannelHandler` validates that the incoming
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
  - If validation raises, the slash succeeds: creates `CREATE_COIN mover_payout_ph AMOUNT`
  (the slasher takes the full game amount)
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
2. The `RMFixed` struct stores both `reward_puzzle_hash` (ours) and
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

Both players' reward payout signatures are **cached** in `RMFixed` at game
creation time: `my_reward_payout_signature` (signed by us) and
`their_reward_payout_signature` (received during handshake). This avoids
redundant BLS signing during timeout and slash construction — the cached
signatures are simply aggregated into the spend bundle.

The slash path also uses `AGG_SIG_UNSAFE` with the same `"x" || payout_ph`
format, so the pre-exchanged reward signature covers both timeout and slash
payouts.

**Key code:** `src/common/standard_coin.rs` — `sign_reward_payout`,
`reward_payout_message`, `verify_reward_payout_signature`;
`src/referee/types.rs` — `RMFixed` (caches both signatures)

### Off-Chain Validation Signal and Initial State

When running the chialisp validator off-chain, the `off_chain()` method on
`RefereePuzzleArgs` sets `waiter_pubkey` to nil. This is a deliberate signal
to the puzzle that it is running in off-chain validation mode rather than as
a real on-chain spend. `waiter_pubkey` was chosen for this because it is the
argument least likely to be needed for real validation logic.

`RefereePuzzleArgs` also contains a `previous_validation_info_hash` field,
which records the hash of the previous move's validation program (used by
slash to prove a prior move was invalid). At the initial game state there is
no previous move, so this field is `None`. When the first move is made, the
off-chain validation args keep `None` (there is no prior move to slash), but
the on-chain args use `Some(hash)` because the chialisp referee puzzle
always propagates the current validation info hash (`INFOHASH_B`) into the
new coin's `previous_validation_info_hash` (`INFOHASH_A`).

**Key code:** `src/referee/types.rs` — `RefereePuzzleArgs::off_chain()`,
`src/referee/my_turn.rs`, `src/referee/their_turn.rs`,
`clsp/referee/onchain/referee.clsp`

---

## On-Chain Game State Tracking (our_turn)

The `OnChainGameHandler` maintains a `game_map: HashMap<CoinString, OnChainGameState>` that tracks each game coin's state, including an `our_turn`
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
`true` to reflect the on-chain reality. Without this correction, a timeout on
the intermediate redo coin would emit `OpponentTimedOut` instead of
`WeTimedOut`, producing wrong notifications.

### How our_turn Determines Timeout Notifications

When `coin_timeout_reached` fires on a game coin:

```
primarily:
if old_definition.our_turn →  GameNotification::WeTimedOut
else                        →  GameNotification::OpponentTimedOut
```

`our_turn` is the primary signal, but not the only branch input. On-chain
timeout handling also considers accepted-state and accept-transaction/slash
state. In particular, accepted games can resolve through the "we timed out"
path even when the simple two-branch sketch above would be ambiguous.

Both players maintain independent `game_map`s, and both should have
complementary `our_turn` values for the same game coin.

### Moves for Finished Games Are Discarded

When a game coin times out, the game is removed from `game_map` and
`live_games`. If a user-queued `Move` for that game is still on the
`game_action_queue`, it is discarded when popped: `do_on_chain_action` checks
`get_current_coin` and falls through to `next_action` if the game is gone, and
`do_on_chain_move` checks `my_move_in_game` — returning `None` (game absent)
causes a discard, while `Some(false)` (game alive, not our turn) causes a
requeue. This prevents stale moves from crashing or looping after a legitimate
timeout.
