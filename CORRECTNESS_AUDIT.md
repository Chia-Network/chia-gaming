# Correctness Audit Report

Date: 2026-06-11

This audit covered the Rust/WASM state-channel core, Chialisp referee and
reference games, the player app, tracker service, and lobby frontend. Findings
below were first gathered by focused sub-agents, then rechecked against the
cited code paths. Wallet-call error handling was intentionally skipped.

## Resolved Since Audit

- Malformed terminal Calpoker/Space Poker moves now get a shared terminal
  nil-evidence precheck before their-turn handlers run, so shape-invalid
  terminal moves can be slashed without relying on handler assertions.
- Local outgoing moves now get a generic max-move-size check before being
  accepted. Non-terminal moves keep strict pre-send validator execution, and
  terminal moves now also run a nil-evidence validator precheck to catch
  immediately slashable terminal output.
- Player-app BigInt handling now has explicit persistence and React-boundary
  rules. Session persistence uses lossless tagged BigInt JSON helpers, domain
  hooks/session state keep protocol values as `bigint`, and game view props are
  adapted to string/number display values where React/dev diagnostics can
  otherwise trip over native BigInt serialization.
- Calpoker mid-hand display state now uses the canonical hand arrays as the
  single card-order source. Legacy duplicated snapshot card-order fields are
  dropped on restore, and the end-of-hand proposal dialog hides the completed
  game interface instead of leaving the final table visible behind it.
- Space Poker now persists and restores its hook/FSM display state instead of
  restarting from `CommitA` after reload, avoiding accidental auto-play against
  a restored mid-hand WASM state.
- Space Poker terminal settlement now distinguishes game-level accept/concession
  from poker actions. Normal betting folds and losing showdown concessions both
  call the accept hook rather than encoding a fold move, but only normal betting
  folds appear in hand history; if the final reveal is elided, the winning side
  sees that they won without seeing the loser's hidden hole-card/showdown data.
- The transaction manager now prunes obsolete retained submissions when a
  conflicting transaction wins. Retained submissions track expected output coins:
  if an input is spent and the expected output appears, that transaction is
  considered the winner and remains replayable; if the input is spent without
  the expected output appearing, the cached local intent is forgotten rather than
  replayed after reload/reorg.

## Findings

### Critical: Public lobby updates expose bearer session tokens

Paths: `lobby/lobby-service/src/types/lobby.ts`,
`lobby/lobby-service/src/lobbyState.ts`,
`lobby/lobby-service/src/index.ts`

`Player` includes `session_id`, `Lobby.getPlayers()` returns full player
objects, and `broadcastLobbyUpdate()` sends that list to every lobby client.
The game channel then trusts client-supplied `session_id` values in JSON
messages such as `message`, `chat`, `close`, and `set_status`.

Bad scenario: any lobby client learns another player's `session_id` from
`lobby_update`, opens `/ws/game`, identifies as that session, and replaces the
real game socket. It can then close the victim's pairing, spoof relay-control
messages, send chat, or mark the victim available/busy. Binary frames use
socket metadata after identify, so stealing the session also compromises the
authoritative relay path.

Why tests miss it: there are no behavioral tests for `lobby/lobby-service`.
Existing `front-end` tracker tests mock the server and do not assert that
public lobby DTOs omit private tokens.

Fix direction: keep `session_id` strictly server-private. Broadcast a public
player DTO without it. For all game JSON handlers, derive identity from
`wsGameMeta` for the current socket and reject payloads whose socket is not
identified or whose payload session does not match.

### Critical: Failed lobby joins can still take over a player's lobby socket

Path: `lobby/lobby-service/src/index.ts`

The lobby WebSocket handler sets `wsLobbyMeta`, closes the previous lobby
socket, and installs `lobbyConnections[parsed.id] = ws` before
`onLobbyJoin()` validates that the supplied `session_id` belongs to that
player. If `bindSessionToPlayer()` rejects the session, `onLobbyJoin()` returns
without undoing those mutations.

Bad scenario: an attacker sends `join` with a victim `id` and a reused or
invalid `session_id`. The join is rejected, but the real lobby connection has
already been replaced and future mutating lobby messages on the attacker socket
are treated as coming from the victim via `wsLobbyMeta`.

