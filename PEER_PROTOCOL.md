# Peer Protocol

## 1. Scope

This document specifies the protocol between two player applications. Peer
payloads are relayed by the hub protocol in
[`WEBSOCKET_PROTOCOL.md`](WEBSOCKET_PROTOCOL.md), but the hub does not
participate in the protocol defined here.

The protocol is layered:

```text
addressed hub relay payload
├── pre-session peer app message
│   └── Bencodex dictionary
└── reliable peer frame
    ├── data
    │   └── Bencodex PeerMessage
    ├── acknowledgement
    └── keepalive
```

The shared reliable frame supplies replay, deduplication, ordering, and
durability for all authoritative semantic messages, including handshake
messages. Pre-session negotiation messages are outside that wrapper.

This document covers:

- pre-session negotiation;
- reliable peer framing;
- Bencodex encoding;
- the six-message channel handshake;
- potato ownership and batches;
- game proposals, moves, settlements, and game messages; and
- cooperative shutdown.

Wallet RPC, blockchain polling, chain reorganization, transaction submission,
and on-chain game resolution are out of scope. Chia objects that cross the peer
wire are specified as data types even when their later use is out of scope.

## 2. Peer relay-payload classes and reliable frame bytes

The first byte of an addressed hub relay payload discriminates the peer payload
class:

```text
0x64   pre-session Bencodex dictionary
0x01   reliable data frame
0x02   reliable acknowledgement frame
0x03   reliable keepalive frame
```

The `0x64` value is the Bencodex dictionary marker. Pre-session dictionaries are
placed directly in the addressed relay payload. Reliable frames wrap every
authoritative semantic message, including every handshake message.

### 2.1 Reliable frame encoding

```text
Data:
+--------+----------------+---------------------------+
| 0x01   | msgno: u32 BE | Bencodex PeerMessage      |
+--------+----------------+---------------------------+

Acknowledgement:
+--------+----------------+
| 0x02   | msgno: u32 BE |
+--------+----------------+

Keepalive:
+--------+
| 0x03   |
+--------+
```

Canonical acknowledgement frames are exactly five bytes. Canonical keepalive
frames are exactly one byte. The current decoder accepts trailing bytes on
either frame, but senders must not emit them.

Message numbering starts at 1 for a new session. Zero is the initial received
message number. The wire counter is an unsigned 32-bit integer. The current
protocol does not define rollover; a sender must not wrap the counter within a
session.

## 3. Bencodex wire encoding

The body of every data frame is exactly one Bencodex `PeerMessage`. There is no
numeric message tag or magic prefix. The required peer protocol version is
advertised in the Handshake A/B capability map described in section 7.1.

### 3.1 Primitive values

```text
Null / unit / None    n
False                 f
True                  t
Integer               i<canonical decimal ASCII>e
Byte string           <decimal byte length>:<bytes>
UTF-8 text            u<decimal byte length>:<UTF-8 bytes>
List                  l<values>e
Dictionary            d<key><value>...e
```

Canonical integers:

- contain no leading `+`;
- use no leading zero except the value `0`;
- never encode negative zero; and
- fit the destination integer type.

Dictionary keys are byte strings or text. Encoders sort byte-string keys before
text keys, then sort by unsigned bytewise lexical order within each class. All
protocol structs use text keys.

Decoders reject trailing bytes after the top-level value.

### 3.2 Compound, record, variant, and optional values

Unless a later schema gives a more specific exact encoding, compound values use
these normative Bencodex shapes:

```text
Record:
  d <sorted field-name/value pairs> e

Unit variant:
  Text(variant name)

Single-value variant:
  d Text(variant name) <value> e

Positional variant:
  d Text(variant name) l <tuple fields> e e

Record variant:
  d Text(variant name) d <sorted field-name/value pairs> e e

Absent optional value:
  n

Present optional value:
  <value>
```

Record field names and variant names are case-sensitive UTF-8 text. Record
fields are emitted in the canonical dictionary-key order from section 3.1.
Unless a field schema explicitly says that an absent value omits the field, an
optional field remains present and its absent value is `n`.

