# Frontend Architecture

This document describes the architecture of the frontend JavaScript/TypeScript
code. It reflects the current implementation unless explicitly marked as a future
direction.

This player is a security-sensitive application that constructs and submits
transactions controlling real value. JavaScript/TypeScript is therefore treated
as an integration and presentation environment, not as the authority for
protocol or transaction correctness. Value-bearing rules, transaction intent,
wallet-output validation, and durable protocol/retry state belong in Rust.

For the backend/WASM architecture, see `OVERVIEW.md`. For the connectivity
model (wallet, hub, peer, session interactions and rollover), see
`CONNECTIVITY.md`.

## System-Level View

The system consists of two separate deployable artifacts:

1. **Player App** — A fully static HTML/JS/CSS application. This is the main
   application that players run. It contains the wallet connection, WASM cradle,
   game session logic, and all game UIs. It is served as static files with no
   server-side logic. No cookies, no server-side sessions.
2. **Hub** — A separate dynamic service that provides two things: a hub UI
   for matchmaking (loaded as an iframe inside the player app), and a WebSocket
   relay that ferries game messages between peers.
   The hub is
   third-party code — anyone can run one, and players choose which hubs to
   connect to. The hub holds no cookies and requires no authentication.

The player app is static code and does not fetch a hub list from its own
server. The user enters a hub URL in `HubPicker` (or uses the local dev
shortcut), and Shell creates both the hub iframe and game relay connection from
that origin. The selected hub URL may be remembered in localStorage so the
app can reconnect on reload, but the current UI does not maintain or display a
history/list of previously used hubs. A richer local hub list is future
work.

### Peer Messaging

All game messages between peers are relayed through the hub service. Both
players connect to the same hub with a shared token, and the hub routes
messages between them. This is simple and works well behind NATs,
but it means the hub must stay connected for the duration of the session.

Per-session peer state is encapsulated in a **`PeerSession`** object
(`front-end/src/services/PeerSession.ts`). Each game session gets one
`PeerSession`; it owns the session ID, peer ID, liveness tracking, message
buffering/routing, and outbound send methods. Shell holds a single
`peerSessionRef` (`PeerSession | null`) rather than the five individual refs
previously used for peer state. Destroying the PeerSession makes the object
inert — all further calls are no-ops.

A future option is to upgrade to WebRTC for peer-to-peer messaging after the
initial matchmaking. This would remove the hub as a runtime dependency once
both peers are connected, but adds ICE/STUN/TURN complexity. Game messages are
small and infrequent (a few per hand), so the relay approach is adequate for now.

### Player App / Hub Integration

The player app opens the hub HTML at `<hub-origin>/` for matchmaking UX, then
passes the hub session ID directly to that iframe with an origin-restricted
`postMessage`. The credential is never placed in the iframe URL. How that page
communicates with its own service is internal to the hub and out of scope. The
player app separately opens a game relay WebSocket at `/ws/game`; that
connection carries match notifications and peer payloads.

The player app persists one random master secret. For each canonical hub origin
it derives a distinct 16-byte hub session credential with HMAC-SHA256. The same
origin-scoped credential is supplied independently to that hub's iframe and
`identify` message; it is never reused at another hub origin.

The player app remains truly static files deployable on any web server with zero
configuration.

### Hub Relay Protocol

The player app's `HubConnection` uses one Bencodex dictionary format for every
binary `/ws/game` message, including addressed relays. It supplies the 16-byte
secret hub session nonce in `identify`; the hub assigns a separate 16-byte
public player ID for peer routing. Hexadecimal strings are only the reference
implementation's local/URL representation. The hub HTML's internal protocol is
not part of this architecture contract. Names in this section are descriptive
domain names; the game-channel boundary translates them to the compact `t` tags
and field keys specified in [`WEBSOCKET_PROTOCOL.md`](WEBSOCKET_PROTOCOL.md).

An `advisory_start` is not authority to begin a session by itself. Local
availability is authoritative:

- While mid-matchmaking or mid-session (`isAvailableForNewSessionPrompt()` is
  false): further `advisory_start` messages are **ignored** (no consent UI, no
  `session_reject` to the peer — advisory is hub-originated, not a peer request).
  Inbound `session_proposal` messages are **rejected** with `session_reject`.
- Clients do not special-case same-peer dual-initiator races (no yield / steal /
  auto-join). Mutual rejects cancel both attempts cleanly.

The player app self-declares whether it is `busy` over the game channel. Busy
means session obligation, walletless (`shouldReportHubBusy`), or that the active
blockchain backend is not yet ready for play (`blockchainReady === false`, folded
into `shouldReportHubBusy` / `shouldReportHubBusyPresence`). Readiness is owned by
the backend behind `InternalBlockchainInterface.isReadyForPlay()` /
`onPlayReadinessChange()`: the simulator and Cloud Wallet are ready whenever
connected. WalletConnect polls privately for a verified full-node peer when
the wallet grants that optional RPC; otherwise connectivity implies readiness.
The app still connects to the hub normally while a backend
is not ready; it just advertises busy. Shell mirrors the backend's readiness into
`blockchainReadyRef` via `onPlayReadinessChange`, and a wallet disconnect clears
it (the backend can no longer vouch for readiness). The `HubConnection` uses a
`getPresence` callback — provided by Shell — to derive the authoritative busy
state at connect and reconnect time for the `identify` message; it reads
`blockchainReadyRef` synchronously so a reconnect never reports a stale
not-busy. Aliases originate on the hub's internal interface and reach the
player app independently through `alias_updated`. Explicit
`setBusy(true)` is called when the user accepts a session (not when a consent
dialog is merely displayed). Idle / terminal clear paths must go through
`presenceBusy(...)` rather than bare `setBusy(false)`, so the backend-readiness
wait (and walletless busy) can still hold busy after a session ends. Showing a
session-consent dialog does not set busy; local availability
(`isAvailableForNewSessionPrompt`) still gates inbound advisories/proposals as
above. When the app later reports that it is not busy, the hub sets the player
back to `'waiting'`.

#### Game channel events

The tables below describe logical dictionary fields. Every `/ws/game` message
is one Bencodex dictionary selected by `type`. Peer app messages and WASM
protocol frames remain opaque bytes in the relay dictionary's `payload`.

**Player App → Hub:**

| Event      | Payload                             | Purpose                                                                                                                                               |
| ---------- | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identify` | `{ session_id: Bytes(16), busy }`   | Links this channel to the player's hub session and reports whether the player app currently considers itself unavailable.                             |
| `relay`    | `{ to: Bytes(16), payload: Bytes }` | Send opaque peer bytes to a specific public player ID.                                                                                                |
| `set_busy` | `{ busy }`                          | Update hub availability for the identified connection. `busy: true` cancels pending challenges involving the player; `busy: false` maps to `waiting`. |

**Hub → Player App:**

| Event              | Payload                                                                               | Purpose                                                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `registered`       | `{ player_id: Bytes(16) }`                                                            | Confirmation of routing identity. Sent in response to `identify`.                                                                                                                                                                                                                                                                                                                                          |
| `advisory_start`   | `{ peer_id, peer_alias, my_amount, their_amount, channel_timeout?, unroll_timeout? }` | The hub suggests starting a session with this peer (triggered by challenge acceptance in the hub). One-sided: only sent to the challenge accepter, who may become the channel initiator after local consent. Amounts are from the accepter's perspective. The client ignores advisories with invalid amounts or out-of-range timeouts (no consent UI; advisory is hub-originated, so no `session_reject`). |
| `relay`            | `{ from: Bytes(16), alias, payload: Bytes }`                                          | A peer payload with the hub-bound sender ID and hub-owned display alias.                                                                                                                                                                                                                                                                                                                                   |
| `delivery_failure` | `{ to }`                                                                              | The target peer is not connected; the message could not be delivered.                                                                                                                                                                                                                                                                                                                                      |
| `alias_updated`    | `{ alias }`                                                                           | Updates the player's own display alias independently of registration.                                                                                                                                                                                                                                                                                                                                      |
| `peer_available`   | `{ player_id: Bytes(16) }`                                                            | Advises that a recent correspondent connected; matching active peer state restores liveness and replays its own unacknowledged messages.                                                                                                                                                                                                                                                                   |
| `peer_unavailable` | `{ player_id: Bytes(16) }`                                                            | Advises that a recent correspondent disconnected; matching active peer state degrades liveness. Does not replay.                                                                                                                                                                                                                                                                                           |
| `hub_attention`    | `{}`                                                                                  | Signals that something happened in the hub that the user should look at.                                                                                                                                                                                                                                                                                                                                   |

**Connection lifecycle:**

1. Player opens a WebSocket connection to the hub game channel.
2. The iframe requests its origin-scoped credential with `postMessage`. The
   parent verifies both the requesting window and canonical origin, then replies
   only to that origin. The player independently sends `identify` with the same
   derived credential and current availability; no credential appears in a URL.
3. The hub associates this game channel with the hub session. If a
   previous game channel exists for this player, the hub closes it and
   replaces it.
4. The hub responds with `registered`, confirming the player's public ID.
5. When a challenge is accepted in the hub, the hub sends `advisory_start`
   to the accepter's game channel only. The app first checks its local
   availability. If it is already in a session, restoring, handshaking, or
   showing another consent prompt, it **ignores** the advisory (no
   `session_reject`).
6. If the accepter consents, that app becomes the channel initiator. It marks
   itself busy, generates a random 16-byte peer session ID, durably creates the
   peer reliability state, and sends a bencodex `session_proposal` as reliable
   data message 1. It starts the WASM session as initiator and sends the
   handshake through the same peer session and sequence-number stream. Starting
   persists session state asynchronously; a later `session_reject` (or local
   cancel) must abort that in-flight start so it cannot resurrect an orphan
   handshake.
7. The peer receives the `session_proposal`, checks local availability and
   validates amounts/timeouts and `network` at the trust boundary, adopts the
   enclosing frame's peer session ID, durably stores the pending proposal
   before acknowledging it, and shows its own consent prompt. Invalid
   amounts, out-of-range timeouts, or a `network` that is missing, malformed, or
   not equal to the local network preference are rejected with `session_reject`
   only —
   they must not clear a finished freeze or IndexedDB checkpoint. The hub is
   network-blind, so a cross-network match reaches this check and is rejected
   here before any consent UI (differing genesis challenges would break every
   signature). If unavailable or declined, it sends a reliable
   `session_reject`. The application attempt is cancelled immediately while the
   terminal rejection remains replayable until acknowledged. Receiving
   `session_reject` or `delivery_failure` during an Accept
   transition aborts that attempt with the same freeze-safe disposition as
   dashboard Cancel (peer-only abandon before the checkpoint write lands; full
   teardown after). Outside Accept, `session_reject` during pre-active
   matchmaking cancels the attempt (including any in-flight async start) and
   surfaces cancelled/error — it must not leave an orphan handshake; resolved
   finished sessions without an Accept in flight keep their freeze. If accepted,
   the peer marks itself busy, starts the WASM session as receiver, and attaches
   the WASM consumer to the existing ordered stream without resetting either
   counter. A start failure or dashboard Cancel before the live checkpoint
   write lands ends the peer attempt only (reject + clear provisional relay)
   and must preserve any finished freeze / terminal IndexedDB save; full attempt
   teardown is reserved for failures or Cancel after that persist succeeds. A
   start failure past the intake wall may also surface a session error warning.
   While an aborted Accept may still be draining its persist callback, the client
   stays unavailable for new session prompts so a second Accept cannot race
   checkpoint restore/cleanup.
8. Both players exchange session-scoped binary frames through the addressed hub
   pipe. Every data, acknowledgement, and keepalive frame carries the same
   16-byte peer session ID; the hub never interprets it.

**What the hub holds per game channel:** the session-to-player mapping,
WebSocket reference, and a bounded 30-minute graph of recent correspondents.
The graph contains no payloads or message numbers and exists only to emit
`peer_available` or `peer_unavailable` when a known route connects or
disconnects. The hub has no authoritative
session pairing, message log, delivery receipts, or game state. Failed sends
produce route-level `delivery_failure`; peer-owned ACK state decides what to
replay. A hub-control disconnect gets a short reconnect grace period before the
player leaves the visible roster. The identity mapping remains reconnectable
for up to 24 hours after its final lobby/game presence disappears, subject to
the retained-session capacity bound. Eviction atomically removes the player
identity, alias, pending challenges, and recent-correspondent edges.

#### Hub Liveness

TCP closes are not always reliable (half-open connections, NAT timeouts, proxy
buffering). The hub and clients maintain bidirectional application-level
keepalives at two separate layers:

1. **Game-relay keepalives** — Bencodex `{ t: 'K' }` dictionaries
   sent in both directions over `/ws/game` every 15 seconds. These prove the
   WebSocket connection itself is alive.
2. **Peer-level keepalives** — relay payloads with the peer reliability
   keepalive tag, relayed through the hub to the paired peer. These refresh the
   hub's recent-correspondent graph and are an advisory hint that the peer
   recently had a working path (see [Peer Liveness](#peer-liveness)). They do
   not trigger retransmission.

**Game channel client (`HubConnection`):**

- Uses a WebSocket connection to `/ws/game` and re-sends `identify` on reconnect.
- Starts a 15-second keepalive interval on `ws.onopen` that sends
  a Bencodex `{ t: 'K' }` dictionary to the hub. Cleared on
  close/error/disconnect.
- Fires `onHubActivity()` on every incoming `ws.onmessage` (any message
  type proves the hub is alive).

#### Hub Reconnection

On game-channel reconnect, `HubConnection` re-sends `identify` and waits for
`registered` before replaying unacknowledged peer messages. A matching
`peer_available` triggers the same peer-owned replay when the other endpoint
returns. Keepalives, duplicate frames, and the WebSocket reopen callback do
not replay. A changed own `player_id` is not a reconnect: it invalidates the route,
cancelling pre-active setup or automatically entering on-chain resolution for
an established off-chain channel.

`HubConnection` exposes `onHubDisconnected` and `onHubReconnected`
callbacks for logging/diagnostics around game channel stream health.

#### WebSocket Connection Discipline

All three WebSocket clients — `FakeBlockchainInterface` (simulator),
`HubConnection` (game channel), and `useHubSocket` (hub iframe) —
follow the same connection discipline:

1. **Backoff with jitter on reconnect.** The authoritative policy is
   [WebSocket Protocol §8.3](WEBSOCKET_PROTOCOL.md#83-reconnection):
   5, 10, 20, 30, and then 60 seconds, with a random 0.75-1.25x jitter factor.
   The attempt counter resets to zero on a successful `onopen`.

2. **Connection timeout.** Each `new WebSocket()` is given 30 seconds to reach
   `OPEN`. If `readyState` is still `CONNECTING` after 30 seconds, the socket
   is closed, which triggers `onclose` and feeds into the backoff reconnect.

3. **Avoid using unopened sockets as the active connection.** The hub and game
   clients track in-flight sockets separately from active sockets, and the
   simulator blockchain client only assigns its active socket after `onopen`.
   This lets cleanup abort a pending connection attempt without treating it as
   usable.

These properties are critical for local development, where all three clients
target the same host (`127.0.0.1`). Without backoff and timeouts, aggressive
reconnect attempts (especially after connection-refused RSTs) can trigger
browser-level per-host connection throttling, causing multi-second freezes
across all connections to that host — even connections from different browser
contexts (e.g. the hub iframe vs. the main app).

**Hub scope:** The hub negotiates only session setup terms: each player's
channel buy-in contribution and the channel/unroll timeout block counts. The
hub UX defaults to equal buy-ins and 15-block timeouts, but accepts
asymmetric buy-ins and timeout values in the 3-30 block range. The hub
service rejects invalid challenge terms before forwarding them to the target
hub, and the target hub auto-declines invalid terms if they are ever
received. Game type and per-hand terms are negotiated inside the state-channel
session via game proposals, which allows players to switch between supported
games from hand to hand without rematching in the hub.

**Future direction: connection identifiers.** The MVP supports one paired
session per game channel. A future extension adds a `connection_id` field to all
events, allowing multiple simultaneous sessions through one hub.

### Session Persistence

The canonical model is
[Persistence transactionality](OVERVIEW.md#persistence-transactionality):
each legitimate drain owner captures only its authoritative or unresolved
fixed-point durable residue. Rehydrating the latest successful boundary supplies
implicit crash rollback; this is not continuous save and does not imply that
every changing or important value is durable. Network connections (wallet
backend, hub) treat a reload like a remote drop and reconcile in the background.

The one exception is the **restore / start over dialog**: when a saved game
session exists, the app asks the user whether to resume or discard it before
proceeding. This is intentional — silently resuming a stale or unwanted session
could be worse than asking.

This is always-on — not a feature the user opts into.

#### WASM–JS trust model

The WASM module and its host JavaScript execute in the **same trust domain** —
they are served from the same origin, run in the same process, and share the
same memory. The WASM-to-JS boundary is not a security boundary.

Sharing a security domain does not make the layers interchangeable. Browser
JavaScript has a large, dynamic API surface and provider-specific failure modes.
It should transport opaque values, adapt wallet/browser APIs, and render
Rust-owned facts. Logic equivalent to backend business logic—especially
authorization, protocol transitions, spend construction or validation, fee
policy, and durable retry decisions—must remain in Rust unless an external API
can only be invoked from JavaScript. In that case JavaScript reports a typed raw
outcome and Rust retains the authoritative state.

Private keys (channel, unroll, referee) are intentionally included in the
serialized cradle state. Without them, a deserialized session cannot resume
signing and the game would be unrecoverable after a page reload. Any
JavaScript that can call `serialize_cradle()` can equally call every other
exported WASM function (`make_move`, `go_on_chain`, etc.), so withholding keys
from the serialized form would not meaningfully limit an attacker who already
has script execution in the same origin.

The actual security boundaries are:

- **The browser origin** — isolates the player app from other web content.
- **The WebSocket connection to peers** — all peer messages are untrusted and
  validated by the WASM engine before acting on them.
- **The blockchain** — on-chain spends require valid aggregate signatures that
  only the two channel participants can produce.

#### RNG non-serialization

The game cradle's `ChaCha8Rng` (used for move entropy and identity
generation) is **not** serialized. The `ChaCha8SerializationWrapper`
emits nothing for the RNG field (`#[serde(skip)]`) and deserializes to a
zeroed placeholder via `Default`. On restore, `restore_session`
always takes a fresh `new_seed` parameter from JavaScript, hashes it, and
creates a brand new `ChaCha8Rng` — the deserialized placeholder is
immediately overwritten. This avoids persisting seed material and
guarantees fresh entropy after every save/restore cycle. The RNG is used
only for commit-reveal preimages and initial key generation, not for
cryptographic nonces or signatures (BLS signatures are deterministic).