Why tests miss it: no tracker-service tests cover rejected joins or session
reuse. The current code also uses client IDs as fallbacks for some mutating
commands, which hides ownership mistakes.

Fix direction: validate session ownership before setting socket metadata,
closing existing sockets, or updating `lobbyConnections`. Only mark a socket as
player-owned after a successful join, and remove client-ID fallback authority
for mutating commands.

### High: Tracker allows rematches involving players already marked `playing`

Path: `lobby/lobby-service/src/index.ts`

`onChallenge()` rejects `busy` players but not `playing` players. A custom
client can challenge a player already in a pairing, and `onChallengeAccept()`
will remove old pairings and send `closed` to both sides before creating the
new pairing.

Bad scenario: while Alice and Bob are playing, Mallory challenges Alice with a
custom client. If accepted, the server tears down Alice's active pairing and
emits `closed`, forcing unrelated session disruption even though the UI would
not have shown the challenge button.

Why tests miss it: no server-side challenge lifecycle tests exist; the only
guard is frontend UI state.

Fix direction: enforce `status === 'waiting'` for both challenger and target
when creating and accepting challenges. Treat UI disabling as cosmetic only.

### High: Stale-unroll preemption is not managed for retry or reorg

Path: `src/potato_handler/spend_channel_coin_handler.rs`

For `UnrollOutcome::Preempted`, the handler emits `Effect::SpendTransaction`
once, then registers the unroll coin with `spend: None`. Timeout paths register
managed spends that the transaction manager submits and resubmits when ripe;
preemption does not get the same durability.

Bad scenario: an opponent publishes a stale unroll. We generate the correct
preemption, but the transaction is dropped, not propagated, or reorged out. The
manager has no stored preemption bundle to retry, so the stale timeout path can
eventually win.

Why tests miss it: stale-unroll tests do not simulate one dropped preemption or
a preemption reorg before the unroll timeout.

Fix direction: make preemptions managed safety transactions, either by storing
them on the watched unroll coin or by adding a manager-owned pending-spend class
for immediate retry and reorg replay.

### High: Peer receive errors can bypass the dispute path

Paths: `src/peer_container.rs`, `src/potato_handler/mod.rs`

`PotatoHandler::received_message()` turns any peer-message processing error into
`go_on_chain(true)`. But `SynchronousGameCradle::flush_and_collect()` and
`process_effects()` catch errors from queued or pending messages and only emit
`CradleEvent::ReceiveError`. `SynchronousGameCradle::deliver_message()` also
rejects messages over 10 MiB before the active handler can apply its own
oversize-message dispute behavior.

Bad scenario: a bad `Batch` queued during handshake is processed after the
transition via `process_incoming_message()`, fails, and becomes a UI error
rather than a channel dispute. Oversized inbound bytes can similarly return an
error without moving the active channel on-chain.

Why tests miss it: tests mostly deliver post-handshake messages directly through
the normal `received_message()` path and do not cover queued bad batches or
container-level oversize rejection.

Fix direction: centralize peer-message failure handling at the cradle boundary.
When the active handler owns an open channel, any peer protocol error should
route through the same `go_on_chain(true)` behavior.

### High: Local batch construction mutates state before later local actions fail

Path: `src/potato_handler/mod.rs`

`drain_queue_into_batch()` pops local queued actions and mutates the
`ChannelHandler` as it goes. If a later action errors, earlier mutations,
cached redo state, notifications, and queue changes are not rolled back. This
same local-drain call runs after receiving a valid peer batch when the potato
returns.

Bad scenario: a valid local move is queued before a stale `AcceptTimeout` or
invalid clean shutdown. The move mutates channel/referee state, the later action
errors, no batch is sent, and the local state can diverge from the peer. If this
happens while processing an otherwise valid peer batch, the peer may be blamed
and the session can be forced on-chain unnecessarily.

Why tests miss it: peer batch atomicity is tested, but multi-action local queues
with a later stale local intent are not.

Fix direction: snapshot `channel_handler`, `game_action_queue`, potato state,
shutdown state, and cached spend state before local draining, then restore on
local-drain failure. Also consider dropping stale local intents before mutation.

### High: Restore can skip initial tracker reconciliation