Every schema field declared `Bytes` uses a Bencodex byte string. In particular,
empty bytes encode as `0:`. Bencodex lists are reserved for semantic sequences
and are not an alternate encoding for binary strings. The receiver rejects a
generic Bencodex list wherever the schema requires semantic bytes.

### 3.3 Common wire types

- `Amount`, `GameID`, and `Timeout` are non-negative Bencodex integers limited
  to `u64`.
- Wire move-size fields are non-negative Bencodex integers limited to `u32`.
- `Hash`, `PuzzleHash`, and `CoinID` are byte strings containing exactly 32
  bytes.
- `PublicKey` is a byte string containing one valid compressed 48-byte BLS
  public key.
- `Aggsig` is a byte string containing one valid compressed 96-byte BLS
  signature. The BLS default signature canonically encodes as `0:`.
- `GameType` is text containing the lowercase 64-character hexadecimal encoding
  of a 32-byte hash. Senders use lowercase; the current decoder also accepts
  mixed-case hexadecimal.
- `Program` and `ProgramRef` are byte strings containing serialized CLVM.
- `Puzzle` has the same wire representation as `ProgramRef`.
- `CoinString` is a byte string containing:
  `parent CoinID || puzzle hash || canonical non-negative CLVM amount atom`.
  Semantic use requires at least the two 32-byte hashes and an amount fitting
  `u64`.

Compound Chia types used below are:

```text
Spend {
  puzzle: Puzzle,
  solution: ProgramRef,
  signature: Aggsig
}

CoinSpend {
  coin: CoinString,
  bundle: Spend
}

SpendBundle {
  name: Option<Text>,
  spends: List<CoinSpend>
}

StateUpdateSignatures {
  channel_half_sig: Aggsig,
  unroll_preempt_half_sig: Aggsig
}
```

`channel_half_sig` signs the channel-coin spend committing to the new unroll
state. `unroll_preempt_half_sig` signs the preemption of an older unroll to that
state. Each is one party's half of a two-party aggregate signature.

## 4. Pre-session message wire dictionaries

Pre-session messages are raw Bencodex dictionaries placed directly in an
addressed hub relay payload. They are not numbered, acknowledged, replayed, or
deduplicated by the reliable peer layer.

### 4.1 `session_proposal`

Requests local consent to start a session:

```text
{
  "type":            Text("session_proposal"),
  "proposer_amount": Text,
  "responder_amount":Text,
  "from_alias":      Text,  // optional
  "channel_timeout": Text,  // optional
  "unroll_timeout":  Text,  // optional
  "game_session_id": Text,  // optional in the current decoder
  "network":         Text   // required by intake validation
}
```

Amounts are positive canonical decimal integer strings. Optional timeouts are
canonical decimal block counts in the range 3 through 30. `network` must be
`mainnet` or `testnet` and must match the receiver's selected network.

The current sender always supplies a randomly generated `game_session_id`.
The current receiver accepts its absence and generates a local value. This
identifier is host persistence metadata; it is not carried in reliable frames
and is not a cryptographic session binding.

A receiver rejects the proposal without starting the peer protocol if:

- it is unavailable or already handling another session;
- either amount is invalid;
- either timeout is invalid; or
- the network is absent, invalid, or different.

### 4.2 `session_reject`

Declines or aborts a pre-session attempt:

```text
{
  "type": Text("session_reject")
}
```

This message has no acknowledgement. During an active session, the current host
marks the matching peer route dead but does not pass this message into the peer
protocol.

## 5. Reliable delivery semantics

### 5.1 Outbound durability

Before sending a data frame, the host:

1. allocates the next message number;
2. stores the message in its unacknowledged-message list;
3. persists the protocol session, next message number, last received number,
   and unacknowledged-message list; and
4. sends the frame only after that persistence operation succeeds.

If sending fails because the hub connection is not open, the frame remains
queued.

The sender retains a data frame until it receives a cumulative acknowledgement
covering that frame.