#### What is saved (`DurableApplicationState`)

IndexedDB v5 holds one `application-state/current` record and one coordination
store. The application record is a salt-prefixed, obfuscated Bencodex binary
value; obfuscation deters casual inspection but is not a security boundary.
The strict `chia-gaming-application-state` v3 root contains common
identity/preferences/history, an optional `pre-handshake`, `live`, or
`terminal` session, one canonical wallet context with wallet obligations, and
bounded rejection transports. The serialized WASM cradle and unacknowledged
frames remain raw `Uint8Array` values. localStorage contains only coordination
and resume/reset hints; it is not preference or application-state authority.

The nested Rust/WASM cradle is opaque schema 22. No app-owned persistence format
has shipped, so only aggregate v3 decodes: there are no migrations, fallback
decoders, aliases, or predecessor reads. Unknown or missing fields, a malformed
session, wallet obligation, rejection transport, hand state, or incompatible
version reject the whole root and present Retry Hard Reset. Nothing is deleted,
pruned, or preferentially salvaged during corruption handling.

The one decoder is used for pre-write and IndexedDB reads and always constructs
the normalized `SessionModel`. Game-owned `handState` must restore through its
registered package. The optional session discriminant owns its exact payload:
pre-handshake owns pairing and transport, live adds the opaque cradle and
presentation, and terminal owns frozen facts and presentation. Rejection
transports and wallet obligations are nested sibling slices of the same root,
so one capture and one write cannot observe mixed generations.
The live and terminal `presentation` payload explicitly encodes every durable
collection, nullable identity, flag, balance, and timer absence. Transient
notification queues and dismissal residue are reconstructed at runtime instead.
The following fields are grouped under those phase-owned payloads:

| Field                                 | Type                                                 | Purpose                                                                                                                                                                                                                                                                                                         |
| ------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                             | `bigint`                                             | Aggregate version; currently `3`.                                                                                                                                                                                                                                                                               |
| `walletContext`                       | `WalletProviderScope \| null`                        | Single canonical provider/account scope for the session and nested wallet obligations.                                                                                                                                                                                                                          |
| `playerId`                            | `string`                                             | Stable local hub/player identity for this browser state.                                                                                                                                                                                                                                                        |
| `sessionId`                           | `string?`                                            | Local master secret used to derive a distinct hub iframe/game-channel credential for each canonical hub origin.                                                                                                                                                                                                 |
| `alias`                               | `string?`                                            | Local hub display alias preference.                                                                                                                                                                                                                                                                             |
| `theme`                               | `'dark' \| 'light'?`                                 | Persisted player app theme.                                                                                                                                                                                                                                                                                     |
| `defaultFee`                          | `bigint?`                                            | Default transaction fee preference.                                                                                                                                                                                                                                                                             |
| `feeUnit`                             | `'mojo' \| 'xch'?`                                   | Display/editing unit for the transaction fee preference.                                                                                                                                                                                                                                                        |
| `hubUrl`                              | `string?`                                            | Last selected hub origin for reconnect on reload.                                                                                                                                                                                                                                                               |
| `activeTab`                           | `string?`                                            | Last selected top-level tab.                                                                                                                                                                                                                                                                                    |
| `unreadGame`                          | `boolean?`                                           | Whether the Game tab has unread activity.                                                                                                                                                                                                                                                                       |
| `walletAlert`                         | `boolean?`                                           | Whether the Wallet tab should show an alert dot.                                                                                                                                                                                                                                                                |
| `hubAlert`                            | `boolean?`                                           | Whether the Hub tab should show an alert dot.                                                                                                                                                                                                                                                                   |
| `blockchainType`                      | `'simulator' \| 'walletconnect' \| 'cloud'?`         | Which wallet backend is active or should be reconnected.                                                                                                                                                                                                                                                        |
| `serializedGameSession`               | `Uint8Array?`                                        | Raw binary WASM game-session state via `serialize()`.                                                                                                                                                                                                                                                           |
| `gameSessionSchemaVersion`            | `bigint?`                                            | Rust-owned schema ID for `serializedGameSession`; currently `22`. Missing or mismatched IDs are unsupported and cleared before deserialization.                                                                                                                                                                 |
| `pairingToken`                        | `string?`                                            | Locally generated identity for the current peer-session/controller instance. It is persisted so pre-cradle setup or a full session resumes into the same instance, and it correlates Shell transition completion with that instance; it is not protocol authority.                                              |
| `sessionPeerId`                       | `string?`                                            | Public hub peer id of the current opponent, used to rebind `PeerSession` on restore.                                                                                                                                                                                                                            |
| `myHubPlayerId`                       | `string?`                                            | Last public player id assigned by the hub, used only to detect remapping during resume.                                                                                                                                                                                                                         |
| `gameSessionId`                       | `string?`                                            | Canonical lowercase-hex storage representation of the 16-byte peer session ID carried by every reliable frame. Required whenever pairing/transport state exists.                                                                                                                                                |
| `messageNumber`                       | `bigint?`                                            | Next outbound semantic-message sequence number within the peer session.                                                                                                                                                                                                                                         |
| `remoteNumber`                        | `bigint?`                                            | Last durably delivered inbound semantic-message sequence number within the peer session.                                                                                                                                                                                                                        |
| `iStarted`                            | `boolean?`                                           | Whether this player was the channel/session initiator.                                                                                                                                                                                                                                                          |
| `terminalIStarted`                    | `boolean?`                                           | Display-only initiator role retained after terminal protocol fields are cleared.                                                                                                                                                                                                                                |
| `myContribution`                      | `string?`                                            | This player's channel buy-in contribution as a decimal bigint string.                                                                                                                                                                                                                                           |
| `theirContribution`                   | `string?`                                            | Opponent's channel buy-in contribution as a decimal bigint string.                                                                                                                                                                                                                                              |
| `perGameAmount`                       | `string?`                                            | Default per-hand amount as a decimal bigint string.                                                                                                                                                                                                                                                             |
| `channelTimeout`                      | `string?`                                            | Channel timeout retained for pre-cradle handshake resume.                                                                                                                                                                                                                                                       |
| `unrollTimeout`                       | `string?`                                            | Unroll timeout retained for pre-cradle handshake resume.                                                                                                                                                                                                                                                        |
| `rewardPuzzleHash`                    | `string \| null`                                     | Immutable reward/change address for the active session, or `null` when none is active.                                                                                                                                                                                                                          |
| `unackedMessages`                     | `Array<{ msgno, msg }>?`                             | Outbound Bencodex semantic-message bodies, including negotiation messages, that have not been acknowledged by the peer.                                                                                                                                                                                         |
| `terminalHandoff`                     | `{ id, message, msgno, sent, acknowledged } \| null` | Exact cooperative terminal command-to-frame binding; restore reuses its frame or completes an already-ACKed Rust command.                                                                                                                                                                                       |
| `humanHistory`                        | `string[]?`                                          | Recent user-facing transcript entries (capped at 1,000).                                                                                                                                                                                                                                                        |
| `wasmNotificationHistory`             | `string[]?`                                          | Recent serialized WASM notifications (capped at 1,000).                                                                                                                                                                                                                                                         |
| `diagnosticLog`                       | `string[]?`                                          | Recent complete diagnostic entries, capped at 256 KiB total UTF-8 text; an individually oversized entry is dropped deterministically, and 2,000 entries remains a secondary cap.                                                                                                                                |
| `handKey`                             | `bigint`                                             | Monotonic host hand lifetime key. Reload preserves values greater than one so a restored hand keeps its identity.                                                                                                                                                                                               |
| `activeGameIds`                       | `string[]`                                           | IDs of currently live games in an atomic group; empty when none are active.                                                                                                                                                                                                                                     |
| `currentHandGameIds`                  | `string[]`                                           | IDs belonging to the current hand group; empty when there is no retained hand.                                                                                                                                                                                                                                  |
| `lastDisplayedGameId`                 | `string \| null`                                     | Key of the game instance selected for display when no active game supersedes it.                                                                                                                                                                                                                                |
| `gameInstances`                       | `Record<string, …>`                                  | Keyed-only per-game protocol snapshots: amount, coin, canonical `GameProtocolPresentation`, and terminal data.                                                                                                                                                                                                  |
| `currentHandOrigin`                   | `'local' \| 'peer' \| null`                          | Canonical origin of the current hand, owned by the game slice and retained through independent member settlement and terminal display.                                                                                                                                                                          |
| `activeGameType`                      | `string`                                             | Current registered game type (`calpoker`, `spacepoker`, or `krunk`).                                                                                                                                                                                                                                            |
| `handState`                           | `PersistedGameState \| null`                         | Opaque game-owned state envelope (`gameType`, payload) for live restore and finished remounts.                                                                                                                                                                                                                  |
| `channelStatus`                       | `ChannelStatusPayload \| null`                       | Last Rust-owned canonical snapshot for UI restore: actual channel lifecycle plus optional local `session_disposition`, advisory, coin identity/amount, balances, allocation, potato ownership, and `zero_payout`. It is normalized once into `ChannelStatusModel` before any view or lifecycle policy reads it. |
| `myAlias`                             | `string?`                                            | Local player display name for the active pairing/session.                                                                                                                                                                                                                                                       |
| `opponentAlias`                       | `string?`                                            | Opponent display name for the active pairing/session.                                                                                                                                                                                                                                                           |
| `coinsOfInterest`                     | `Array<{ label, id }>?`                              | Actual live coin list frozen for terminal display.                                                                                                                                                                                                                                                              |
| `cleanShutdownStarted`                | `boolean`                                            | Whether clean shutdown has been requested.                                                                                                                                                                                                                                                                      |
| `betweenHandMode`                     | `string`                                             | Between-hand overlay state.                                                                                                                                                                                                                                                                                     |
| `betweenHandCompose`                  | `{ selected_game, game_timeout }`                    | User-authored host compose values. `proposalSent` is derived after restore from unresolved local outgoing/cancel-queued proposal lifecycle; transient game controls remain mounted package form state.                                                                                                                                    |
| `betweenHandLastHandProposal`         | `SavedHandProposal \| null`                          | Last agreed generic A/B-oriented hand proposal, including the exact opaque `parameters`. Null when there is no agreed hand yet.                                                                                                                                                                                 |
| `betweenHandRejectedOnceHandProposal` | `SavedHandProposal \| null`                          | Hand proposal already rejected once, used to avoid repeated automatic retries.                                                                                                                                                                                                                                  |
| `betweenHandPendingRetryHandProposal` | `SavedHandProposal \| null`                          | Local hand proposal waiting for retry after a proposal collision.                                                                                                                                                                                                                                               |
| `newHandRequested`                    | `boolean`                                            | Durable same-terms/new-hand intent. This is the single reducer source used for waiting UI and same-terms proposal collision handling.                                                                                                                                                                           |
| `pendingProposals`                    | `Array<{ id, hand_proposal, lifecycle }>`            | Scalar pending proposals keyed by endpoint-local ID. The lifecycle discriminant is local-outgoing, local-cancel-queued, peer-cached, peer-review, peer-accept-queued, or peer-cancel-queued; generated game members never enter this collection.                                                                |
| `waitingStateEnteredAt`               | `bigint \| null`                                     | Epoch ms when the channel entered an abandon-eligible waiting state.                                                                                                                                                                                                                                            |
| `cleanShutdownGraceStartedAt`         | `bigint \| null`                                     | Epoch ms when the clean-shutdown grace timer started.                                                                                                                                                                                                                                                           |