Path: `front-end/src/components/Shell.tsx`

`connectToTracker()` calls `startSession()` immediately when `peekSession()` has
a `pairingToken`. `startSession()` sets `activePairingTokenRef` before the first
tracker `connection_status` arrives. The first status is therefore processed as
a mid-session reconnect, not as the documented initial-page-load reconciliation.

Bad scenario: local storage has pairing token `T1`, but the tracker reports a
different pairing `T2` after reload. The initial reconciliation branch that
would close the unknown tracker pairing is skipped; the app just marks the peer
inactive and keeps stale tracker state around.

Why tests miss it: tracker tests cover `TrackerConnection` callback routing and
session-model selectors, not Shell's ordering between eager `startSession()` and
the first `connection_status`.

Fix direction: do not set `activePairingTokenRef` until the first
`connection_status` has been reconciled, or track an explicit
`awaitingInitialStatusAfterRestore` mode.

### High: Failed WASM message delivery advances and ACKs the message

Path: `front-end/src/hooks/WasmBlobWrapper.ts`

`deliverSingleMessage()` sets `remoteNumber = msgno` before calling
`cradle.deliver_message(msg)`. If WASM throws, the catch emits an error, but the
code still queues an ACK and marks the state for immediate durability.

Bad scenario: malformed or invalid peer bytes fail inside WASM. The save then
records the message as delivered and sends an ACK. After reload, duplicates are
dropped because `remoteNumber` already advanced even though the protocol engine
never accepted the message.

Why tests miss it: message protocol tests cover ordering, duplicates, buffering,
and resend behavior, but not a throwing `deliver_message`.

Fix direction: advance `remoteNumber` and ACK only after successful delivery, or
transition explicitly to a dispute/error state without acknowledging
unprocessed protocol bytes.

### High: Outgoing proposal terms are not restorable

Paths: `front-end/src/hooks/useGameSession.ts`,
`front-end/src/lib/session/model.ts`

`useGameSession` keeps `proposalTermsByIdRef` in memory, and
`ProposalAccepted` uses it to set `lastHandTerms`, `composePerHandAmount`, and
`activeGameType`. The session model snapshots `outgoingProposalIds` and
`pendingRetryTerms`, but it does not persist the proposal ID to terms map, and
`sessionModelFromSave()` does not restore it.

Bad scenario: a player proposes Space Poker or changed stake terms, reloads
before peer acceptance, then receives `ProposalAccepted`. The WASM game starts
with the accepted terms, but the UI may keep the previous/default game type and
amount because `acceptedTerms` is missing.

Why tests miss it: session-model tests cover incoming reviewed proposals and
basic snapshots, not pending outgoing proposal acceptance after restore.

Fix direction: persist and restore proposal terms by ID, or derive accepted
terms from restored WASM/session facts rather than ephemeral refs.

### Medium: Peer proposal amount addition can overflow

Paths: `src/channel_handler/mod.rs`, `src/common/types/amount.rs`

`ChannelHandler::apply_received_proposal()` computes
`my_contribution_this_game + their_contribution_this_game` using `Amount`'s
unchecked `Add` implementation over `u64`.

Bad scenario: a peer sends contribution amounts whose sum overflows `u64`.
Debug builds can panic, while release builds can wrap before the total is
compared to the proposed amount. Malformed peer data should be rejected cleanly,
not panic or pass a wrapped validation.

Why tests miss it: proposal validation tests use normal small amounts.

Fix direction: add `Amount::checked_add()` and use it for peer-controlled amount
aggregation and balance accounting.

### Medium: Fake blockchain ignores funding max-height assertions

Paths: `front-end/src/hooks/FakeBlockchainInterface.ts`,
`src/simulator/service.rs`

The WASM bridge passes `NeedCoinSpend.max_height` into `createOfferForIds()`.
`RealBlockchainInterface` converts it into `ASSERT_BEFORE_HEIGHT_ABSOLUTE`, but
`FakeBlockchainInterface` accepts `_maxHeight` and never forwards it. The
simulator service request type has no `maxHeight` field.

Bad scenario: simulator/fake-wallet funding spends can remain valid after the
handshake expiry height that the transaction manager uses to mark the channel
failed. A delayed fake funding transaction can create a channel after the UI has
already observed failure.