### 5.2 Inbound ordering and deduplication

Let `remoteNumber` be the highest contiguous message number already delivered
to the peer protocol.

- `msgno <= remoteNumber`: the frame is a duplicate. Do not deliver it again.
  Re-send an acknowledgement for `msgno` and replay locally unacknowledged
  outbound messages.
- `msgno == remoteNumber + 1`: deliver it once, then advance
  `remoteNumber`.
- `msgno > remoteNumber + 1`: retain it in the runtime reorder buffer until all
  preceding messages arrive. Do not acknowledge it yet.

After delivering one message, the host delivers every newly contiguous frame
from the reorder buffer in ascending order.

Before sending an acknowledgement for a newly delivered message, the host
persists the advanced `remoteNumber` and resulting protocol session state.

The reorder buffer is not persisted. After reload, the sender's persisted
unacknowledged list is responsible for replaying frames that had not been
acknowledged.

### 5.3 Acknowledgements

An acknowledgement for N is cumulative: it confirms every local outbound frame
with `msgno <= N`. The sender removes all such frames from its unacknowledged
list.

An acknowledgement is a transport fact only. It means the receiver durably
processed that numbered `PeerMessage`; it does not separately assert that an
on-chain transaction succeeded.

### 5.4 Replay

The host replays all unacknowledged data frames:

- after restoring a saved session;
- when the hub game WebSocket reconnect callback fires;
- after the hub sends `registered` on a reconnected game socket;
- when it receives a peer keepalive; and
- when it receives a duplicate data frame.

The current sender throttles replay bursts to at most once per second.

### 5.5 Keepalive

Each active peer sends `0x03` every 15 seconds. No reply is required. Data,
acknowledgement, and keepalive frames all count as peer activity.

This keepalive tests the complete player-to-hub-to-peer path. It is independent
from the hub control keepalive described in `WEBSOCKET_PROTOCOL.md`.

### 5.6 Invalid reliable frames

The host ignores:

- empty frames;
- data or acknowledgement frames shorter than five bytes; and
- unknown tags.

They do not count as peer activity.

The reliable layer accepts only frames attributed by the hub to the selected
peer ID. Other senders are ignored.

### 5.7 Local receive policy

Receive limits are local denial-of-service policy, not negotiated protocol
constants. A deployment may configure them more strictly or generously without
changing the wire format. The current browser defaults are:

- at most a 4,096-message gap ahead of the next expected reliable message;
- at most 1,024 retained inbound messages across pre-handler, pre-ready, and
  out-of-order queues;
- at most 64 MiB retained across those queues; and
- at most 10 MiB in one Bencodex `PeerMessage` body (the five-byte reliable
  header and hub relay headers are outside this count).

The handshake activation-lag queue applies the same current body, count, and
byte defaults. Exceeding local receive policy is handled as invalid peer input.

Malformed, oversized, or semantically invalid messages are peer protocol
violations. Before channel activation they fail the handshake. During off-chain
play they terminate normal peer processing and invoke the application's
on-chain escalation path.

## 6. `PeerMessage` envelope

The top-level message is one of:

```text
HandshakeA(HandshakePayloadB)
HandshakeB(HandshakePayloadB)
HandshakeC(HandshakePayloadC)
HandshakeD(HandshakePayloadD)
HandshakeE(HandshakePayloadE)
HandshakeF(HandshakePayloadF)
Batch {
  actions: List<BatchAction>,
  signatures: StateUpdateSignatures
}
CleanShutdown {
  channel_half_sig: Aggsig,
  payout_conditions: ProgramRef
}
CleanShutdownComplete(CoinSpend)
RequestPotato(())
Message(GameID, Bytes)
```

The top-level discriminant is the exact case-sensitive variant name.

The intentional externally tagged outer shapes are:

```text
HandshakeA: d u10:HandshakeA <HandshakePayloadB struct> e
HandshakeB: d u10:HandshakeB <HandshakePayloadB struct> e
HandshakeC: d u10:HandshakeC <HandshakePayloadC struct> e
HandshakeD: d u10:HandshakeD <HandshakePayloadD struct> e
HandshakeE: d u10:HandshakeE <HandshakePayloadE struct> e
HandshakeF: d u10:HandshakeF <HandshakePayloadF struct> e
Batch: d u5:Batch <Batch fields struct> e
CleanShutdown: d u13:CleanShutdown <CleanShutdown fields struct> e
CleanShutdownComplete: d u21:CleanShutdownComplete <CoinSpend struct> e
RequestPotato: d u13:RequestPotato n e
Message: d u7:Message l i<game_id>e <byte string> e e
```

Thus `RequestPotato(())` is byte-exact `du13:RequestPotatone`; it is not a unit
variant or an empty list.

## 7. Handshake messages

### 7.1 Shared A/B payload

Messages A and B carry the same struct:

```text
HandshakePayloadB {
  capabilities: Map<Text, u32>,
  channel_public_key: PublicKey,
  unroll_public_key: PublicKey,
  reward_puzzle_hash: PuzzleHash,
  referee_pubkey: PublicKey,
  reward_payout_signature: Aggsig,
  channel_key_pop: Aggsig,
  unroll_key_pop: Aggsig,
  my_contribution: Amount,
  their_contribution: Amount
}
```

`capabilities` is a text-keyed version map. Both A and B must contain
`"peer_protocol": 1`. Any missing or different value is rejected. Unknown keys
are ignored so independently introduced capabilities do not change protocol-1
behavior.

Contribution names are from the sender's perspective. A receiver requires:

```text
message.my_contribution    == locally expected peer contribution
message.their_contribution == locally expected own contribution
```

`channel_key_pop` is a signature by `channel_public_key` over that public key's
48 serialized bytes. `unroll_key_pop` is defined analogously. The reward payout
signature binds `referee_pubkey` to `reward_puzzle_hash`.

### 7.2 Handshake A

```text
Initiator -> Receiver: HandshakeA(HandshakePayloadB)
```

The receiver:

1. verifies both proofs of possession;
2. verifies the reward payout signature;
3. verifies the contribution orientation; and
4. returns its own key material in Handshake B.

### 7.3 Handshake B

```text
Receiver -> Initiator: HandshakeB(HandshakePayloadB)
```

The initiator performs the same key, reward, and contribution checks. It then
obtains a launcher coin through its local wallet integration.

### 7.4 Handshake C

```text
HandshakePayloadC {
  launcher_coin: CoinString
}

Initiator -> Receiver: HandshakeC(HandshakePayloadC)
```

This commits the concrete launcher and therefore the future channel coin ID
before either party sends state-zero signatures. The receiver requires the
launcher's puzzle hash to be the standard singleton launcher puzzle hash.

### 7.5 Handshake D

```text
HandshakePayloadD {
  signatures: StateUpdateSignatures
}

Receiver -> Initiator: HandshakeD(HandshakePayloadD)
```

These are the receiver's state-zero channel and unroll half-signatures. The
initiator verifies and stores both before continuing.

### 7.6 Handshake E

```text
HandshakePayloadE {
  bundle: SpendBundle,
  signatures: StateUpdateSignatures
}

Initiator -> Receiver: HandshakeE(HandshakePayloadE)
```

`bundle` is the partially assembled channel-funding transaction.
`signatures` contains the initiator's state-zero half-signatures. The receiver
verifies and stores the signatures before completing its local funding work.

### 7.7 Handshake F

```text
HandshakePayloadF {
  bundle: SpendBundle
}

Receiver -> Initiator: HandshakeF(HandshakePayloadF)
```

This is the completed funding bundle. Both applications may submit the same
bundle using their local transaction interface.

Channel activation is driven by a local channel-coin observation outside this
wire protocol. F and activation may be observed in either order, but transition
requires both the role's handshake work and that local observation to be
complete. After activation:

- the initiator begins with the potato;
- the receiver begins without it; and
- the off-chain phase ignores a late Handshake F.