Unsent package form edits, toasts, connection liveness, and derived view models
remain ephemeral. The durable compose fields above cover only submitted or
session-coordination intent, not in-progress game-specific controls.

#### Save architecture

`StorageRepository` is the sole aggregate owner. It atomically claims
coordination authority and reads the root, serializes semantic transforms, and
writes complete captures. Claims, authority loss, and hard reset publish a new
monotonic lifecycle generation so transient runtimes can fence stale
completions. Ordinary I/O failure leaves the latest in-memory aggregate pending
and still releases permitted effects; authority loss retires the obsolete
runtime and releases nothing. `WalletOperationRuntime` owns transient provider
orchestration over the root's wallet-obligation slice.

Session persistence is executed by `SessionMachineRuntime`, the sole active
commit coordinator. A capture combines two authoritative sources:

1. **WASM-native state** — `SessionController.getWasmFields()` returns the
   cradle serialization, message counters, protocol state, history, aliases,
   and other fields that originate inside the WASM bridge.
2. **JS session state** — the current `SessionMachineState`: keyed game
   protocol presentation, game-owned durable payload envelope, user-authored
   compose values, unresolved proposal intent, and between-hand mode.

The two timer timestamps have one dedicated durable owner in
`SessionController`. Shell schedules the browser timers, but changes enter the
runtime coordinator and aggregate capture reads the controller-owned facts
synchronously with the cradle boundary; no cache patch may compete with a
machine checkpoint.

The following ordering is a design invariant for every active-session stimulus,
including work resumed after rehydration:

1. Reduce the stimulus and continue through commands, controller/WASM results,
   generated events, and UX-model feedback until no synchronous work remains.
2. Synchronously freeze the resulting JS, WASM, and reliable-transport state.
3. Await one persistence attempt for that captured boundary.
4. Project the captured state to React.
5. Finalize peer sends, acknowledgements, wallet/chain work, and completion
   callbacks exactly once.

“UX-model feedback” is reducer state and belongs inside the drain; React
rendering is an externally visible projection and belongs after persistence.
This distinction lets the UX participate fully in event processing without
displaying intermediate states. It is the general flicker-prevention rule, not
a collection of feature-specific rendering exceptions.

The pure root reducer returns the next unpublished authority and ordered
commands. `SessionMachineRuntime` drains reducer events, reentrant controller
events, WASM results, and generated commands to a fixed point. It then persists
or attempts to persist one combined snapshot, publishes the final authority to
React once, and releases the staged effects. Games dispatch a `GameIntent`.
A command result distinguishes rejection, queueing, and actual application. A
game mutates its concrete hand before requesting an action; the public intent
carries no state. The runtime keeps the previous canonical
`handState` only as a temporary synchronous checkpoint while it calls Rust. A
synchronous command exception or `MoveRejected` restores that checkpoint. If
Rust accepts the action as queued or already applied, the runtime rereads
`getState()`, commits the mutated complete hand canonically, and persists it in
the same session snapshot as the serialized Rust queue. There is no persisted
checkpoint and no `pendingCandidates` state. `LocalActionApplied` is a host-only
protocol-presentation fact; it can update the keyed turn presentation, but it
does not promote game-owned state and does not grant game permission. Rejection
is not delivered to the game.
Before starting the asynchronous write, aggregate capture synchronously
captures game-owned canonical `handState`, the serialized WASM cradle, and the
reliable boundary into one immutable save input. Every package
has one `render(view)` mount. Its `frozen` boolean is a type discriminant: only
the live branch has an intent port. It is not per-move permission; game controls
derive availability from their own handler, turn, and terminal state. The view
contains the hand, hand origin, player display names, and the live-only logging
service. Accepted stakes, factory-ordered member state, and terminal outcomes
are part of the complete hand state rather than parallel mount projections.
Protocol IDs remain in the host session model and never enter package state. A new
`handKey` creates a fresh component and `GameHand` lifetime.
Every successful mutating WASM command marks the same runtime transaction dirty
even when it emits no events; read-only polling does not. The runtime keeps
intermediate machine states unpublished. Stimuli arriving while persistence is
in flight are retained for the next transaction and cannot alter the snapshot
or React projection being committed.
Code must not bypass this boundary with an active-session save timer, direct
effect persistence, an intermediate render, or an eager reliable send. New
controller, wallet, chain, game, and peer event sources enter the coordinator
and are drained by the same rule. A failed browser write reports a persistent
warning but is not permission to stop a game for money: protocol/UX progression,
wallet cleanup, transaction submission, and peer frame/ACK release continue
once. The current in-memory boundary remains dirty, and later activity retries
a full checkpoint with every still-unresolved durable intent without replaying
released effects. A successful retry clears degraded durability. A crash before
that retry succeeds can restore an older local checkpoint; this degraded window
is an explicit availability-over-durability choice, not an effect gate.
`releaseAfterPersistence(key, launcher)` deduplicates an effect only while that
key is pending and returns the same completion promise to every duplicate
caller. The persistence attempt gates invoking `launcher`, not completion of
the promise it returns: the coordinator proceeds without awaiting that external
work, while callers can still observe its eventual success or failure. The key
is removed before invocation, so reentrant work may schedule the same key for a
later captured boundary. `ReliableCommitCoordinator.enqueueResult<T>` is the
result-bearing companion to `enqueue`: it runs typed controller work inside the
same serialized runtime transaction and resolves or rejects its promise when
that work executes, including when an active commit temporarily queues it.

Runtime construction itself is inert. The committed React layout effect first
installs the render callback and then calls `activate()`, which attaches an
exclusive, retire-aware `SessionMachineRuntime`; its cleanup only calls
`clearRender()`. React cleanup therefore cannot retire protocol ownership.
Replacement of the committed runtime and `SessionController` cleanup—including
terminal cleanup—own retirement. Retirement discards queued events and
fire-and-forget controller work, rejects queued result promises and
not-yet-launched persistence-gated effects, and makes completion from an
in-flight write inert. An obsolete runtime therefore cannot publish, persist,
or release effects after replacement. The runtime directly implements the
peer `ReliableCommitCoordinator` facet and provides `snapshotModel()` for the
authoritative runtime model. Controller capabilities hide the only
retire-before-launch retry loop from submission and coin-delivery callers.

`WalletOperationRuntime` attaches one stable funding inbox per session and owns
the durable operation lifecycle; there is no replaceable demand identity or
duplicate persisted funding queue. `amount`, `fee`, and optional `max_height` are canonical
decimal `u64` strings; every condition opcode is a bounded `bigint` `u32`;
absent `coin_id` and `max_height` options are omitted, never stored as null.
Distinct concurrent requests are an internal protocol-state violation. Rust
remains the durable owner of submission/retry intent; `SubmissionPump`
serializes one-shot wallet delivery and reports the typed outcome back to Rust.

The external wallet constructs each funding offer from Rust's canonical
request; Rust validates the result. Rejection terminates the handshake and does
not create controller-owned successor or predecessor requests. Persisted
funding and fee offers enter the aggregate's strict wallet-obligation slice.
Every trade owns its exact provider trade ID and exact
`(installationPlayerId, peerSessionId, provider/account scope, purpose kind,
operationId)` identity;
one operation may retain multiple historical trades without conflating owners
or cleanup. Pending creation uses `creating` with its embedded canonical request
and exact recovery ID; pending cancellation uses `cancelling` with its exact
trade and recovery ID. A pre-ID response loss uses
`best-effort-uncertain`; the aggregate records its typed
`orphanRisk: 'pre-id-response-lost'` provenance and carries that marker through
a later `creating` recovery or created trade. Recovery reconciles exact
post-ID requests instead of starting replacements. Funding unavailability
remains pending; it is not converted into rejection. Post-creation stages include `reserved`,
`retained-for-replay`, and `cancel-required`. `creating` also records active
versus cancel-on-create disposition. An attached fee source remains retained
while Rust may replay its current exact variant; chain terminality or Rust
retirement moves it through typed cancellation before removal.
Controller retirement promotes only `reserved` entries; replay-retained fee
sources stay retained until Rust explicitly retires their stable submission.
Only reservation-creating offer, funding, or fee creation has this deliberate
duplicate-reservation risk: before a provider returns an ID, a lost response
can hide a successful external reservation, so one replacement is allowed on
each later readiness epoch and the orphan warning remains. Broadcasting the
same finalized spend through WalletConnect `pushTransactions` is instead
idempotent exact-byte replay; it creates no wallet-operation entry and carries
no orphan-risk provenance.
Wallet mutation starts only after the aggregate claim is installed. Malformation
of any nested field rejects the whole root and remains visible on Resume /
Start Over. A connected provider/account scope that differs from the durable
owner is shown as a recovery mismatch rather than touching the wrong wallet.

The complete aggregate is written in one IndexedDB transaction. Strict
validation rejects unknown or missing fields, duplicate trade IDs, invalid
discriminants, and non-current versions. Persistence failure does not gate
offer use, transaction release, or cancellation; the latest in-memory root is
captured again on later activity. Only the active-blockchain lifecycle attaches
the cancellation RPC. A failed cancellation stays durable and retries only on
restore, wallet reconnect/attachment, or an explicit terminal-finalization
attempt.
There is no timer or immediate retry loop, and terminal quiescence fails while
that session has any unresolved ledger entry. Going offline detaches the
provider RPC without discarding cleanup; retirement records the required
transitions, and the next matching lifecycle attachment drains them.

The app-owned persistence versions are aggregate v3, opaque Rust/WASM cradle
schema 22, and IndexedDB v5. None has shipped, so only the current aggregate
decodes.

Transaction submission and resubmission remain owned by Rust's
`TransactionManager`, not by a frontend transaction field.
Each retained submission has a stable Rust identifier and owns at most one
active delivery attempt. A drain carries expiry, an opaque Rust-issued token,
and immutable predecessor/relationship metadata. Rust emits the no-fee base
immediately when fee acquisition fails or is unavailable and continues seeking
after base acknowledgement. Matching provider readiness or an explicit
fresh-chain rebroadcast epoch may later upgrade that ID to a fee-bearing
variant; chain terminality stops acquisition. Rust deduplicates only an exact canonical intent fingerprint; two
different transactions that spend the same inputs retain different IDs.
Rejection retires only its exact ID. The manager separately retains wallet
delivery acknowledgement and chain finality. JavaScript makes one wallet call
and reports a typed `acknowledged`, `unavailable`, or `rejected` result:
acknowledgement ends ordinary app rebroadcast, while unavailability remains
eligible for replay after fresh chain synchronization. A lower-tip rollback
queues every surviving retained transaction once for that epoch. An
equal-or-higher replacement tip queues only the retained transaction whose
watched output is explicitly absent and whose own input is explicitly live.
Rollback and fresh-sync replay use the current exact Rust-owned variant without
rebuilding it or creating a second wallet trade. Successful poll batches
represent every queried interest explicitly;
failed or malformed batches are not reported as authoritative snapshots.
The poller signals that coherent boundary only through `chain_snapshot_ready`.
If an exact attempted variant was unavailable, its successor waits for that
snapshot. A genuinely newer fee-bearing successor for the same stable intent
may launch immediately as a mempool replacement, and unrelated IDs remain
independent. JavaScript consumes the relationship emitted with the attempt and
returns only opaque tokens for outcomes; it never echoes delivery goals or
fingerprints as correctness input.
This chain operation is **transaction rebroadcast**. It is distinct from
**reliable peer-frame replay**, which resends unacknowledged numbered transport
frames only at reconnect or peer-availability boundaries.
`TransactionManager` is the durable retained owner of each transaction intent.
`SubmissionPump` spans the interval after Rust drains an intent through
persistence-gated launch, optional fee acquisition, exact-byte broadcast,
typed completion, and relinquishment. Committed-runtime replacement reschedules
only an unlaunched entry; the ordered queue retains launched work and terminal
quiescence. The pump is neither persisted nor a retry authority. Rust validates
stable identity before issuing each successor.
Likewise, move redo after an unroll is serialized Rust protocol state. The
frontend does not persist a move journal or receive replay instructions.
Following browser restore, an ordinary game effect may submit an automatic move
again only when the restored canonical state still precedes it. An action
accepted into Rust's durable queue commits the advanced hand state in the same
snapshot, so that queued or applied action does not autoplay again.

Puzzle/solution callbacks obey the same transaction boundary as coin
observations: Rust applies each callback against a serialized working copy of
the complete `TransactionManager` and nested session, committing manager state,
watch deltas, effects, and callback completion together only on success.
Outstanding requested coin IDs are durable Rust state; restore reissues each
still-live request once, while retire-aware controller completion prevents an
old runtime from delivering into its replacement. A successful wallet RPC does
not make its puzzle/solution bytes structurally trusted: malformed data is
fatal protocol evidence, leaves the request terminally blocked, and is not
retried on ordinary readiness or height triggers.

Submission draining applies the same isolation principle at item granularity.
WASM drains on a serialized canonical working copy and constructs the
JavaScript result before committing it, so conversion failure rolls back the
whole drain.
Each candidate is planned against a working copy; a malformed middle candidate
is consumed and reported once while valid candidates before and after it
commit. Rust emits retirement for abandoned retained submissions before
removing them. Only this proven-local failure class is recoverable: the host
persists one bounded incident with JavaScript stack and Rust context, displays
one dismissible nonfatal modal, and leaves the game/dashboard active without an
ordinary or global error duplicate. Unknown manager/session integrity remains
fatal. Release follows the live failed-checkpoint policy: attempt persistence,
release the isolated safe boundary once, and retain dirty in-memory state.

Rust local batch packaging is modular and host-invisible. `OffChainPhase`
exclusively owns a `BatchPlan` containing cloned channel state, queue
disposition, actions, and staged effects; planning changes only that value, and
commit installs the live state only after cached-unroll finalization succeeds.
The plan clones only durable protocol and queue working state. Transient,
nonserialized caches stay outside the transactional plan and are not cloned.
Rust tests access this through `GameSession`'s concrete test-only
`OffChainPhase` seam rather than production debug operations on the lifecycle
trait.

These runtime, persistence, and host ownership changes do not alter the peer
wire schema.