Why tests miss it: simulator helpers validate and copy extra conditions, but no
test asserts that funding spends include the absolute height guard.

Fix direction: thread `maxHeight` through `FakeBlockchainInterface` and the
simulator service, append `ASSERT_BEFORE_HEIGHT_ABSOLUTE`, and assert it in
simulator funding tests.

### Medium: Challenge amounts are accepted without server validation

Paths: `lobby/lobby-service/src/index.ts`,
`lobby/lobby-service/src/lobbyState.ts`,
`front-end/src/components/Shell.tsx`

The tracker stores `challenge.amount` as the provided string. The UI validates
ordinary input, but custom clients can send malformed, negative, decimal,
empty, or huge strings. `Shell` later parses matched amounts with `BigInt` and
falls back inconsistently on parse failure.

Bad scenario: a custom lobby client creates a match with invalid or extreme
amount text. The two clients can disagree with user-visible challenge terms, or
start a session with fallback/default amounts that were not what the accepter
believed they accepted.

Why tests miss it: no server challenge validation tests exist.

Fix direction: parse and validate amount on the tracker before creating a
challenge, enforce positive integer canonical strings and protocol bounds, and
broadcast only canonical amounts.

### Medium-Low: Space Poker open advisory messages are unauthenticated

Path: `clsp/games/spacepoker/spacepoker_generate.clinc`

`spacepoker_alice_parse_open_message` and
`spacepoker_bob_parse_open_message` derive displayed community cards directly
from advisory `message` data. Unlike the deal parser, they do not check message
length or verify that the preimage hashes to the committed image in state.

Bad scenario: a peer sends bogus advisory data. The recipient can display fake
community cards until the formal move arrives. A large advisory message can
also waste parser cost on a non-authoritative path.

Why tests miss it: current parser tests exercise happy-path advisory messages.

Fix direction: assert 32-byte messages and verify the hash against the relevant
committed image from state before deriving cards.

## Coverage and Test Results

- Latest post-fix `./ct.sh` run completed successfully: Rust build/tests,
  Chialisp build, lobby build, and all frontend/WASM suites passed.
- Ran `pnpm test` in `lobby/lobby-service`: passed TypeScript check.
- Ran `pnpm test` in `lobby/lobby-frontend`: passed TypeScript check.
- Ran targeted frontend audit suites:
  `tracker_connection.test.ts`, `message_protocol.test.ts`,
  `session_model.test.ts`, `restore_lifecycle.test.ts`, `save.test.ts`, and
  `blockchain_poller.test.ts`: all passed.

High-value missing tests:

- Tracker-service behavioral tests for session secrecy, rejected join rollback,
  challenge availability, amount validation, and rematch teardown.
- Transaction-manager tests for confirmed conflicting-spend/error handling if
  that recovery path is added.
- Stale-unroll tests where preemption is dropped or reorged out.
- Cradle/potato tests for queued bad peer messages and oversized-message
  dispute escalation.
- Frontend Shell integration tests for restore-first `connection_status`
  reconciliation.
- Message protocol test for `deliver_message` throwing.
- Space Poker restore regression tests for mid-hand reload, terminal
  accept/concession display, and pending outgoing proposal restore tests.

## Reviewed Scope

- Rust protocol core: `src/potato_handler`, `src/channel_handler`,
  `src/referee`, `src/transaction_manager.rs`, `src/peer_container.rs`.
- Chialisp protocol/game logic: `clsp/unroll`, `clsp/referee`,
  `clsp/games/calpoker`, `clsp/games/spacepoker`.
- Player app: `front-end/src/components/Shell.tsx`,
  `front-end/src/hooks`, `front-end/src/services/TrackerConnection.ts`,
  `front-end/src/lib/session`.
- Tracker and lobby: `lobby/lobby-service/src`,
  `lobby/lobby-frontend/src`, plus player-app tracker integration.

## Skipped By Request

- Error conditions returned from wallet calls.
- Unrelated checked-in files and low-risk assets: `bencodex`, image assets,
  pure styling, deploy/build scripts not tied to puzzle bytecode correctness,
  `chia-gaming-agent`, unused CLSP tests, and `clsp/games/krunk`.