In the initiator's finished handshake state, duplicate Handshake F messages are
accepted but ignored after the first funding-bundle submission.

### 7.8 Handshake ordering

The legal wire order is:

```text
Initiator                         Receiver
    |-------- HandshakeA ------------>|
    |<------- HandshakeB -------------|
    |-------- HandshakeC ------------>|
    |<------- HandshakeD -------------|
    |-------- HandshakeE ------------>|
    |<------- HandshakeF -------------|
```

Handshake processing is strict FIFO. Before E is sent or received, any peer
message other than the exact next A-F step is a protocol error, including while
waiting for a local wallet callback. After the initiator sends E, it accepts F
immediately and queues only non-handshake messages that arrived during local
activation lag. After the receiver receives E, it rejects every further A-F
message and queues only non-handshake activation-lag messages. Those retained
messages move to `OffChainPhase` in arrival order once local channel activation
is observed.

## 8. Potato protocol

The potato is exclusive permission to update off-chain channel state.

Each side tracks one of:

- `Absent`;
- `Requested`; or
- `Present`.

Only a side with `Present` may send `Batch`. Sending a batch changes the
sender's state to `Absent`. Successfully receiving and verifying a batch
changes the receiver's state to `Present`.

During transit there may be a period in which neither side locally reports
`Present`. A valid execution never has both sides holding it.

Receiving `Batch` while already holding the potato is a protocol violation.

## 9. `RequestPotato`

```text
Requester -> Holder: RequestPotato(())
```

If the receiver holds the potato, it sends an empty Batch and relinquishes it.
If it does not, it records that the peer wants the potato and services that
request when it next receives the potato.

Repeated requests are idempotent. A side in local `Requested` state does not
send additional requests.

While waiting for `CleanShutdownComplete`, `RequestPotato` is ignored.

## 10. `Batch`

### 10.1 Payload

```text
Batch {
  actions: List<BatchAction>,
  signatures: StateUpdateSignatures
}
```

`actions` are applied in list order. `signatures` always cover the final
committed channel state after every action and are always verified.

A normal batch increments the channel state number once, regardless of action
count.

### 10.2 Atomic processing

Before processing a received batch, the implementation snapshots:

- the complete channel state; and
- the local pending-action queue.

Any hard action error or final signature error restores both snapshots. No
intermediate game, balance, settlement, nonce, or local-queue mutation from
that batch may survive.

The sender is responsible for semantically useful action ordering. For example,
settlements or acceptances that free funds must precede proposals or
acceptances that consume those funds.

### 10.3 Empty batch

An empty `actions` list with valid signatures is the ordinary way to pass the
potato without another operation.

## 11. `BatchAction` messages

Each action uses the compound variant rules in section 3.2. Its exact outer wire
shape is:

```text
ProposeGroup:
  d u11:ProposeGroup <WireProposalGroup struct> e

AcceptProposalGroup:
  d u19:AcceptProposalGroup i<game_id>e e

CancelProposalGroup:
  d u18:CancelProposalGroup i<game_id>e e

Move:
  d u4:Move l i<game_id>e <GameMoveDetails struct> e e

AcceptSettlement:
  d u16:AcceptSettlement l i<game_id>e i<amount>e e e
```

### 11.1 `ProposeGroup`

```text
ProposeGroup(WireProposalGroup)

WireProposalGroup {
  start: GameProposal,
  members: List<WireGameSpec>
}

GameProposal {
  player_a_contribution: Amount,
  player_b_contribution: Amount,
  sender_is_player_a: Bool,
  game_type: GameType,
  timeout: Timeout,
  parameters: ProposalParameters
}

WireGameSpec {
  game_id: GameID,
  player_a_contribution: Amount,
  player_b_contribution: Amount,
  player_a_goes_first: Bool,
  initial_validation_program_hash: Hash,
  initial_validation_info_hash: Hash,
  initial_move: Bytes,
  initial_max_move_size: u32,
  initial_mover_share: Amount
}
```

`ProposalParameters` is recursively one of:

```text
Null | Bool | Integer(i128) | Bytes | Text | List<ProposalParameters>
```

