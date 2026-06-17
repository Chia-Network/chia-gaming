# Connectivity Model

This document describes the semantics of the four types of connections in the
player app and how they interact. It captures the intended design for session
rollover support — the ability to disconnect from and reconnect to wallets,
trackers, and peers without losing game sessions unnecessarily.

For background on the system architecture, see `FRONTEND_ARCHITECTURE.md`.
For game lifecycle details, see `GAME_LIFECYCLE.md`.

## Table of Contents

- [The Four Axes](#the-four-axes)
- [State Space](#state-space)
- [Cascade Rules](#cascade-rules)
- [User Actions](#user-actions)
- [Session Lifecycle](#session-lifecycle)
- [Tracker Availability Protocol](#tracker-availability-protocol)
- [Implementation Status](#implementation-status)

---

## The Four Axes

### The Blockchain

The blockchain is not a connection. It is the ground truth — always present,
immutable, the same chain regardless of how you reach it. All game state
ultimately lives on-chain (coins, channel state, resolution transactions).
No connectivity decision affects the blockchain itself.

### Wallet

The wallet is a **replaceable interface** to the blockchain. WalletConnect and
the simulator are different lenses into the same chain. Connecting a different
wallet (or reconnecting the same one) gives you the same view of the same
coins. Switching between simulator and real chain is a user error the app
doesn't guard against — coins simply won't exist.

The wallet is **orthogonal** to the other three axes. It can be connected or
disconnected in any combination with tracker, peer, and session state. No
other connection depends on the wallet being up. The wallet affects only
whether blockchain operations (signing transactions, reading balances) can
make progress.

WalletConnect is an external protocol. The player app can adapt around its
quirks at the edges (for example BigInt serialization handling), but it does
not control WalletConnect's wire format. This is different from the peer/tracker
protocol, which is project-owned and can move further toward binary framing over
time.

### Tracker

A tracker is a specific server with its own lobby and relay infrastructure.
Tracker A and Tracker B are distinct entities — different lobbies, different
pairings, different relay channels. The player connects to zero or one tracker
at a time.

The tracker connection auto-reconnects with backoff on transient failures. A
tracker is considered permanently dead only after the retry budget is
exhausted or the user explicitly disconnects.

### Peer

A peer connection is mediated by a tracker. There is no direct peer-to-peer
transport (WebRTC is a future option). The peer relay rides on the tracker's
WebSocket — structurally, **peer requires tracker**. If the tracker is down,
the peer is down by definition.

There are two ways to end a peer connection:

1. **Hard disconnect** — `close()` via the tracker. The tracker notifies the
   peer (`closed` event), removes the pairing, and sets both players to
   `'waiting'`. The relay is gone, including chat.
2. **Soft disconnect** — going on-chain while the tracker/peer relay is still
   alive. Game messages stop flowing, but chat continues over the same relay.
   The pairing still exists on the tracker.

Once the peer connection is considered lost (either via hard disconnect, or
liveness timeout without reconnect), it is gone. There is no "reconnect to
the same peer" — both sides would have to re-match on a tracker.

### Session

A session is an **obligation**, not a connection. Once started, it runs to
completion. Funds are locked in the channel coin and must be distributed
through the protocol — either cooperatively (clean shutdown) or unilaterally
(on-chain resolution). The session does not care whether you have a peer or a
tracker — it will grind to completion on the blockchain if it has to.

---

## State Space

The wallet is orthogonal and does not participate in the state machine. The
core state space is:

```
tracker:  up | down
peer:     up | down   (peer up requires tracker up)
session:  none | off-chain | on-chain
```

- **off-chain**: the game is being played through the peer relay. The relay is
  the authority for game moves.
- **on-chain**: the blockchain is the authority. This transition is one-way —
  once you initiate `goOnChain()`, you are on-chain from the perspective of
  all connectivity rules. `cleanShutdown()` does **not** immediately
  transition to on-chain — it stays in the cooperative off-chain flow until
  the peer countersigns and the shutdown transaction is formed.

2 × 2 × 3 = 12 combinations, minus 3 impossible states (tracker down, peer
up) = **9 reachable states**.

Four of those are **ephemeral** — they exist for one tick and auto-transition:

| Ephemeral state | Rule | Transitions to |
|-----------------|------|----------------|
| tracker up, peer down, session off-chain | off-chain + no peer → on-chain | tracker up, peer down, session on-chain |
| tracker down, peer down, session off-chain | off-chain + no peer → on-chain | tracker down, peer down, session on-chain |

(Each of those can occur with or without wallet, but since wallet is
orthogonal, it doesn't affect the transition.)

The rule is: **off-chain session without a peer must immediately transition to
on-chain.** No dialog, no prompt, no user decision. This is automatic.

### Resting States

After collapsing ephemeral states, the system has **7 resting states**:

| # | Tracker | Peer | Session | Description |
|---|---------|------|---------|-------------|
| 1 | up | up | none | Idle on a tracker. Can accept challenges. |
| 2 | up | up | off-chain | Playing a game through the relay. |
| 3 | up | up | on-chain | Resolving on-chain, peer still connected. Chat works. |
| 4 | up | down | none | On a tracker, no match. Waiting in lobby. |
| 5 | up | down | on-chain | Resolving on-chain, peer gone. Tracker available for future matchmaking. |
| 6 | down | down | none | Disconnected from everything. Can reconnect. |
| 7 | down | down | on-chain | Resolving on-chain, no tracker. Grinding through blockchain. |

The wallet can be up or down in any of these states. When the wallet is down,
blockchain operations stall but the logical state is unchanged.

---

## Cascade Rules

Forced cascades flow downward through the dependency chain:

```
tracker dies  →  peer dies  →  off-chain session goes on-chain
```

Specific rules:

- **Tracker goes down permanently** → peer is gone (rides the same socket) →
  if session is off-chain, auto-transition to on-chain.
- **Peer lost** (hard disconnect, liveness timeout, or tracker death) → if
  session is off-chain, auto-transition to on-chain.
- **Session transitions off-chain → on-chain** — one-way. No going back.
- **Wallet loss** — no cascade. Session is logically unchanged; blockchain
  operations just can't make progress until a wallet is reconnected.

---

## User Actions

### Wallet

| Action | Allowed? | Warning | Consequence |
|--------|----------|---------|-------------|
| Disconnect | Always | "You are in a session. Blockchain operations will stall until you reconnect." (only if session exists) | Wallet interface torn down. Session save preserved. |
| Reconnect (same or different) | Always | None | Stalled operations resume. Session continues. |

### Tracker

| Action | Allowed? | Warning | Consequence |
|--------|----------|---------|-------------|
| Disconnect | Always | If peer up: "This will end your peer connection." If session off-chain: "This will force your game on-chain." | Peer dies (cascade). |
| Reconnect (same tracker) | Always | None | Tracker re-identifies. If pairing still exists on server, peer may reconnect. |
| Connect to new tracker | Always | None | New lobby. If session is active, join as unavailable. |

### Peer

| Action | Allowed? | Warning | Consequence |
|--------|----------|---------|-------------|
| Hard disconnect (`close()`) | Always | None currently. | Pairing removed. Peer notified. Both go to `'waiting'`. Off-chain session transitions to on-chain via the peer-loss cascade. |
| Reconnect | Not a user action | — | Handled by tracker auto-reconnect and `peer_reconnected` events. |

### Session

| Action | Allowed? | Warning | Consequence |
|--------|----------|---------|-------------|
| Go on-chain | When session = off-chain | None currently. | Session transitions to on-chain. Game messages stop. Chat continues. |
| Clean shutdown | Between hands only, requires peer cooperation | None (it's the graceful path) | Cooperative close. Channel resolves cleanly. |

---

## Session Lifecycle

### Session States (as seen by Shell)

| State | Derived from | Meaning |
|-------|-------------|---------|
| `none` | `gameParams === null` | No session. Not busy and available for matchmaking. |
| `off-chain` | Session exists, not yet resolving on-chain | Playing through the peer relay. `cleanShutdown()` stays off-chain until the shutdown transaction is formed. |
| `on-chain` | `goOnChain()` initiated, clean shutdown transaction submitted, or channel resolved while game outcomes are still pending | Resolving on the blockchain or waiting for remaining hand outcomes. May or may not have peer. |

The on-chain state persists until the broader session phase is terminal. A raw
channel status of `ResolvedClean`, `ResolvedUnrolled`, `ResolvedStale`, or
`Failed` is terminal for the channel itself, but `ResolvedUnrolled` and
`ResolvedStale` can still be followed by per-game outcomes. If any hand remains
unresolved, the broader session phase stays `on-chain`. Once the last hand is
finished, the broader phase becomes `resolved`: the save can be wiped and the
player is not busy for new matches. `Failed` is also terminal; it maps to
broader `resolved` plus the separate `sessionError` advisory bit.

### What "on-chain" means for peer communication

When a session transitions to on-chain:

- **Game messages** (`OutboundMessage` from WASM, `deliverMessage` inbound):
  **stop**. Don't send new game messages to the peer. Ignore incoming game
  messages from the peer (ack them to prevent retransmit, but don't deliver
  to the WASM cradle).
- **Acks for already-delivered messages**: still processed (they concern the
  past).
- **Keepalives**: harmless but no longer meaningful for game liveness.
- **Chat**: **still works**. Chat is independent of the game protocol and
  rides the same tracker relay.

### Terminal detection

When the broader session phase becomes `resolved` after a terminal channel
state (`ResolvedClean`, `ResolvedUnrolled`, `ResolvedStale`, or `Failed`) and
any pending hand obligations have finished:

1. The session is done.
2. Shell is notified (via callback from `useGameSession`).
3. Live protocol interaction stops: the WASM cradle is no longer used for new
   game actions, `sessionStartedRef` and `activePairingTokenRef` are reset, and
   the finished session is treated as a read-only display.
4. The resolved display is intentionally preserved so the user can see what just
   happened. A reload may restore this finished view, but it should not resume
   live protocol behavior.
5. Shell tells the tracker/lobby that the player is not busy.
6. The player can accept new challenges. This is intentional: terminal sessions
   no longer impose a protocol obligation, so the UI should encourage continued
   play instead of making the user manually clear the finished game.
7. A new match replaces the old resolved display. There is no manual "Close
   Session" button.
8. The peer connection is not forcibly closed — chat can continue until a
   new match replaces the pairing or either side disconnects.
9. Chat messages persist across session boundaries and are only cleared
   when a new pairing starts (new match).

---

## Tracker Busy Protocol

### The problem

A tracker only knows about pairings it created. If a player connects to a new
tracker while mid-session (or while on-chain resolution is in progress), that
tracker has no idea the player is busy. Other players will see them as waiting
and can send challenges.

### The solution

The player app tells the tracker whether it is busy over the
**game channel WebSocket** (`TrackerConnection` → `/ws/game`). The tracker
is not trusted either (it's third-party code anyone can run), but the
WebSocket is a TCP connection with known coherent semantics — clear ordering,
connection state, and a single stream. The lobby iframe's `postMessage`
boundary is a broadcast mechanism with no delivery guarantees, no ordering,
and a much harder surface to guard against. Busy signaling goes over
the WebSocket because it's the more defensible transport, not because the
tracker is trusted.

Busy is session-obligation state, not just pairing state. A player can be busy
because an old session is still unresolved even if the tracker no longer has a
pairing for that player (for example, after disconnecting from the tracker while
resolving on-chain). Conversely, after a session finishes, the player can become
not busy and available for new matches while a previous pairing/chat is still
visible until a new session replaces it.

The app is not busy if and only if the broader session phase is `none` or
`resolved`. Raw `ChannelState` is more detailed than this (`Handshaking`,
funding/offer states, `Active`, shutdown states, on-chain transition states,
resolved channel states, `Failed`, etc.) and must not be treated as the lobby
availability state directly. The broader session phase folds in pending hand
state: a raw channel status can be resolved while the session remains `on-chain`
because a hand is still being settled.

**Player app → Tracker (game channel):**

```json
{ "type": "set_busy", "session_id": "...", "busy": true }
```

Sent whenever the broader session phase changes. The same `busy` bit is also
included in the initial `identify` message so the tracker has correct status
immediately after a game channel opens, reconnects, or restores. This avoids a
brief `waiting` flicker for unresolved restored sessions.

The tracker updates the player's lobby status to `'busy'` or `'playing'` while
busy, or `'waiting'` when not busy, and broadcasts a lobby update. When a player
becomes busy, the tracker cancels all pending challenges involving that player.
Challenges to/from non-waiting players are rejected.

**When the session ends** (broader session phase becomes `resolved`, including
any pending hands having finished), the player app sends `set_busy` with
`busy: false`. The tracker sets the player back to `'waiting'` and broadcasts
the update.

The lobby iframe receives the updated `Player.status` via the normal
`lobby_update` broadcast and renders busy players as unavailable. No
iframe-side protocol changes are needed — it is read-only for this signal.

---

## Implementation Status

### Currently implemented

- **Tracker connection**: `TrackerConnection` class with auto-reconnect,
  backoff, and keepalive (`front-end/src/services/TrackerConnection.ts`).
- **Peer relay**: Message relay through tracker WebSocket with numbered
  ack protocol, reorder queue, and keepalive
  (`front-end/src/hooks/WasmBlobWrapper.ts`).
- **Peer liveness**: 60-second activity timeout with 5-second polling
  interval in `Shell.tsx`. Tracker liveness with 45-second timeout.
- **Tracker `close()`**: Protocol-level session end that notifies peer and
  removes pairing (`TrackerConnection.close()`).
- **Session persistence**: `SessionState` in localStorage with serialized
  WASM cradle, message numbers, unacked messages, etc.
  (`front-end/src/hooks/save.ts`).
- **Resume on reload**: Boot state machine with resume dialog, lease system
  for tab conflict detection (`Shell.tsx`).
- **Channel state tracking**: `ChannelStatus` notifications from WASM with
  full state machine (`useGameSession.ts`). `isWindingDown()` helper for
  UI gating.
- **Go on-chain and clean shutdown**: Both implemented in WASM wrapper and
  exposed through `useGameSession`.

### Recently implemented

- **Wallet disconnect preserving session**: `handleDisconnectWallet` no
  longer calls `clearSession()`. The session save is preserved across
  wallet disconnects; blockchain operations stall until a wallet is
  reconnected. (`Shell.tsx`)

- **Session state surfaced to Shell**: `GameSession` reports coarse session
  phase (`off-chain | on-chain | resolved`) and an error flag to Shell via
  the `onSessionPhaseChange` callback. Shell tracks this as `sessionPhase`
  and `sessionError` state. (`GameSession.tsx`, `Shell.tsx`)

- **Terminal session detection and resolved display preservation**: When `sessionPhase`
  becomes `'resolved'` (derived from terminal channel states plus the absence of
  pending hand obligations), Shell stops live protocol interaction, resets
  internal refs (`sessionStartedRef`, `activePairingTokenRef`), and marks the
  player as not busy. The game UI stays visible as a read-only resolved display
  until a new match replaces it, and a reload may restore that finished view.
  Chat persists across session boundaries and is only cleared when a new pairing
  starts. Terminal error or suspect outcomes are carried separately via
  `sessionError`.

- **Game message filtering on-chain**: `WasmBlobWrapper` has an `onChain`
  flag. When set, `deliverMessage()` acks but does not deliver inbound game
  messages to the WASM cradle, and `dispatchEvent()` suppresses outbound
  `OutboundMessage` events.

- **Tracker busy signaling**: `TrackerConnection.setBusy()`
  sends `{ type: "set_busy", busy }` over the game WebSocket.
  The `identify` message includes the current busy bit. Shell calls
  `setBusy(!(sessionPhase === 'none' || sessionPhase === 'resolved'))` whenever
  the broader session phase changes, while restore blocking keeps unresolved
  restores busy until reconciliation completes. A resolved session no longer has
  an active game obligation, so the player can be available for a new match even
  if the existing relay/chat is still visible.

- **Tracker-side `set_busy` handler**: The tracker server accepts
  `set_busy` messages on the game channel. It updates the player's lobby
  status to `'playing'`, `'busy'`, or `'waiting'` and broadcasts a lobby update.
  When busy becomes true, pending challenges involving that player are cancelled;
  challenges to/from non-waiting players are rejected. (`lobby-service/src/index.ts`)

- **Tracker retry budget**: `TrackerConnection` now has a
  `MAX_RECONNECT_ATTEMPTS` budget. After the budget is exhausted, the
  tracker is declared permanently dead and `onClosed` fires.

- **User-initiated tracker disconnect**: A "Disconnect" button in the
  tracker tab header allows explicit tracker disconnect. Gated by a cascade
  warning if peer/session would be affected.

- **User-initiated peer disconnect**: A "Disconnect" button in the Chat tab
  sends `close()` via the tracker, ending the pairing. If the session is
  off-chain, losing the peer automatically cascades to on-chain.

- **Automatic peer-loss cascade**: When the peer is lost (via `close()`,
  liveness timeout, or tracker notification) while the session is off-chain,
  Shell automatically calls `goOnChain()` on the WASM cradle. No user
  prompt — this is the cascade rule: off-chain + no peer = on-chain.

- **Cascade warning dialogs**: Confirmation dialogs currently warn before
  disconnecting or switching trackers when a peer/session would be affected.
  Peer disconnect and the explicit "Go On-Chain" button do not currently prompt.

---

## UX: Connectivity Indicators

### Tab dots

Each tab in the tab bar has a small colored dot to the left of its label
text, indicating the connectivity health of the axis associated with that
tab. The dot is always present (gray when idle/irrelevant) so the tab bar
layout never shifts.

Separately, the existing upper-right notification dots indicate unread
activity (unread chat messages, new game events, etc.). These are unchanged
and serve a different purpose.

### Per-tab color semantics

| Tab | Green | Yellow | Red | Gray |
|-----|-------|--------|-----|------|
| Wallet | Connected | — | Disconnected | — |
| Tracker | Connected | Reconnecting | Inactive (no heartbeat) | Not connected (null / disconnected) |
| Game | Off-chain, peer up | On-chain (resolving) | Error state or peer lost while off-chain | No session |
| Chat | Peer connected | — | — | No peer |
| History | — | — | — | Always gray |
| Log | — | — | — | Always gray |

### Game tab dot priority

The Game tab dot checks conditions in this order:

1. `sessionPhase === 'none'` → **gray** (no session)
2. `sessionError` → **red** (genuine error — always wins)
3. `sessionPhase === 'on-chain'` → **yellow** (actively resolving — overrides peer-lost red because peer loss auto-transitions to on-chain)
4. `sessionPhase === 'off-chain'` and `!peerConnected` → **red** (peer lost while off-chain, briefly visible before auto-transition)
5. `sessionPhase === 'off-chain'` and `peerConnected` → **green** (playing normally)

### Game tab error conditions (red dot)

The Game tab shows a red dot when `sessionError` is true or when the peer
is lost while the session is off-chain. `sessionError` is derived from:

- `Failed` channel state — the channel encountered an unrecoverable error
- `ResolvedStale` channel state — the channel resolved but the outcome is
  suspect (e.g., opponent exploited a timeout)
- `opponent-successfully-cheated` game terminal — the opponent submitted an
  invalid state and profited from it
- `game-error` game terminal — a generic game-level error
- `we-timed-out` with `cleanEnd = false` — a premature timeout where we
  failed to post a move or the user didn't move in time

A timeout with `game_finished = true` (the game had naturally ended, i.e.,
the validation program was `nil`) is **not** an error — it produces a
"Game ended cleanly" label regardless of who timed out.

### Timeout labels

The frontend uses `game_finished` from `other_params` and the current
`turnState` to produce context-aware timeout labels:

| Status | `game_finished` | `turnState` | Label |
|--------|----------------|-------------|-------|
| ended-we-timed-out | true | (any) | "Game ended cleanly" |
| ended-we-timed-out | false | replaying / their-turn | "We timed out while trying to post a move" |
| ended-we-timed-out | false | my-turn / other | "We timed out while waiting for user to move" |
| ended-opponent-timed-out | true | (any) | "Game ended cleanly" |
| ended-opponent-timed-out | false | (any) | "Opponent timed out" |

### Button placement

- **Disconnect Tracker**: In the tracker tab header strip, right-aligned
  next to the "Connected to {trackerOrigin}" text.
- **Disconnect**: In the Chat tab header bar, visible when a peer is
  connected. Ends the pairing via the tracker; peer loss cascades to
  on-chain automatically if a session is active. The header also shows
  the opponent's alias when connected.

### Not yet implemented

_(No remaining items from the original design.)_