`GameSlice` atomically owns `activeIds`, `currentHandIds`, `currentHandOrigin`,
keyed instances, `lastDisplayedId`, hand key, and active game type. Its reducer updates a game
instance's coin and protocol presentation together, so there are no separately
mutable aggregate current-game fields that can drift across game IDs. A game
instance's initial turn is constructed by its package from
`GameHandInitialization.members[index].ourTurn`, Rust's authoritative
accepted-member turn. Protocol IDs remain host-only. A game hook computes a complete
next state by mutating its concrete hand, then submits a state-free protocol
request. `commitLocalGameAction` holds the old canonical state only across that
synchronous call. Rejection reconstructs the hand from the old checkpoint;
queueing or immediate application commits the new complete hand directly as
canonical. Game hooks never write
controller persistence state, interpret protocol replay, or call persistence
directly.
`GameSettled` retires only its own game ID from the slice's active set.
This allows separate members of an atomic factory group to settle independently
without removing the still-live member from persistence or presentation. Krunk's
two protocol IDs map to two independent factory-ordered member slots. A local or
inbound update clones the full hand, replaces only the addressed member, and
leaves its sibling's move/handler state untouched; the persisted opaque hand
state still contains both members.

Proposal state is one normalized `pendingProposals` collection. Each entry owns
one endpoint-local proposal ID, one `HandProposal`, and one lifecycle
discriminant that also determines local/peer origin. Rust alone maps that local
ID to the origin's parity-sequenced wire ID while the proposal remains pending.
Acceptance removes
the proposal and creates factory-ordered game members in `GameSlice`;
`InsufficientBalance` and proposal cancellation remove only the proposal.
Accepted games—including Krunk siblings—settle or receive `EndedCancelled`
independently by `GameID`. The aggregate v3 presentation makes
`gameInstances` plus `lastDisplayedGameId` the only persisted game protocol
presentation, stores the canonical `GameProtocolPresentation` discriminant,
and stores one canonical game-owned `handState` without a pending-candidate
sidecar.
This schema does not migrate incompatible records from aggregate current-game
fields; they are deleted instead.

The current frontend admits at most one uncancelled proposal across local and
peer origins. An additional incoming proposal is automatically and definitively
cancelled without being inserted into `pendingProposals`; a
`local-cancel-queued` or `peer-cancel-queued` entry does not block its
replacement. This is intentionally a single-hand presentation capability, not
a Rust or wire invariant. Rust retains multiple proposals so planned multi-hand
UX can lift this frontend policy without a protocol migration.

Rejecting an incoming proposal returns the unpublished model to compose as soon
as the cancel command succeeds. There is no `expectingCounterProposal` flag or
timer. Any crossed `ProposalMade` in the same runnable event wave is reduced
before the single post-persistence React projection, so intermediate compose
state is not displayed.

#### Delivery-critical saves

Peer message counters and queues are part of the reliable transport protocol.
The shared reliability owner exists before the WASM controller: it increments
`messageNumber`, appends every outbound semantic body to `unackedMessages`, and
stages the actual WebSocket send. When an inbound body is delivered to
negotiation or WASM, it advances `remoteNumber` and stages the ack. With a live
runtime these allocations participate in the same fixed-point drain and active
commit as all other session work.

At quiescence `SessionMachineRuntime` drains machine, controller, and generated
work to a fixed point, then:

1. Captures the staged reliable generation together with the final WASM and JS
   working state.
2. Attempts exactly one whole-aggregate IndexedDB write.
3. Publishes the captured machine state to React once.
4. Releases the captured outbound messages and acknowledgements in order.