Dictionaries are not valid proposal parameters.

`game_type` is the first generated member's initial validation program hash.
It is not a package name or factory hash.

The receiver runs its locally registered factory using `start.parameters`,
checks that the generated group agrees with `members`, and stores the proposals
as one atomic group. The first member's `game_id` is the canonical group ID.

Pending proposals are metadata. They do not alter balances or the signed
unroll commitment until accepted.

At most 100 individual proposed games may be outstanding. Attempting to add
another after the limit is reached is a hard batch error.

If the game type is unknown or the local factory rejects the parameters, the
current receiver logs a soft decline and does not store the proposal. It may
still accept the batch and potato transfer because an unaccepted proposal is
not part of the signed channel commitment. Structural disagreement between a
successful local factory result and `members` is a hard batch error.

Receiving a proposal group supersedes locally queued, not-yet-sent proposal
groups. Any queued clean-shutdown action is also removed when a batch contains
a proposal or proposal acceptance.

Game IDs use role parity: the initiator allocates even IDs and the receiver
allocates odd IDs. Received IDs must have the peer's parity, must not move
backwards, and must be no more than 1,000 above the receiver's minimum expected
nonce.

### 11.2 `AcceptProposalGroup`

```text
AcceptProposalGroup(GameID)
```

The ID must be the canonical group ID: the first member of a complete pending
group. The receiver accepts every member in factory insertion order. Acceptance
allocates each member's contributions, creates live games, and makes those
games part of the signed final channel state.

An unknown, non-canonical, incomplete, or unaffordable group is a hard batch
error.

### 11.3 `CancelProposalGroup`

```text
CancelProposalGroup(GameID)
```

The ID must be the canonical first member of a pending group. The receiver
removes every group member. Cancellation changes proposal metadata but does not
change balances or the unroll commitment.

An unknown or non-canonical group is a hard batch error.

### 11.4 `Move`

```text
Move(GameID, GameMoveDetails)

GameMoveDetails {
  basic: GameMoveStateInfo,
  validation_info_hash: ValidationInfoHash,
  validation_program_hash: Option<Hash>
}

GameMoveStateInfo {
  move_made: Bytes,
  mover_share: Amount,
  max_move_size: u32,
  max_move_size_raw: Bytes
}

ValidationInfoHash =
    None
  | Initial
  | Hash(Hash)
```

Its exact enum encoding is:

```text
None:
  u4:None

Initial:
  u7:Initial

Hash(value):
  d u4:Hash <32-byte byte string> e
```

`validation_program_hash` is omitted from the encoded struct when it is absent.

The receiver locates the live game, validates turn authority and the move using
the locally held game handlers, and updates the referee state. A valid move is
part of the signed final channel state.

`max_move_size_raw` preserves the exact CLVM atom bytes used when hashing the
resulting puzzle. It accompanies the decoded numeric `max_move_size`.

If the game becomes terminal, the receiver queues a local
`AcceptSettlement`.

The game their-turn handler may also return optional side-channel bytes. When
non-empty, the receiver sends those bytes back as a separate `Message` after
processing the batch.

### 11.5 `AcceptSettlement`

```text
AcceptSettlement(GameID, Amount)
```

The receiver removes the settled game and computes its own reward from local
game state. The transmitted `Amount` is not trusted and is not used as the
receiver's reward value.

Settlement changes balances and is included in the batch's signed final state.
After receiving a batch containing settlement acceptance, the receiver sends a
batch back even if it has no queued local action. This completes the signed
state round trip.

## 12. `Message`

```text
Message(GameID, Bytes)
```

This is a game-defined side channel outside `Batch`. It does not carry or
transfer the potato and does not increment the channel state number.

The target game must exist and must have a message parser installed by its
current handler. The parser receives the bytes and current game state and
returns a readable value for local presentation.

An unknown game, absent parser, or parser failure is a peer protocol error.

Despite not carrying the potato, `Message` is not valid in every lifecycle
state:

- before E it is invalid at every handshake step and wallet-wait boundary;
- after E it may be retained only as an activation-lag message and delivered
  after handshake completion;
- it is valid during ordinary off-chain play, regardless of potato ownership;
- it is invalid while awaiting `CleanShutdownComplete`; and
- the host does not deliver it to the protocol engine after leaving off-chain
  peer operation.

## 13. Cooperative shutdown

### 13.1 Initiation

The potato holder initiates shutdown by sending the dedicated struct variant:

```text
CleanShutdown {
  channel_half_sig: Aggsig,
  payout_conditions: ProgramRef
}
```

Clean shutdown is never embedded in `Batch`. If local actions precede the
queued shutdown request, the sender first flushes those actions in an ordinary,
fully signed Batch, requests the potato back, and attempts `CleanShutdown` only
after regaining it. The receiver:

1. requires there to be no active games;
2. cancels all unaccepted proposals;
3. computes the expected direct channel payout conditions;
4. compares the received and expected condition multisets;
5. verifies the initiator's channel half-signature over those conditions; and
6. combines it with its own signature to form a complete channel `CoinSpend`.

The direct `channel_half_sig` authorizes this payout spend; ordinary
channel/unroll state-update signatures belong only to `Batch`.

### 13.2 Completion

For a normal non-zero payout, the responder sends:

```text
CleanShutdownComplete(CoinSpend)
```

This is a separate reliable `PeerMessage`, not another batch. It carries the
complete mutually signed direct channel spend.

After initiating shutdown, the initiator accepts only:

- `CleanShutdownComplete`; or
- `RequestPotato`, which it ignores.

Any other `PeerMessage` is a protocol error.

For the special zero-local-payout path, the host durably hands the completed
message to the peer and waits for its reliable acknowledgement before retiring
the local session.

Further transaction publication and chain resolution are outside this
specification.

## 14. Lifecycle, trust, and roles

### 14.1 Trust and fixed roles

Neither the peer nor the relaying hub is trusted. Every received frame and
field is untrusted input.

The handshake has two fixed roles:

- **Initiator** sends handshake messages A, C, and E and initially holds the
  potato.
- **Receiver** sends handshake messages B, D, and F and initially does not hold
  the potato.

These roles remain fixed for the lifetime of the channel. They are also called
the first and second player in internal state.

The peer ID supplied by the hub is a routing selector, not a cryptographic
identity. Cryptographic authority comes from the public keys and signatures
exchanged and verified during this protocol.

### 14.2 Lifecycle summary

```text
Pre-session negotiation
    |
    v
Handshake A-F
    |
    | local channel-activation observation
    v
Off-chain potato protocol
    |
    +-- Batch / RequestPotato / Message
    |
    +-- cooperative shutdown
    |      |
    |      +-- CleanShutdownComplete
    |
    +-- peer error or local escalation
           |
           v
       peer protocol stops
```

Reliable transport acknowledgements may still be emitted for already received
frames while protocol processing is stopping, so the remote side can retire
its durable outbound log. Such acknowledgement does not re-enter the semantic
protocol.

## 15. Reference implementation

- Peer and batch wire types:
  `src/session_phases/types.rs`
- Handshake payload types:
  `src/session_phases/handshake.rs`
- Handshake state machines:
  `src/session_phases/handshake_initiator.rs`,
  `src/session_phases/handshake_receiver.rs`
- Potato and batch semantics:
  `src/session_phases/mod.rs`
- Channel-state verification:
  `src/channel_state/mod.rs`
- Bencodex codec:
  `bencodex/src/ser.rs`, `bencodex/src/de.rs`
- JavaScript Bencodex codec:
  `shared/bencodex/index.js`
- Reliable peer framing:
  `front-end/src/services/PeerSession.ts`
- Ordering, persistence, acknowledgement, and replay:
  `front-end/src/hooks/SessionController.ts`
- Peer transport tests:
  `front-end/src/lib/tests/message_protocol.transport.test.ts`,
  `front-end/src/lib/tests/message_protocol.durability.test.ts`