Pre-runtime negotiation uses the reliability owner's explicit flush path with
the same persist-before-send rule. Wallet operations separately checkpoint a
new obligation before provider mutation, while `StorageRepository` coalesces
preference/history drains outside protocol work. Those repository writes fold
sibling changes into the last complete session capture; they cannot observe or
persist a partially drained `SessionMachineRuntime`. See the canonical
[Persistence transactionality](OVERVIEW.md#persistence-transactionality)
policy for the field-admission rule.

On the normal path this preserves the transport invariant across reloads: the
peer observes a message or ack only after the local save contains the
corresponding `messageNumber`/`unackedMessages` or `remoteNumber`/cradle state.
A burst of events in one drain still causes only one full cradle serialization
and one IndexedDB transaction instead of one write per message.

If the transaction fails, the app shows one transient session-storage warning
and releases the prepared messages/acks anyway. Released and persisted
generations are tracked separately so a later successful save cannot duplicate
wire effects. The machine/WASM boundary remains dirty for a later
activity-driven retry; failure reporting does not immediately reschedule the
same failed write. This deliberately weakens crash recovery during degraded
storage rather than failing live play for an internal browser-storage problem.

Development builds log the raw cradle byte count, an estimated total IndexedDB
record size, the compact historical-unroll count when available, and all three
history counts. The record-size walk is skipped in production.

#### Prop-safe session values

`DurableApplicationState` contains raw `Uint8Array` cradles and message payloads plus
`bigint` fields. React props cannot safely deep-enumerate those values:

- Expanding a typed array into `{0:n,1:n,...}` destroys the cradle and makes
  WASM restore fail with bencodex `unexpected end of input`.
- Deep-cloning a degraded numeric-keyed byte object (or cloning the full
  session every render) can OOM the tab.

`reactPropSafeValue` / `sessionSaveForReactProps` leave `ArrayBuffer` views and
dense byte-objects alone, hide bigints as non-enumerable properties, and Shell
keeps a stable `sessionSavePropRef` so GameSession does not re-walk the save on
every parent render. Persistence never routes cradle bytes through this
React-prop path: it bencodex-encodes the complete aggregate, masks the
salt-prefixed bytes, and stores that single `Uint8Array` as the IndexedDB value.

This helper is an opaque persistence bridge, not a numeric conversion API.
Game hand instances, reducers, refs, and hook-local state retain canonical
`bigint` values, including through game-component props. React 19.2.8 or newer is
required together with the checked-in `react-dom@19.2.8` pnpm patch. The patch
applies React's upstream fix for development Performance Tracks incorrectly
passing primitive BigInt arrays to native `JSON.stringify`, which crashed
otherwise valid renders.

Synchronous local-action failures are emitted as scoped session errors and then
rethrow unchanged, preserving fail-fast invariants. Asynchronous runtime
failures enter the same session notification stream. A Shell-level browser
`error`/`unhandledrejection` reporter covers failures outside React boundaries
with a dismissible/reloadable dialog over the still-mounted game. It never
prevents the browser event and ignores error objects already reported through
the session path.

#### Session model ownership

Restore-sensitive UX state lives behind an MVC-style frontend session model in
`front-end/src/lib/session/`. The model records generic session facts from
WASM, hub, wallet/blockchain, restore snapshots, and user intents. Selectors
then derive the props consumed by `Shell`, `GameSession`, and game-specific
views.

The migration is intentionally incremental: existing screens should continue to
look and behave the same while individual state slices move from scattered React
state into selector-derived view models. Local React state should remain for
ephemeral display-only details such as input drafts, copied flags, hover state,
and drag positions. Restorable protocol/session facts should flow through the
model so normal play and restore use the same projection path.

The motivation is reliability, not architectural ceremony: normal display and
restore should be two ways of projecting the same session model. If a value needs
to survive reload or affect protocol/availability decisions, prefer putting it in
the model and deriving the view from selectors instead of maintaining a separate
React-only copy that restore has to reconstruct by hand.

`SessionModel` is the generic shell boundary. It owns the canonical keyed
protocol presentation and carries `handState` only as an opaque
`PersistedGameState { gameType, state }` envelope. The shell does not interpret
or validate the payload. Production games export a `GamePackage`; the host
contract, layout, and APIs are in [`GAME_WRITING_GUIDE.md`](GAME_WRITING_GUIDE.md).
`games/registry.json` is the only catalog. First-member initial validation
puzzle hashes live in `gameIdentities.ts` (warmup fills the table by running
factories with representative valid parameters; Active completes leftover
probes). The JS session model and saves store catalog keys (`calpoker`,
`spacepoker`, `krunk`). `packageFor` accepts those keys only. The puzzle hashes
are protocol ids at the WASM propose/notify boundary (`protocolIdForCatalog`
out, `catalogGameTypeFromWire` in). WASM and factory probes start on page load
so the protocol id table is filled before play. Each game may ship
`games/<key>/ui/styles.css`; the registry generator imports those files into
the player-app stylesheet, and Tailwind scans `games/` for utility classes.
Core never branches on Calpoker/Krunk/Space Poker when composing or reviewing a
proposal. Every playable package supplies `restoreHand` and a frozen mount, so
cold finished-session rendering attempts a restored read-only hand whenever a
valid persisted hand state exists.

**Game dashboard (status banner):** The compact strip above the Game tab content
(`GameDashboard` in `Shell.tsx`) is selector-driven. `selectGameDashboardView`
projects channel / lifecycle labels and the primary action button
(clean shutdown, go on-chain, abandon, etc.). `selectStatusBarBalances`
projects the balance segments under those labels. Both read from the shared
`SessionModel`; they are not a separate React-owned copy of channel state.
The expanded dashboard lists the current coins of interest and updates the list
whenever the live session model changes; it has no manual refresh control.
Game-associated entries use the accepted group's stable hand ordinal rather
than the private protocol game ID. A current game coin disappears when that
hand settles because the coin has been spent, while a newly created reward coin
can remain visible. During handshake this list includes the predicted channel
coin as soon as Rust can derive it. Coin parent IDs are protocol ancestry and
are not displayed.

During the short interval after the user accepts a session — before
`GameSession` has reported its first live model, and also while a prior finished
freeze model is still mounted until `retireTerminalDisplay` runs after async
`replaceSession` — Shell passes an explicit `setupPending` input to the same
dashboard selector. This makes the existing primary action show **Cancel**
immediately without introducing a second setup button or a parallel
cancellation path. Once a live (non-resolved) model exists, labels and actions
are entirely core-derived even if the session-pane transition is still pending:
handshake and wallet-signing statuses remain **Cancel**, while `OfferSent` /
`TransactionPending` cross the commitment boundary and project **Waiting** (or
the later timer-gated **Abandon** action).

The dashboard never derives whether a shutdown has value remaining from its
displayed balances or game state. Rust provides `channelStatus.zero_payout`
when shutdown begins. A `ShuttingDown` status with that flag set offers
immediate **Abandon** as a user-controlled escape hatch, but Rust continues the
cooperative close until it has supplied the peer with the completed close
spend. That zero-payout responder does not submit the transaction itself. Its
drain reports one typed terminal-handoff command; `SessionController` durably
persists, sends, and replays its complete-close message until the peer ACKs it,
while Rust reports `session_disposition: AwaitOutboundTerminal` so React keeps
the controller alive even if the channel snapshot becomes resolved. After the
ACK, Rust sets `session_disposition: Abandoned` while retaining the actual channel status.
The live transport envelope binds that command to its exact frame bytes,
message number, sent state, and ACK state. Reload reuses the bound unacknowledged
frame or, when the ACK was already persisted, completes the still-pending Rust
command without allocating or replaying another frame.
It does not wait for the peer’s on-chain
publication or confirmation. A shutdown without the flag observes the normal
cooperative grace period before offering **Go On-Chain**. The same Rust
predicate makes a direct or stale `go_on_chain` call abandon before creating a
new spend, so the UI label is a projection of protocol authority rather than
the enforcement point. A failed inbound `deliver_message` is also deliberately
routed through that Go On-Chain entry point: Rust abandons a zero-payout session
there, while a session with value remaining starts normal on-chain resolution.
`SessionController.goOnChain()` returns whether Rust actually began on-chain
resolution; Shell applies the peer-disconnect, phase, and dashboard on-chain
effects only for that successful result. Timer-gated abandon actions in other
waiting states remain separate stalled-flow escapes. See
[Abandonment and Zero-Payout Shutdown](UX_NOTIFICATIONS.md#abandonment-and-zero-payout-shutdown)
for the full state and terminal-effect rules.

The potato marker is likewise a projection of that one status snapshot: the
banner shows `🥔` only when `havePotato` is true. It is protocol-token context,
not a claim about which game turn is currently playable.

**Unroll hand projection:** `GoingOnChain` and `Unrolling` do not yet make
per-game turn, replay, or slash classifications authoritative: the unroll can
still be preempted. The dashboard therefore keeps each hand `Active` and hides
per-hand lifecycle rows until Rust reports `ResolvedUnrolled` or
`ResolvedStale`. At that boundary, the reported game classification is shown
immediately even if asynchronous enrichment has not yet derived the game
coin’s hex ID. A stale resolution preserves its reported channel change
balances and continues to show any remaining classified hands.

**Pre-game saves and the boot marker:** The aggregate is resumable when it has
connection preferences, a session phase, wallet obligations, or rejection
transports. `localStorage`'s `appState_savedSession` is only a boot hint; the
strict aggregate remains authoritative. Wallet connection writes
`preferences.blockchainType` through `StorageRepository` and marks the app
resumable even before a game exists. Normal `clearSession()` preserves valid
common state and unresolved obligations; hard reset is the destructive path.
No unsupported app format is decoded or deleted automatically.

#### Boot state machine

On page load, `index.tsx` starts WASM bootstrap in parallel with React:
fetch the module and binary CLVM presets, then bind the protocol game
identities calculated by the package build. Handshake uses that already-loaded
module for BLS identity only.

On page load, Shell delegates storage/recovery ownership to
`BootRecoveryBoundary`. It completes a pending owned-storage wipe and visible
read-only IndexedDB inspection before choosing recovery UI. Hub and wallet
promises are not part of this local boundary. Resume/takeover use one atomic
claim-and-read transaction over coordination plus `application-state/current`,
followed by one strict aggregate rehydrate:

```
hasSavedSessionMarker()?
                 │
                 ├─ yes → inspect IndexedDB → show Resume / Start Over
                 │       │
                 │       ├─ Start Over → hardReset(), reload
                 │       │                (separate "Starting over…" UI state;
                 │       │                 does not share the Resume spinner)
                 │       │
                 │       └─ Resume → claim and read aggregate
                 │           │
                 │           ├─ load failure / unsupported → keep dialog open
                 │           │   with loadError; re-arm the marker
                 │           │
                 │           └─ save loaded → is there a lease conflict?
                 │               │
                 │               ├─ Yes → show Take Over dialog
                 │               │   ├─ Take Over → claim + rehydrate, restore
                 │               │   └─ Close Tab → dead
                 │               │
                 │               └─ No → claim + rehydrate, restore
                 │
                 ├─ no marker, ownership conflict (another tab is active)
                 │   → show Take Over dialog (save: null)
                 │
                 └─ no marker, no conflict
                     → claim + rehydrate, ready (fresh start)
```

**Start over hard reset:** Start over is deliberately not graceful cleanup. It
is the escape hatch for garbled local state, so it must not deserialize saved
state, reconnect to services, preserve preferences, or otherwise interpret the
current session. The handler tears down live hub/wallet sockets (so IndexedDB
deletes are not blocked), awaits `hardReset()`, and reloads only after every
targeted deletion confirms success. A blocked or failed deletion leaves the
shell on recovery UI with Retry Hard Reset guidance.

All aggregate and reset mutations share one serialized same-tab coordinator.
IndexedDB v5 keeps strict authority metadata in its coordination store: owner
tab, monotonic write epoch, and reset epoch/status. Every mutation validates its
captured authority in the same transaction as the aggregate write; localStorage
is only an early UX conflict/reset hint. This
orders `clearSession()` followed by an immediate unawaited save and prevents an
old tab or retired runtime from committing after takeover. `hardReset()` durably
advances the reset epoch before invalidating memory and deleting storage;
pre-reset work cannot recreate the database or cached state afterward.
`hardReset()`:

1. Signals sibling tabs to stop persisting.
2. Erases every in-memory wallet operation, including
   `retained-for-replay`; reset is intentionally destructive and does not run
   graceful cancellation.
3. Clears `localStorage` / `sessionStorage` first (ordering only — the boot
   marker and prefs must not outlive a later IndexedDB hang).
4. Deletes every exact name in the owned app / WalletConnect manifest even
   without enumeration, then enumerates only to discover additional names
   matching owned prefixes. Foreign same-origin databases are preserved.
   `onsuccess` confirms
   deletion; `onblocked` or `onerror` returns a typed unsuccessful result,
   keeps recovery UI open with **Retry Hard Reset**, and leaves a minimal
   generalized pending-wipe marker for retry or next boot. Reload occurs only
   after every deletion confirms success.

**Full vs pre-game saves:** The resume/takeover handlers check
`save.serializedGameSession` to distinguish full game saves from pre-game saves.
A full save triggers `performResume` (WASM restore + hub reconnect). A
pre-game save triggers `handleConnect(save.blockchainType)` to re-establish
the wallet connection without attempting WASM deserialization.

**Authority claiming:** Read-only inspection never claims storage.
`StorageRepository.claimAndRead` commits the durable epochs and returns the
exact raw session and wallet-operation snapshot read in that transaction;
`StorageRepository` and `WalletOperationRuntime` then decode and hydrate their
records. `localStorage` is updated afterward as a UX hint. Only pending common
identity, preference, and history changes survive before claim; phase, terminal,
clear, rejection, and wallet-ledger mutations reject until authority exists.
Semantic rejection and preserving-reset transactions remain repository-owned.
Ordinary I/O failure is durability
degradation; `StorageAuthorityLostError` retires the obsolete runtime and
suppresses effects. Start over advances reset authority and wipes only the
owned manifest.

#### Restore path

When the user chooses to resume a full save, `performResume` fires:

1. Decode the strict IndexedDB record, hydrate local UI state (game params,
   human history, WASM notification history, and diagnostic log), and restore
   the serialized WASM cradle.
2. Publish the locally restored shell/game/dashboard immediately. Action
   controls that need a wallet, hub, or blockchain remain gated.
3. Independently connect to the wallet backend (`beginConnect` + `finalize`)
   and attach blockchain recovery.
4. Connect to the hub. On `connection_status`, reconcile the hub's
   pairing state against the save (see
   [Reconnect Reconciliation](#reconnect-reconciliation)).
5. Hub `registered` and a matching `peer_available` are the only boundaries
   that re-send un-acked peer messages. Pending chain transactions are re-submitted when
   the restored transaction manager attaches.

Local IndexedDB+WASM presentation and external hub/wallet/blockchain recovery
are deliberately separate authorities: external outage delays reconciliation
and actions, not visibility of a valid local restore.

#### Cleanup

React and protocol cleanup are intentionally different. The committed layout
effect in `useGameSession` activates the runtime, while its cleanup only
clears the render callback. `SessionController.cleanup()` and
`cleanupAfterTerminalFlush()` own protocol retirement, including retirement of
the active runtime and detachment of controller resources.

There are two different reset paths:

- `clearSession()` is normal lifecycle cleanup. It clears game/session fields
  while preserving identity, preferences, saved games, and other non-session
  UI state.
- `hardReset()` is destructive app-origin storage reset. It is used by Start
  over and intentionally wipes all local browser state without attempting
  graceful wallet, hub, or session cleanup. It erases every reservation,
  advances the storage generation before deletion, clears sync storage before
  IndexedDB so markers/prefs cannot outlive the wipe, and awaits IndexedDB
  deletion to completion (no give-up timeout).

The browser storage involved is split across three APIs:

- `localStorage` holds small preferences, the resumable-session marker, tab
  lease, and reset coordination keys.
- `sessionStorage` holds per-tab identity such as the tab id.
- IndexedDB holds the raw binary `DurableApplicationState`; WalletConnect may also maintain
  its own IndexedDB state after localStorage has been cleared.

Because tabs and windows for the same origin can share `localStorage`, a hard
reset also signals sibling tabs to stop persisting their in-memory cached state.
This is only a reset broadcast, not a graceful coordination protocol.

### Peer Message Reliability

Every semantic peer message, beginning with `session_proposal`, uses a numbered
ack protocol to guarantee exactly-once ordered delivery across reconnects. The
hub relays frames and relay-control messages verbatim — it does not understand
peer session IDs, message numbers, or acks.

#### Wire format

Semantic messages are Bencodex bodies inside addressed peer-relay payloads. The
player app wraps each body in the peer reliability header before handing it to
`HubConnection`:

- **Data payload:** tag `0x01`, 16-byte `session_id`, 4-byte big-endian
  `msgno`, then one Bencodex semantic-message body.
- **Ack payload:** tag `0x02`, the same 16-byte `session_id`, then a 4-byte
  big-endian cumulative `msgno`.
- **Keepalive payload:** tag `0x03` followed by the same 16-byte `session_id`.

The proposer selects the random session ID and sends `session_proposal` as data
message 1. `session_reject`, Handshake A-D, batches, and shutdown messages
continue in the same sequence. Acceptance changes the ordered-body consumer
from Shell negotiation to `SessionController`; it does not replace the
transport. Host messages such as `session_reject` are recognized only after
the reliability owner has selected the next contiguous body, so an
out-of-order rejection cannot bypass an earlier WASM message.

#### Outbound

Every outbound semantic message is assigned a monotonically increasing
`messageNumber` within its peer session and stored in `unackedMessages`. The
binary frame is not sent until the updated transport and semantic state have
been durably flushed. On receiving a matching-session ack with number N, all
entries with `msgno <= N` are pruned from the log and persisted. A rejection
cancels the application attempt immediately but retains this minimal transport
log until the rejection is acknowledged or its seven-day retention expires.
The receiver atomically replaces the cancelled session with a minimal durable
receipt before acknowledging the rejection. That receipt can re-acknowledge a
duplicate after reload without repeating cancellation. Outbound records and
inbound receipts share a global cap of eight.

#### Inbound

The shared peer reliability owner enforces strict ordering before dispatching
an admitted body to Shell negotiation or `SessionController`:

- `msgno <= remoteNumber`: duplicate, dropped. An ack is re-sent in case the
  original ack was lost. If another message
  boundary is already waiting for a durability flush, the duplicate ack is
  queued behind that flush too. Duplicate inbound frames do not replay outbound
  data.
- `msgno > remoteNumber + 1`: out-of-order, buffered in a `reorderQueue` map.
- `msgno == remoteNumber + 1`: delivered to the WASM cradle, `remoteNumber`
  incremented, ack queued, then contiguous messages are flushed from the reorder
  queue. Acks are sent only after the updated `remoteNumber` and corresponding
  negotiation or serialized cradle state have been written to the session save.

Counters and queues are scoped by `(peer_id, session_id)`. Unknown-session acks
and keepalives are ignored. Only data message 1 containing a valid
`session_proposal` can establish an unknown epoch. If the selected peer presents
a new epoch during a live off-chain channel, the client escalates the old
obligation on-chain instead of resetting its counters. An ordered
`session_reject` cancels only a pre-active attempt; after channel establishment
it is a protocol failure and takes the obligation on-chain.

#### Peer Liveness

Both peers independently send periodic session-scoped keepalive frames through
the hub. Keepalives are fire-and-forget — no response is needed. Receiving
matching-session peer traffic (data, ack, or keepalive) counts as proof of life
for the yellow/green liveness guess. Keepalives do not replay unacknowledged
data.

- **Send interval:** 15 seconds (`KEEPALIVE_INTERVAL_MS`)

The keepalive timer starts when `ChannelCreated` fires. On restore,
`SessionController` derives its internal readiness flag from the persisted
canonical `channelStatus`; readiness is not a separate save field.
`SessionController.notePeerActivity()` is called on every inbound message
delivery, ack reception, and keepalive reception.

Peer liveness is measured passively from relay traffic and hub route hints. The
`PeerSession` object derives liveness indicators using a 5-second polling
interval. These feed into the **tab pipe marks** — uncolored link / broken-chain
emojis to the left of Wallet, Hub, and Game tab labels — and into the game
dashboard **banner rail** (session mode: idle / playing / pings-bad / on-chain /
ended). They are also passed to `GameSession` for in-game display. Yellow
(`degraded` / `pings-bad`) is advisory: the hub reported the peer disconnected,
or no matching peer frame arrived for 30 seconds. An inbound frame or
`peer_available` restores connected. Unroll / on-chain presentation uses the red
rail even while pings are degraded. Silence and hub disconnect hints never
auto-escalate on-chain; only local go-on-chain or a received FOAD marks the peer
dead.

Inbound peer frames are validated before counting as activity: data and ack
frames have a 21-byte header, keepalives are exactly 17 bytes, and the session
ID must match. Unknown, short, fixed-length frames with trailing bytes, and
wrong-session control frames return `false` and do not update liveness.
Outbound hub sends (`sendToPeer` / presence `sendWs`) return `boolean` — `false`
when the WebSocket is not OPEN — so SessionController can leave durable outbound
queued rather than treating a dropped send as success. There is no offline send
queue beyond that re-queue-on-failure behavior.

**Hub indicator** (`HubLiveness`) combines WebSocket connectivity with
keepalive freshness into four states:

| State        | Meaning                                                       |
| ------------ | ------------------------------------------------------------- |
| Connected    | WebSocket is open AND hub activity within the last 45 seconds |
| Reconnecting | WebSocket dropped, auto-reconnect in progress                 |
| Inactive     | WebSocket appears open but no hub activity for 45+ seconds    |
| Disconnected | Permanently closed (session ended)                            |

Transitions: `onHubDisconnected` → Reconnecting, `onHubReconnected` →
Connected, keepalive timeout while WS is up → Inactive.

**Peer indicator** (`PeerLiveness`) has four states:

| State       | Meaning                                                                                     | Tab mark                                                             |
| ----------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `connected` | Peer traffic received within the last 30 seconds, or the hub just reported `peer_available` | Link                                                                 |
| `degraded`  | Hub `delivery_failure` / `peer_unavailable`, or no peer traffic for 30+ seconds             | Link (banner rail yellow)                                            |
| `dead`      | Local go-on-chain or session rejection (FOAD) — terminal for this peer relationship         | Broken chain                                                         |
| `null`      | No keepalive yet, or no active peer session                                                 | Link if a session is live (handshake); broken chain if none/resolved |

`dead` is sticky: incoming messages from that peer are ignored. Only a new session start resets to `null`.

**Action buttons**: Controls live with the state axis they affect. The hub
disconnect button lives in the Hub tab header strip (right-aligned next to
"Connected to {origin}"). Go On-Chain lives in the Game tab session header.
Disruptive hub actions are gated by cascade confirmation dialogs. See
`CONNECTIVITY.md` for the full connectivity model.

#### Reconnect

When a player reconnects (receives `registered` from the hub), and has an
active session peer, it calls `resendUnacked()` to replay un-acked messages.
A matching `peer_available` does the same when the other endpoint returns.
The ordering and deduplication logic on the receiving side handles any
duplicates caused by the replay. Keepalives and duplicate inbound frames do
not replay. These are the only replay boundaries.

### Reconnect Reconciliation

The `onRegistered` handler fires on every `identify` response from the
hub — both on initial page load and on mid-session game channel reconnects.
On reconnect with an active session peer, the player app resends un-acked
messages. The hub has no concept of pairings or session state — reconnect
reconciliation is purely a client-side concern based on local session saves.

### Static Asset Layers

The player app is composed of three independently deployable static asset layers,
ordered from most stable to least:

1. **WASM binary** — The Rust game engine compiled to WebAssembly. This is the
   core of the system: state channel management, move validation, blockchain
   interaction. It should change rarely once solid. Rebuilding it is the most
   expensive operation.
2. **Chialisp (.hex files)** — Compiled chialisp programs (referee, unroll,
   game-specific validation). These are fetched over HTTP at runtime and injected
   into the WASM via `cache_file()` — they are not compiled into the WASM
   binary. Changing a chialisp program means recompiling the `.clsp` to `.hex`
   and replacing the file on the static server. No Rust rebuild required.
3. **Frontend (JS/TS/CSS)** — The UI layer: React components, hooks, styling.
   Changes here are the most frequent (UX tweaks, new game UIs, layout fixes).
   Rebuilt with the JS bundler, no Rust or chialisp rebuild required.

This layering means most day-to-day development only touches layer 3 (frontend),
which has the fastest rebuild cycle. Chialisp changes (layer 2) require only a
chialisp compile. The Rust/WASM layer (1) is rebuilt only when the engine itself
changes — which should be rare once the protocol is stable.

## Player App Internal Architecture

The player app is a single-page React application with one real iframe (the
hub). Game session and game UI are React components within the same
window, separated by hook boundaries rather than iframe boundaries. The design
supports future extension to multiple game types and multiple simultaneous games,
but the MVP presents one logical hand at a time.

### Component Hierarchy

```
┌─────────────────────────────────────────────────────────────────┐
│  Shell (top-level React component)                              │
│  Wallet, blockchain, hub connection, tabs, logs             │
│                                                                 │
│  Wallet tab (initial landing — QR code / simulator setup)       │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  Hub iframe (UNTRUSTED — third-party hub code)     │   │
│  │  Matchmaking only; shown as the "Hub" tab            │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  ┌──────────────────────────────────────────────────────────┐   │
│  │  GameSession component (TRUSTED)                         │   │
│  │  useGameSession hook: WASM cradle, notifications, state  │   │
│  │  Shown as the "Game" tab                                 │   │
│  │                                                          │   │
│  │  ┌────────────────────────────────────────────────────┐  │   │
│  │  │  Game-specific component (CalpokerHand/SpacePoker) │  │   │
│  │  │  Game hook: parsing, display, move logic           │  │   │
│  │  │  Remounted per hand via React key                  │  │   │
│  │  └────────────────────────────────────────────────────┘  │   │
│  └──────────────────────────────────────────────────────────┘   │
│                                                                 │
│  History tab (append-only text area)                            │
│  Log tab (append-only text area)                                │
└─────────────────────────────────────────────────────────────────┘
```

### Shell (`Shell.tsx`)

The Shell is the top-level React component. It owns:

- **Wallet connection** (WalletConnect or simulator) — the Wallet tab presents
  a QR code for WalletConnect and a simulator option via `SimulatorSetupModal`
- **Hub connection** — accepts the selected hub URL, creates the
  `HubConnection` client for the game channel, and sets up the hub iframe
- **Tab navigation** — five tabs: Wallet, Hub, Game, History, Log
- **Unique ID and session ID** — persisted in localStorage, stable across reloads
- **Session lifecycle and Accept presentation** — `useShellSessionState` fields
  plus `useAcceptLifecycle` / `acceptLifecycle` for Accept abort, persist, and
  session-pane setup covers

The Shell does not know about game protocol details. When the hub challenge
flow completes, Shell creates `GameSessionParams` with the total channel amount
and the perspective-correct `myContribution` / `theirContribution`, then renders
the `GameSession` component. Specific game types and per-hand terms are chosen
later inside the session through game proposals.

Session-end side effects (hub busy state, balance polling, peer relay teardown,
and clearing session refs) are driven by Shell's
`handleSessionPhaseChange('resolved')`. `SessionModel` reaches that phase only
after Rust's final `ChannelStatus` snapshot has been projected into React, so
Shell preserves the final dashboard snapshot before tearing down the live
controller.

#### Session transition ownership

Accept ownership lives in `front-end/src/lib/session/acceptLifecycle.ts` and
`useAcceptLifecycle`, composed by Shell. Session fields and the Accept
session-pane transition bookkeeping live in `useShellSessionState` /
`shellSessionState.ts`.

Accept session setup is always `session-pane` scope: tabs and `GameDashboard`
stay mounted while `SessionTransitionSurface` covers only the game-content
pane. Shell renders that cover only before `GameSession` is kept; once
mounted, `GameSession` hosts the same surface under its notification z-index
so overlays remain clickable.

`beginAccept` clears consent prompts atomically with entering the pending
transition, keyed by the same `pairingToken` that identifies the new
controller instance. Completion for a different instance is ignored.

Shell releases the transition via `shouldCompleteAcceptTransition`: true once
the projected `ChannelStatus` leaves Cancel-only setup states. The core remains
authoritative for that commitment boundary.

`abortAccept` is the single Accept abort API (Cancel, `session_reject`,
`delivery_failure`, remap, disconnect-during-Accept). It owns `session_reject`
when a peer id is supplied and chooses freeze-safe disposition:
pre-`replaceSession` → peer-only abandon via atomic `acceptAborted` (finished
freeze + terminal IndexedDB stay); after the write lands → full attempt
teardown via `cancelAttemptedSession`. `persistFreshStartCheckpoint` marks the
write committed as soon as `replaceSession` succeeds, so a Cancel-race restore
failure still takes full teardown rather than leaving an orphan live cradle.
While Accept is pending or its persist callback is still draining,
`getPresence` / wallet-reconnect busy and local prompt availability all stay
blocked so hub re-identify cannot advertise available mid-Accept.

### Blockchain Connection Flow

Shell manages wallet connections through two abstractions defined in
`ChiaGaming.ts`:

- **`InternalBlockchainInterface`** — the backend-specific implementation
  (`RealBlockchainInterface` for WalletConnect, `FakeBlockchainInterface` for
  the simulator, `CloudBlockchainInterface` for Cloud Wallet OAuth). Each
  exposes `beginConnect()`, `disconnect()`, `isConnected()`, `spend()`, etc.
- **`ConnectionSetup`** — returned by `beginConnect()`. Contains a `uri` for
  the QR code and a `finalize(values?)` promise that resolves when the wallet is
  paired. Optionally contains `fields` (a `Record` of typed input descriptors,
  each `{ type: 'string' | 'bigint', label, default }`) indicating the backend
  needs extra user input before connecting, plus an optional `title`/
  `description` for the setup modal. Examples: the simulator's initial balance
  (`bigint`), and Cloud Wallet's OAuth `clientId` / API URL / UI URL (`string`)
  plus a transaction fee (`bigint`, in mojos). Cloud Wallet sets `skipQr: true`
  and completes OAuth inside `finalize()` after persisting the entered config via
  `cloudWalletConfig.ts` (kept separate from the OAuth tokens in
  `cloudWalletAuth.ts`). The fee field is not part of `cloudWalletConfig`: it
  writes through to the global `defaultFee` preference (`setDefaultFee`), the
  same value the Wallet tab edits, so `CloudBlockchainInterface.getFee()` reads
  one source of truth. All OAuth/GraphQL calls resolve the client id and
  endpoints at call time through `getCloudWallet*` getters, so UI-entered config
  takes effect without a rebuild.

  Cloud Wallet funding uses persisted `createOffer` requests, matching the
  WalletConnect funding contract: `offered` contains the requested funding
  amount, `requested` is empty, and the protocol's conditions are serialized as
  complete CLVM condition programs. Once the signature request is `SUBMITTED`,
  the adapter returns both the bech32 offer and its offer ID. Rust decodes and
  validates the offer; if validation requests another funding attempt, the
  controller cancels the rejected persisted offer off chain to release its
  wallet operation. The wallet chooses the offer inputs, so Cloud no longer
  selects or pins a funding coin in JavaScript.

  `WalletOfferProvider` is a required discriminated capability, not optional
  methods. Cloud is `recoverable-after-begin`: transport loss before the begin
  response supplies a `signatureRequest` ID is persisted as
  `best-effort-uncertain`, because no exact request can yet be reconciled. Once
  a replacement begin yields that ID, the operation transitions to `creating`,
  persists it, and immediately uses paired reconciliation; a request already
  persisted with an ID resumes reconciliation without another begin.
  `orphanRisk: 'pre-id-response-lost'` survives both paths and any eventual
  created trade, preserving a typed warning that the unidentified first request
  may still exist. Approval messages must match origin, popup source, and
  canonical request ID, with exact cleanup. Deployed
  WalletConnect is best-effort throughout because it lacks end-to-end create
  idempotency and response-loss reconciliation. For either pre-ID Cloud
  uncertainty or WalletConnect uncertainty, `WalletProviderRegistry` readiness
  epochs launch exactly one automatic new attempt per later reconnect,
  including after reload. There is no timer or immediate retry loop. A lost
  successful response may orphan an offer or signature request, so the UI and
  diagnostics retain an explicit orphan-risk warning even if a later attempt is
  accepted.

  The simulator mirrors wallet operation semantics with synthetic trade
  identities. Each synthetic fee offer reserves the exact input identity
  selected for that offer. Submission terminalizes only the synthetic trade
  whose exact bundle identity was acknowledged; another outstanding offer is
  neither consumed nor released, and reusing an already reserved input is
  rejected.

  Cloud fee attachment is also offer-based. `createFeeSpend` creates a fee-only
  offer with empty `offered`/`requested` arrays, the native `fee` field, and one
  serialized `ASSERT_CONCURRENT_SPEND` targeting Rust's protocol coin. Unlike a
  WalletConnect settlement offer, this shape already contains the reserve-fee
  condition and fee deficit, so Rust normalizes it without adding a settlement
  or nil-puzzle spend. Both shapes then pass through the same Rust checks for
  target, amount, deficit, input overlap, aggregate signatures, expiry, and
  combined consensus validity. Rejected or unusable Cloud fee offers are
  cancelled off chain using their offer IDs. Cancellation is typed and complete
  only when the Cloud signature request reaches a terminal success status;
  transport unavailability and wallet rejection remain distinct durable
  cleanup outcomes.

  Cloud's wallet address, balance, consent, and offer operations remain on the
  wallet GraphQL API. Full-node reads and final `push_tx` calls use its typed
  Coinset GraphQL proxy and preserve the Coinset request and response shapes:
  `get_blockchain_state`, `get_coin_record_by_name` /
  `get_coin_records_by_names`, and `get_puzzle_and_solution`.

  **Fee floor.** Chia's mempool treats a fee below 5 mojos per cost unit as zero
  (`nonzero_fee_minimum_fpc`), so a small nonzero fee is strictly worse than no
  fee: it buys no inclusion, and on a full mempool the node rejects the bundle
  with `INVALID_FEE_TOO_CLOSE_TO_ZERO` instead of admitting it as free. The front
  end therefore forbids the in-between values: `front-end/src/constants/fees.ts`
  defines `MIN_NONZERO_FEE_MOJOS` (100M mojos, derived from 5 mojo/cost times a
  conservative bundle cost) and `isEffectivelyZeroFee`, and both fee entry points
  (the Wallet-tab editor in `Shell.tsx` and the Cloud Wallet connect modal's fee
  field) reject a nonzero fee below it. Zero (a free transaction) and
  floor-or-above are allowed. This is a floor below which a fee definitely cannot
  work, not a guarantee of inclusion. For ordinary WalletConnect submissions,
  `createFeeSpend` makes a persisted signed offer whose wallet spend asserts the
  Rust-specified target coin is spent concurrently and reserves the fee. Cloud
  Wallet returns its native-fee offer instead. JavaScript passes
  either tagged provider result opaquely to one Rust/WASM attachment operation.
  Rust captures the configured amount, target, and explicit
  `SubmitWithoutFee` attachment-failure policy when the intent is first emitted,
  so retries cannot silently change fee policy. Rust completes WalletConnect's
  OFFER_MOD output into a spent nil-puzzle coin; validates the exact reserve,
  deficit, target assertion, signatures (including legitimate
  `AGG_SIG_UNSAFE` pairs), and lack of protocol input overlap for either
  provider; aggregates the bundles; and consensus-checks the result. If the
  wallet source cannot be obtained or validated, the same Rust finalization
  boundary deliberately returns the original fee-free bundle with a warning.
  The host never chooses that fallback or derives fee policy or target coins
  from bundle names, puzzle hashes, or spend ordering.

  Wallet adapters make one submission attempt and return a typed outcome.
  Structured success and a response identifying the exact same transaction as
  already included are idempotent acknowledgement. An RPC that cannot complete
  because the wallet connection, relayer, or request transport is unavailable
  returns `unavailable`; an error response from the wallet returns `rejected`.
  The WalletConnect RPC layer preserves this provenance, and adapters do not
  infer retry policy from consensus, mempool, or coin-status text. Local
  conversion or finalization errors also retain the Rust intent rather than
  retiring it. No adapter owns a timer retry loop, so an unavailable submission
  cannot block a later urgent transaction.

**Design principle:** Shell must not branch on `blockchainType` for connection
logic. All differences between backends live behind the interface. A single
`getInterface(bcType)` helper maps the type string to the concrete instance
and poll interval; the rest of the flow is generic.

**Connection lifecycle:**

1. User picks "Simulator", "Link Wallet", or "Cloud Wallet" →
   `handleConnect(bcType)`.
2. `handleConnect` calls `iface.beginConnect(uniqueId)`, which returns a
   `ConnectionSetup`.
3. If `setup.fields` is present, Shell shows the generic `ConnectionSetupModal`
   overlay so the user can provide the required values, then `handleFinalize(values)`
   calls `setup.finalize(values)`. This path is used by both the simulator and
   Cloud Wallet (the latter is `skipQr` yet still collects OAuth config first).
4. If `setup.skipQr` is set with no fields (a restored WC/Cloud session), Shell
   awaits `setup.finalize()` without showing a QR panel or modal. A failed
   restore discards the stored Cloud Wallet tokens only for
   `CloudWalletAuthError` — a revoked or expired grant, signalled by an
   `invalid_grant`/`invalid_client` token response or a 401 that survives a
   forced refresh. Network and server errors leave the refresh token in place so
   a retry can resume, rather than demoting a momentary outage into a full popup
   login.
5. If `setup.skipQr` is set _with_ fields (Cloud Wallet, no stored auth), Shell
   shows `ConnectionSetupModal` and does **not** call `finalize()` from silent
   `handleConnect` or `performResume`. Auto-finalize would open an OAuth popup
   or fail when no client id is configured; the user must submit the form (or
   use an explicit Reconnect).
6. If `setup.fields` is absent and QR is required (WalletConnect pairing), Shell
   renders the QR code and awaits `setup.finalize()`, which resolves when the
   wallet scans.
7. After finalize resolves, `completeConnection()` activates polling and
   switches to the Hub tab. Connect/finalize failures are surfaced on the Choose
   Connection screen and inside the setup modal via `connectError`, rather than
   silently resetting the chooser.

**Auto-reconnect:** Both backends implement their own WebSocket reconnect
following the shared connection discipline described in
[WebSocket Connection Discipline](#websocket-connection-discipline).
Shell's `onConnectionChange` callback handles UI state
transitions (connected ↔ disconnected) generically. On page load, if the
user chooses to resume a pre-game save (one with `blockchainType` but no
`serializedGameSession`), Shell calls `handleConnect(bcType, true)` (silent mode)
to re-establish the connection automatically — no QR codes are shown, and the
simulator balance modal is skipped, consistent with the principle that a reload
should be invisible to the user. Cloud Wallet without stored auth is the
exception: `beginConnect` returns `skipQr` plus `fields`, so silent reconnect
and `performResume` keep `ConnectionSetupModal` (with a wallet alert) rather
than calling `finalize()` with no values.

**Session persistence:** Wallet connection updates
`DurableApplicationState.preferences.blockchainType` through
`StorageRepository` and marks the app resumable before a WASM session exists.
Once play begins, the same aggregate checkpoint includes that preference,
session presentation, reliable transport, opaque WASM cradle, wallet
obligations, and rejection transports. `clearSession()` preserves common state
and valid unresolved obligations; `hardReset()` wipes the whole aggregate.

**Intentional deviation:** The simulator returns `ConnectionSetup.fields`
because there is no external wallet to scan the QR code. This triggers the
`SimulatorSetupModal` overlay — the only place where Shell's UI differs between
backends. All other connection logic is shared.

### Blockchain Polling Architecture

After a wallet backend is active, the player app uses `BlockchainPoller` as the
host-side coordinator for chain observations. It separates three concerns:

1. **Polling interest** — `TransactionManager` is the sole owner of watched
   coin meaning and lifetime. The frontend poller only receives the transport
   projection: coin name plus full coin string. Runtime
   additions arrive as `watchCoins` deltas from WASM drain results.
   `snapshot_watched_coins()` is only the restore/attach snapshot of the durable
   WASM interest set, not the per-sweep source of truth.
2. **Scheduling** — `BlockchainPoller` owns two independent serialized
   `AsyncJobQueue` lanes per active backend: one for reads and background polls,
   and one for wallet mutations. A hung provider read therefore cannot block a
   spend, offer, selection, or other mutation. Both lanes pass every adapter
   request through one global request-start gate, which applies the backend's
   requested gap between starts without waiting for prior requests to finish.
   `AsyncPollingScheduler` enqueues repeating height, balance, and coin-sweep
   work on the read lane. On disconnect, active reads are abandoned and queued
   mutations are cleared. An active mutation is allowed to finish; if it was an
   offer-creating call whose result became stale, the poller uses its trade ID
   to cancel the wallet operation before rejecting the old-generation result.
   A new generation may run immediately even if an unabortable old read never
   resolves. Each request revalidates its connection epoch after the shared
   start gate and after adapter completion, so stale work cannot start late or
   publish a late old-generation result. Read polling fans session delivery out
   with `allSettled`: one session's callback failure does not block healthy
   sessions and does not trigger global adapter backoff. Wallet mutations start
   only after the claimed aggregate is installed; malformed aggregate state
   rejects them before the provider is called.
3. **Connection adapters** — `FakeBlockchainInterface` and
   `RealBlockchainInterface` perform the backend-specific RPCs. WalletConnect
   still handles fingerprint injection, relayer readiness, and remote-wallet
   registration shape, but it does not own scheduling or coin lifecycle
   semantics.

Coin polling reports raw height and coin-state observations upward every
successful sweep. The transaction manager computes ordered semantic
create/spend/reorg transitions and confirmation-depth retention from those
observations. The browser never decides that a watch has become terminal.
Inside Rust, each height or coin-state observation is transactional over a deep
serialized clone of the durable `TransactionManager` and nested `GameSession`.
Only a successful callback replaces that durable state; pending events,
watch/unwatch deltas, cradle output, and other skipped bookkeeping are journaled
separately and restored on failure or prepended on commit. This boundary covers
protocol mutations as well as effects, and callback CLVM values that survive it
own serialized `Program` bytes rather than scratch-allocator pointers. The
transient journal contains no test state; stale-unroll snapshots are owned by
the simulator test harness and passed explicitly.

During channel opening, each handshake role registers the predicted channel
coin as soon as its identity is known. The wallet funding input is validated as
part of the assembled transaction but is not used as an intermediate watch.
Only observing the channel coin itself activates the channel.

When WASM processing registers new watched coins, `SessionController` applies
the `watchCoins` deltas to `BlockchainPoller`. On restore, the deserialized
`TransactionManager` already contains the semantic watch set, so
`BlockchainPoller.attachGameSession()` seeds itself once from `snapshot_watched_coins()`
without replaying old events. When manager-owned confirmation-depth eviction
ends an interest, WASM emits an `unwatchCoins` delta and the poller removes only
that transport registration.

**Polling Termination.** `ManagerDrainDisposition` is the sole generic host
lifecycle boundary: `active`, `await-outbound-terminal(command)`, or `terminal`.
WASM exposes that one discriminated disposition; no game-specific settlement
outcome decides host lifetime. `SessionController` durably sends and replays
its Rust-issued command until the peer ACKs it, then asks Rust to finalize.
Only `terminal` discards queued protocol work and watch-coin updates and stops
the `BlockchainPoller` and keepalive timer. Its retained `ChannelStatus`
presentation event updates the `SessionModel`. Shell then stages one terminal
snapshot only after terminal quiescence repeatedly drains controller events,
persistence, reliable transport, and end-to-end transaction submission
promises. Those promises cover persistence-gated launch, ordered wallet
delivery, Rust acknowledgement or rejection, and fee-offer cleanup. The
terminal presentation is taken from the authoritative runtime model returned
after that quiescence, not from a pre-drain React projection. Terminal capture
installs the aggregate in the repository root before attempting IndexedDB. An
ordinary write failure uses the existing one-per-episode durability warning,
then still freezes presentation, destroys the controller, and releases the peer
relay/hub busy state. The in-memory terminal root remains dirty for a later
aggregate checkpoint without replaying finalization. Storage authority loss or
missing authority still rejects and fences publication by the obsolete owner;
unresolved protocol and wallet obligations remain quiescence blockers.
Timer/effect cleanup that can finish after this atomic replacement uses
`patchLiveSessionPresentation`; it updates only a still-live owner and becomes a
no-op once terminal persistence owns the record. Ordinary presentation writes
continue to fail fast outside the live phase.

**Presentation, protocol, and restoration lifetimes.** These are three separate
boundaries:

- The current hand's React feature tree is a visual lifetime. It remains mounted
  through individual game settlements and successful channel finalization.
  Finalization changes its `GameMountView` from the live branch to
  `frozen: true` without changing the feature component type or `handKey`; only
  acceptance of a new hand changes that key. Before that frozen projection, the
  runtime restores the hand from the finalized terminal model, so the retained
  tree cannot continue rendering a pre-finalization mutable hand.
- The real `SessionController`, peer relay, callbacks, subscriptions, and
  blockchain attachment are a protocol lifetime. After the terminal reduction
  queue and atomic terminal save have flushed, they are detached and destroyed.
  The retained game receives the hand restored from the finalized
  `SessionModel` in the frozen mount branch. That branch has no protocol intent
  port.
- `FinishedSessionGameView` is cold-restoration infrastructure. It creates a
  hand and installs its opaque saved state when no live React tree survived,
  such as after
  a page reload. Its game controls remain disabled by the frozen mount branch,
  while scrolling, text selection, and copying remain available. Its
  error/fallback handling is isolated from the in-place terminal path.

The terminal save retains only presentation payloads needed by game-owned hands.
An absent or invalid persisted hand renders the terminal summary instead;
otherwise `FinishedSessionGameView` always attempts the package's frozen cold
remount.

### WalletConnect BigInt Serialization

WalletConnect's internal JSON handling (`@walletconnect/safe-json`) uses a
custom convention for BigInts: `safeJsonStringify` serializes `BigInt(123)` as
the string `"123n"`, and `safeJsonParse` converts strings matching `/^\d+n$/`
back to BigInts. This means BigInt values survive a WC round-trip, but as
string-encoded values rather than native JSON numbers.

This convention has two bugs that we patch around:

**Bug 1: Negative BigInts.** The parse regex `^\d+n$` doesn't match negative
values like `"-100n"`. These pass through as plain strings, which downstream
code (e.g. the Chia daemon) can't parse. We fix this with a **pnpm patch** on
`@walletconnect/safe-json@1.0.2` (`patches/@walletconnect__safe-json@1.0.2.patch`)
that changes the regex to `^-?\d+n$`. This patch applies to all WC packages in
the frontend that depend on safe-json.

**Bug 2: Verify API hashing.** WC's sign-client computes SHA-256 hashes of
payloads for its Verify API using bare `JSON.stringify`, which throws on
BigInt values. We fix this with a **pnpm patch** on
`@walletconnect/sign-client@2.23.9` that injects a `__wcSafe` helper using the
same `"n"`-suffix convention and replaces the 5 internal `hashMessage(JSON.stringify(...))`
call sites with `hashMessage(__wcSafe(...))`. This patch is large (280KB)
because the sign-client ships as a single minified line — the actual change is
one helper definition and 5 call-site substitutions.

**Wallet GUI side.** The Chia wallet GUI (`chia-blockchain-gui`) has its own
mitigations since its WC packages are installed via npm (no pnpm
`patchedDependencies`):

- **`patch-package` + postinstall rewrite** (`patches/@walletconnect+safe-json+1.0.2.patch`
  and `scripts/fix-walletconnect-bigint-regex.js`): Same negative-BigInt regex
  fix as the player app (`/^-?\d+n$/`). The patch covers `@walletconnect/safe-json`;
  the script also rewrites WC UMD bundles that inline a copy of the parser.
  Without this, offer amounts like `"-100n"` stay strings and fail in
  `parseMojos` during `chia_createOfferForIds`.

- **`JSON.stringify` monkey-patch** (`packages/gui/src/index.tsx`): Early in
  the renderer entry point, `JSON.stringify` is replaced with a BigInt-safe
  version using the `"n"` convention. This covers WC's internal hash
  computation paths in the renderer process.

- **Confirm dialog replacer** (`packages/gui/src/electron/dialogs/Confirm/Confirm.tsx`):
  The "Raw data" display uses `JSON.stringify(data, (_, v) => typeof v === 'bigint' ? String(v) : v, 2)`
  to avoid crashing when rendered data contains BigInts.

**Frontend (`jsonSafe.ts`).** The player app has its own BigInt-safe JSON
utilities in `front-end/src/util/jsonSafe.ts`:

- `jsonParse` — uses a `JSON.parse` reviver that converts all integers to
  BigInt (matching the behavior of the `lossless-json` library previously
  used). This ensures values from the simulator backend arrive as BigInts.
- `jsonStringify` — hand-rolled serializer that emits BigInts as bare numeric
  literals (via `toString()` directly into the JSON string), avoiding both the
  `JSON.stringify` BigInt crash and the precision loss of `Number()` conversion.
- `jsonParseLossless` / `jsonStringifyLossless` — JSON-only helpers used where
  lossless JSON is explicitly required. They are not the application-state
  persistence format.

#### UX BigInt policy

All integer values in the player app are `bigint`. This applies universally to
protocol counters, money amounts, card values, move data, timestamps, version
numbers, message sequence numbers — everything. JavaScript's `number` type is
IEEE 754 double-precision floating-point and silently loses precision for values
beyond 2^53. Rather than auditing each field individually, the rule is simple:
**if it's an integer, it's a `bigint`.**

The only exceptions are values consumed directly by APIs that require `number`:
array indices, `DataView` get/set methods (which take 32-bit `number` arguments),
CSS pixel values, `setTimeout` delays, and similar DOM/browser APIs. These
conversions happen at the call site with an explicit `Number()` cast — the
`bigint` remains the source of truth.

**Persistence.** Integer fields in `DurableApplicationState`, including
`version`, `messageNumber`, `remoteNumber`, timestamps, and game-specific state,
use `bigint`.
Bencodex represents those integers and raw byte strings directly. IndexedDB
stores one salt-prefixed, masked `Uint8Array` containing the bencodex record;
there is no tagged-JSON save envelope and no structured-clone object graph.
Rust first converts internal `usize` channel state numbers to checked `u64`.
WASM exposes all three optional channel status fields—current, unrolling, and
preempting state number—as `bigint`; number-valued decodes are rejected.
`number` conversion is confined to external APIs that explicitly require it.

**View layer boundary.** React components that render or edit a value receive
view-safe props: decimal strings for money and CLVM integers, or small `number`s
only for genuinely UI-local quantities such as input step counts, array indices,
CSS/layout values, and enum-like controls. Game-specific wrappers such as
`GameSession` build these view models explicitly, and convert back to `bigint`
only when calling hook actions that construct protocol moves.

This boundary is also defensive. Native `JSON.stringify` throws on BigInts, and
React development diagnostics may enumerate props or error payloads in ways that
hit JSON serialization. Avoid passing BigInt-rich domain objects directly into
deep component trees. Prefer explicit string/number view props; if a domain
object must cross a React boundary, keep BigInt-heavy implementation details out
of ordinary enumerable props.

**Wire protocol.** Peer-to-peer message sequence numbers (`msgno`) are `bigint`
internally but are serialized as 32-bit unsigned integers in reliable peer
frames (via `DataView.setUint32`) inside `relay.payload`. The conversion happens
in the peer transport layer. The hub itself never interprets these payload
bytes.

### Hub Iframe (Hub)

The hub iframe is **untrusted**. It is served by a hub and provides
matchmaking UX. It owns a fixed visual palette distinct from the player. The
only interaction between the player app and the iframe is:

- **Hub authentication** — the iframe requests its origin-scoped session
  credential with `postMessage`; the parent checks `event.source` and
  `event.origin`, then replies only to that source window and exact origin.
  Credentials are never placed in iframe URLs.

The hub iframe uses the hub WebSocket challenge protocol (see above) to trigger
matches. The player app never reads from or writes to the iframe's DOM.

### GameSession Component (`GameSession.tsx` + `useGameSession`)

The `GameSession` component manages one game session (a channel with a series of
individual hands). `useGameSession` is a thin React interpreter boundary: it
obtains the `SessionController` and constructs one inert
`SessionMachineRuntime`. Its committed layout effect installs the render
callback and activates the lease; layout-effect cleanup clears only that
callback. The hook also subscribes to host events, dispatches typed machine
events, attaches/detaches the blockchain poller, and returns selector-derived
view data plus dispatch callbacks. Controller cleanup, not React cleanup, owns
protocol retirement. The hook does not contain notification policy, command
interpretation, durable game reduction, or persistence assembly.

When Shell supplies a finalized terminal presentation, `useGameSession`
atomically projects every model-derived field from that model, replaces the live
hand with the finalized model, and the mount registry supplies the frozen
`GameMountView` branch, which has no intent port. The existing feature mount
remains in place under
the same hand key; effects that subscribe, attach blockchain services, autoplay,
or install command-producing keyboard handlers are disabled by the generic
frozen mount discriminant rather than by inspecting protocol phases.

The cohesive session modules own those responsibilities:

- `sessionMachine.ts` is the pure root reducer.
- `sessionMachineNotifications.ts` reduces normalized WASM notifications.
- `sessionMachineCommands.ts` maps UI events to typed commands.
- `sessionMachineEffects.ts` enforces authority → commands/save → React
  ordering; saves combine WASM cradle bytes with machine-owned `handState`.
- `sessionMachineInterpreter.ts` performs controller calls, timers,
  persistence, and async enrichment.
- `sessionMachinePersist.ts` assembles and writes snapshots at effect time.
- `gameSessionEvents.ts` parses session-owned terminal and coin payloads from WASM notifications.
- `session/incomingProposal.ts` validates the generic `ProposalMade` bridge,
  retains its exact opaque Bencodex parameters, and assembles
  `PendingProposalModel`. Rust alone applies factory semantics.

The controller still waits for its normal macrotask boundary, then drains one
active FIFO to quiescence so synchronously re-entrant WASM effects enter the
same machine transaction. A self-replenishing source yields after 100 events.
Terminal manager dispositions retain their separate queue-clearing and awaited
finalization path. Compose/review overlays retain the completed hand beneath an
inert subtree. The host retains only selector, timeout, and submission state;
the mounted package form owns transient controls.

### Game Components

The active game UI is rendered inside `GameSession` from the selected
`GamePackage`. `front-end/src/lib/gameRegistry.ts` looks packages up by catalog
key only. Frontend-only package erasure and React assembly live in
`front-end/src/lib/gamePackage.tsx`; they are not part of `games/host`.
`front-end/src/lib/gameMountRegistry.tsx` creates one
boolean-discriminated mount view for active, in-session terminal, and
cold-restored hands. The first generated member's initial validation
puzzle hash is the protocol id at the WASM propose/notify boundary
(`protocolIdForCatalog` out, `catalogGameTypeFromWire` in).
The generic proposal remains A/B-oriented at that boundary and carries the
exact opaque parameter value. Each package owns its Bencodex-only
`proposalParameters` codec for typed form values and UI projection; package
frontend code never interprets factory semantics.

Game packages share protocol/package types through `games/host`, but do not
share a React context, amount controls, currency formatting, settlement copy, or
keyboard shortcuts. Mojo values are absolute; each package owns its small
presentation implementation even when that duplicates another game. The player
app separately owns network-aware formatting and terminal notification policy.
Only Space Poker currently exposes the optional shared `cheat` intent, with its
`cheat^` listener implemented inside that package.

Each hook reads its concrete game-owned hand on every render. Local actions
mutate that package-private hand first, then submit a no-state `GameIntent`
through the shared Rust-first boundary; local-only durable changes emit
`state-changed`. Automatic moves use the same path and have no separate retry
journal. Browser restoration calls the package's `restoreHand` directly with
canonical saved state. The package's ordinary state-driven effect fires only
when that restored handler/turn still requires the automatic action. Because an
accepted queued command and the serialized Rust prepared queue are persisted
together, autoplay retries only when the last durable state predates queue
acceptance.

Space Poker keeps its hand history and terminal presentation inside
`useSpacepokerHand`. A betting-round fold, a showdown no-reveal concession, and
a revealed showdown remain distinct displays. The hook attributes a terminal
opponent action only when the current readable handler proves it; a
`GameSettled` notification alone does not imply that either player folded.
Terminal reveal, concession, and fold state commits when Rust accepts the intent
as queued or applied; a synchronous `MoveRejected` restores the temporary
checkpoint and leaves gameplay state unchanged. There is no game-owned rollback,
retry-recovery, or protocol-redo subsystem; unexpected infrastructure failures
are shown by shared host error UX, and the game never observes the chain itself.

The `useCalpokerHand` hook manages the five-step protocol:

- **Move 0** (auto) — nil move to initiate commit-reveal
- **Move 1** (interactive) — card selection and discard submission
- **Move 2** (auto) — final reveal
- **Outcome** — parsed from the opponent's final move into a `CalpokerOutcome`

Game components are **remounted from scratch for every hand**. The host mount
registry applies `session.handKey` as the React key after the game returns its
root element. Games do not manage this lifecycle policy themselves. This
ensures no stale state accumulates between hands.

What the game UI does **not** know about:

- Blockchain, channels, wallets, unrolling, on-chain resolution
- Channel-scope events
- Other games (in the future when multiple games are supported)
- What happens when things go wrong at the channel level — the session component
  handles all of that

## Notification Routing

`useGameSession` normalizes each WASM notification into a typed machine event.
`sessionMachineNotifications.ts` then reduces it and emits ordered effects into
the scoped queues, controller, persistence path, or async enrichment boundary.
Normalized game inputs update `model.game.handState` before React renders:

### Channel notification queue

Infrastructure-level events pushed to the channel-scoped FIFO queue
(`pushChannel`). These appear as dismissable, non-modal overlays at `z-50`
over the full session area. See
[Dashboard Status Labels](UX_NOTIFICATIONS.md#dashboard-status-labels) and
[Additional Design Rules](UX_NOTIFICATIONS.md#additional-design-rules) for
details.

| Kind            | Source                                                   |
| --------------- | -------------------------------------------------------- |
| `channel-state` | `ChannelStatus` in `ATTENTION_STATES` (replaceable slot) |
| `session-over`  | Balance exhausted → cooperative shutdown                 |
| `action-failed` | `ActionFailed` (WASM `Err`) — also logged                |
| `infra-error`   | `ReceiveError`, tx failures, general `error` events      |

### Game notification queue

In-game and between-hand events pushed to the game-scoped FIFO queue
(`pushGame`). Overlays appear at `z-40` within the game area.

| Kind                | Source                                                                                     |
| ------------------- | ------------------------------------------------------------------------------------------ |
| `proposal-rejected` | `ProposalCancelled` with `CancelledByPeer` (peer-side cancellation notice)                 |
| `insufficient-bal`  | `InsufficientBalance` notification                                                         |
| `move-rejected`     | `MoveRejected` — recoverable local input rejection (for example Krunk `not_in_dictionary`) |

Settlement banner labels come from `SETTLEMENT_OUTCOME_LABELS` in
`front-end/src/lib/settlement.ts` (see [settlement glossary](NAMING_AUDIT.md#settlement-glossary-ux)
and `CONNECTIVITY.md` "Settlement labels"). Adverse outcomes are flagged via
`isErrorSettlementOutcome` on `GameTerminalInfo.outcome`; terminal details stay
in host dashboard/status surfaces rather than creating a second queue entry.

### Game lifecycle (handled internally by session)

These drive game proposal and acceptance flow. They are consumed by
the notification reducer and never forwarded raw to the game UI:

- `ProposalMade` — one notification per pending terms record; carries an
  endpoint-local proposal ID and triggers proposal auto-accept
- `ProposalAcceptedGroup` — creates one game-owned hand from all ordered
  `{ id, player_a_contribution, player_b_contribution, our_turn,
readable_parameters }` members, identifies and consumes the endpoint-local
  proposal ID, and advances `handKey`

### Normalized game inputs

The runtime applies exactly three package-facing updates after construction:

- `move-readable`
- `message-readable`
- `hand-ended`

Raw move and message readables remain serialized bytes through the WASM
notification and session-event layers. When constructing a package update, the
host maps the private protocol game ID to its stable factory-ordered
`memberIndex` and deserializes the readable once into a CLVM `Program`.
Factory-approved `readable_parameters` follows the same byte-to-`Program`
boundary and initializes each accepted member; requested proposal parameters
are not reused as approved economics.
`hand-ended` contains only that member index and normalized settlement outcome.
Reward amounts, coin IDs, labels, and abnormal-termination explanations remain
in the host's keyed instances and status surfaces. The package stores the
outcome and terminal/member activity it needs in its complete hand state.

There is no separate game-status event or action echo. Turn, replay, timeout,
on-chain, proposal, rejection, removal, abandonment, and freezing transitions
remain in the host model. Synchronous `MoveRejected` and controller exceptions
restore the temporary checkpoint; later `ActionFailed` notifications go to
shared error UX but cannot roll back already committed canonical game state.

## Single-Hand Enforcement

The WASM layer supports multiple simultaneous proposals and games, but the
frontend currently presents **one logical hand at a time**. A hand may already
contain multiple factory-ordered games—Krunk has two—so this policy must not be
implemented as a one-`GameID` protocol restriction. Single-hand enforcement
lives in JavaScript, keeping the WASM/Rust layer multi-hand-ready. When
multi-handing is added, the session component gains hand selection/multiplexing
and the JS-side admission and presentation guards are relaxed.

### JS-side guards

**Proposal admission guard** — the frontend admits at most one uncancelled
proposal across local and peer origins. Entries already queued for cancellation
do not occupy the slot. This is intentional product policy; Rust continues to
support multiple pending proposals (`MAX_PROPOSALS` is 100).

**Send guard** — the command interpreter checks the current machine authority
and does not call `SessionController.proposeGame` while
`model.game.activeIds` is non-empty. This prevents the user from proposing a
new hand while one is in progress without a mirror ref.

**Atomic factory proposals** — the proposal command constructs one request with
`game_type`, game-specific Bencodex `parameters`, and a shared game timeout.
`SessionController.proposeGame` sends that request to WASM and stores its
endpoint-local proposal ID. No game IDs or factory members exist yet. At
acceptance, both peers run the registered deterministic factory in wire order;
Calpoker and Space Poker create one game and Krunk creates two ordered games.
`ProposalAcceptedGroup` correlates the endpoint-local proposal ID with the
complete generated member list. Accept and cancel commands address the proposal
ID, while subsequent game commands address generated `GameID`s.

**Receive guard** — When `ProposalMade` arrives while any uncancelled local or
peer proposal exists, the notification reducer emits
`controller-cancel-proposal` for the new proposal without admitting it. A
proposal arriving during an active hand is likewise hidden and queued for
definitive cancellation.

**First-game proposal** — The initiator proposes the first game exactly once,
triggered by `ChannelStatus { state: Active }` while the machine's
`firstGameAccepted` coordination flag is false. The reducer advances that flag
in the same transition that emits the command. The receiver auto-accepts the
first `ProposalMade` through the symmetric reducer branch.

### WASM-side constraints

Two proposal constraints live in WASM because they arise from the potato
protocol's asynchronous nature and cannot be deferred to JS:

1. **`SupersededByIncoming`** — When a batch arrives containing a
   `Propose` from the peer, any locally queued `QueuedProposal`
   actions are removed from the `game_action_queue`. The queued proposals were
   built against a now-stale state (the incoming batch carries the potato and
   the definitive state). WASM emits one `ProposalCancelled { reason:
SupersededByIncoming }` for each removed proposal, keyed by endpoint-local ID.

2. **`PeerProposalPending`** — When JS calls `propose` while an
   unresolved peer proposal exists in the proposal ledger, WASM rejects
   immediately with `ProposalCancelled { reason: PeerProposalPending }`.
   This prevents silently cancelling the peer's proposal as a side effect
   of proposing our own.

Both represent the same fundamental situation — a collision between our
proposal intent and the peer's — hitting at different points in the potato
cycle. In case 1, our proposal was queued but unsent when the peer's batch
arrived. In case 2, the peer's proposal was already recorded when JS tried to
propose. The frontend handles both identically: stash the cancelled terms in
the machine-owned durable `betweenHand.pendingRetryHandProposal` field and wait for the
incoming peer proposal to surface
before deciding what to do (see
[Proposal Collision Handling](GAME_LIFECYCLE.md#proposal-collision-handling)).

Everything else in WASM — `MAX_PROPOSALS` (100), nonce parity/monotonicity,
factory/member consistency, positive shared timeout validation, aggregate
balance preflight, and all-or-none generation of accepted members — are validation/safety
checks, not single-hand enforcement. They exist to prevent protocol violations,
not to limit concurrency.

## Key Files

File boundaries follow runtime ownership; decomposition is used where it
removes competing state owners or duplicate lifecycle mechanisms.

| File                                                  | Purpose                                                                                                                                                         |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `front-end/src/components/Shell.tsx`                  | Top-level component: boot dialogs, wallet, hub, GameDashboard banner, tabs, logs                                                                                |
| `front-end/src/components/GameSession.tsx`            | Game session UI: header, coin status, game area, overlays                                                                                                       |
| `front-end/src/hooks/useGameSession.ts`               | Thin React boundary: controller/runtime setup, host subscription, typed dispatch, selector projection                                                           |
| `front-end/src/lib/session/sessionMachine*.ts`        | Root dispatcher plus cohesive channel, between-hand, proposal, durable-game, notification, command, effect, runtime, and persistence modules                    |
| `front-end/src/lib/session/persistence*.ts`           | Canonical strict aggregate-v3 decoder plus primitive and payload validators; accepted roots always produce a normalized `SessionModel`                          |
| `front-end/src/lib/session/sessionSnapshot.ts`        | Canonical `SessionModel` → aggregate presentation snapshot encoder                                                                                              |
| `front-end/src/lib/gameRegistry.ts`                   | Catalog-key package lookup, generic proposal validation/equality, hand creation, and snapshots                                                                  |
| `front-end/src/lib/session/incomingProposal.ts`       | Generic opaque `ProposalMade` bridge validation and scalar pending-proposal assembly                                                                            |
| `front-end/src/lib/gameMountRegistry.tsx`             | One frozen/live discriminated mount dispatched through the selected package                                                                                     |
| `games/calpoker/ui/useCalpokerHand.ts`                | Calpoker hook: five-step protocol, card parsing, move submission                                                                                                |
| `front-end/src/hooks/SessionController.ts`            | WASM bridge (`SessionController` class): message delivery, block data, event queue, `getWasmFields()` for persistence                                           |
| `front-end/src/hooks/WasmStateInit.ts`                | WASM bootstrap: page-load binary/preset fetch, background factory warm, create cradle                                                                           |
| `front-end/src/lib/gameIdentities.ts`                 | Factory warmup and the catalog↔hash table used at the WASM propose/notify boundary                                                                             |
| `front-end/src/hooks/blobSingleton.ts`                | Singleton management: `getOrCreateSessionController` / `destroySessionController`; restore path for session persistence                                         |
| `front-end/src/services/PeerSession.ts`               | Per-session peer state: session ID, peer ID, liveness, message buffering/routing, send methods                                                                  |
| `front-end/src/lib/session/storageRepository.ts`      | Sole aggregate owner: atomic claim/read, generation-fenced transforms, capture, checkpoint, and reset                                                           |
| `front-end/src/lib/session/walletOperationRuntime.ts` | Transient generation-fenced provider orchestration, material delivery, recovery, and cleanup over nested obligations                                            |
| `front-end/src/hooks/saveCoordination.ts`             | Resume markers, active-tab lease, and cross-tab persistence fencing                                                                                             |
| `front-end/src/hooks/saveHardReset.ts`                | Hard-reset and WalletConnect browser-storage cleanup                                                                                                            |
| `front-end/src/lib/session/indexedDb.ts`              | IndexedDB v5 coordination and strict aggregate record transactions                                                                                              |
| `front-end/src/lib/session/model.ts`                  | Session model + `selectGameDashboardView` / `selectStatusBarBalances`                                                                                           |
| `front-end/src/lib/reactPropSafe.ts`                  | Prop-safe cloning that preserves typed arrays / dense byte objects                                                                                              |
| `front-end/src/hooks/BlockchainPoller.ts`             | Chain polling coordinator: height ticks, coin-state reports, watch deltas, restore snapshots                                                                    |
| `front-end/src/lib/AsyncScheduler.ts`                 | Generic serialized async queue and repeating polling loop                                                                                                       |
| `front-end/src/hooks/FakeBlockchainInterface.ts`      | Simulator blockchain backend: WebSocket to local sim, auto-reconnect                                                                                            |
| `front-end/src/hooks/RealBlockchainInterface.ts`      | WalletConnect blockchain backend: RPC via WalletConnect sessions                                                                                                |
| `front-end/src/hooks/WalletConnectRpc.ts`             | WalletConnect RPC formatting/normalization helpers                                                                                                              |
| `front-end/src/services/HubConnection.ts`             | Game relay WebSocket client (`/ws/game`)                                                                                                                        |
| `front-end/src/types/ChiaGaming.ts`                   | TypeScript types for WASM interface and game data                                                                                                               |
| `hub/hub-frontend/src/hub.tsx`                        | Hub UI; reports the chosen alias through the hub's internal WebSocket interface                                                                                 |
| `hub/hub-frontend/src/useHubSocket.ts`                | Hub channel hook (`useHubSocket`): hub WebSocket join/challenge/alias messaging                                                                                 |
| `hub/hub-service/src/index.ts`                        | Hub server: hub, challenges, addressed message relay, liveness sweep                                                                                            |
| `hub/hub-service/src/hubState.ts`                     | Hub state: players, challenges                                                                                                                                  |
