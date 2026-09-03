# Game Relay WebSocket Protocol

## 1. Scope

This document specifies the game relay WebSocket protocol between the player
application and a hub. It covers:

- the `/ws/game` connection lifecycle;
- hub control messages carried on that connection;
- addressed relay messages;
- hub routing and delivery behavior; and
- connection liveness and resource limits.

The payload relayed between players is specified separately in
[`PEER_PROTOCOL.md`](PEER_PROTOCOL.md).

The hub HTML's internal protocol is out of scope. Its only direct interface with
the player application is the URL used to open it; this specification neither
defines nor depends on how the page communicates with its own hub service.

Blockchain, wallet, and chain-observation protocols are also out of scope.

## 2. WebSocket carrier

### 2.1 Endpoint and message type

Given a selected hub HTTP URL, the player application:

1. changes `http:` to `ws:` or `https:` to `wss:`;
2. replaces the path with `/ws/game`; and
3. removes the query string and fragment.

All application frames on `/ws/game` are WebSocket binary messages. Text
messages are invalid and are ignored.

## 3. Bencodex byte grammar

Every application message is one canonical Bencodex value. The grammar is:

```text
Null          n
False         f
True          t
Integer       i<canonical signed decimal>e
Bytes         <decimal byte length>:<raw bytes>
UTF-8 text    u<decimal byte length>:<UTF-8 bytes>
List          l<value>...e
Dictionary    d<key><value>...e
```

Bencodex integers are arbitrary precision. Zero is `i0e`; negative zero,
leading zeroes, an omitted digit, and a leading plus sign are invalid. Bytes
and text use canonical unsigned decimal lengths with no leading zero except
the single digit `0`. Text lengths count UTF-8 bytes.

Dictionary keys may be bytes or text. Byte keys sort before text keys; keys of
the same kind sort by unsigned bytewise lexical order of their unprefixed
contents. This protocol uses text keys. A decoder rejects invalid value
encodings and trailing bytes after the top-level value.

## 4. Common message envelope

Every `/ws/game` WebSocket message is a Bencodex dictionary with a required
text field named `type`. That field is the sole top-level message
discriminator. There is no alternate relay framing and no first-byte
multiplexer.

Fields not defined for a known type have no protocol meaning and are ignored.
Unknown types and malformed dictionaries are ignored.

The following named wire types are used below:

- `PlayerID`: exactly 16 opaque bytes;
- `SessionID`: exactly 16 secret bytes;
- `Alias`: non-empty UTF-8 text of at most 128 bytes.

## 5. Addressed relay messages

### 5.1 Player to hub

```text
{
  "type":    Text("relay"),
  "to":      PlayerID,
  "payload": Bytes
}
```

The hub derives the sender identity from the identified WebSocket connection;
there is no sender field in this frame. A frame from an unidentified connection
is discarded.

### 5.2 Hub to player

```text
{
  "type":    Text("relay"),
  "from":    PlayerID,
  "alias":   Alias,
  "payload": Bytes
}
```

The hub constructs `from` from its connection metadata and obtains `alias`
from its internal hub interface. The player cannot supply either field on the
game connection.

The player protocol treats both values as untrusted routing and presentation
metadata. The hub does not enforce pair membership. Once a peer session is
selected, the receiving player—not the hub—ignores frames whose `sender_id`
differs from that session's peer ID.

## 6. Player-to-hub control message dictionaries

### 6.1 `identify`

Sent once whenever a game WebSocket opens.

```text
{
  "type":       Text("identify"),
  "session_id": SessionID,
  "busy":       Bool       // optional in the decoder; always sent by the current client
}
```

`session_id` is required. `busy` reports whether the player application is
currently unavailable for matchmaking.

The hub assigns or recovers the player ID, binds this connection, and replies
with `registered`. Alias ownership remains on the hub's internal interface.

### 6.2 `set_busy`

Updates player-reported matchmaking availability.

```text
{
  "type": Text("set_busy"),
  "busy": Bool
}
```

The connection must previously have sent `identify`; otherwise the hub ignores
this message. The operation applies to the session already bound to the
WebSocket by `identify`.

The player application is authoritative for this availability bit. How the hub
uses it internally is out of scope.

### 6.3 `close`

Requests application-level closure.

```text
{
  "type": Text("close")
}
```

If the connection has been identified, the hub responds with `closed`. The hub
uses the connection's identified session. This is distinct from a WebSocket
close frame. Current player applications normally end the connection directly
and do not use this message.

### 6.4 `keepalive`

Sent every 15 seconds while the WebSocket is open.

```text
{
  "type": Text("keepalive")
}
```

No response is required. Arrival updates the hub's connection activity time.

## 7. Hub-to-player control message dictionaries

### 7.1 `registered`

Confirms registration or re-registration.

```text
{
  "type":      Text("registered"),
  "player_id": PlayerID
}
```

`player_id` is the player's public routing identifier for this hub process.

### 7.2 `advisory_start`

Suggests that the player application initiate a peer session.

```text
{
  "type":            Text("advisory_start"),
  "peer_id":         PlayerID,
  "peer_alias":      Alias,
  "my_amount":       Integer,
  "their_amount":    Integer,
  "channel_timeout": Integer,  // optional
  "unroll_timeout":  Integer   // optional
}
```

Amounts are positive integers. Timeouts, when present, are block counts in the
current accepted range 3 through 30.

This message is advisory and untrusted. It does not start the peer protocol.
The player validates it, checks local availability, and asks for local consent.
If unavailable, the player ignores it.

Hub policy determines when this advisory is emitted. Amount names are from the
recipient's perspective.

### 7.3 `delivery_failure`

Reports that the target of a relay message was not deliverable when the hub
attempted delivery. This includes both an unknown player ID and a known player
without an open game connection.

```text
{
  "type": Text("delivery_failure"),
  "to":   PlayerID
}
```

This report is not an acknowledgement of any other frame and is not
cryptographically trustworthy. It does not imply that previous frames were or
were not delivered.

The failure is route-level, not message-level. The hub does not attach a relay
identifier, retain the payload, or track which numbered peer messages remain
unacknowledged.

### 7.4 `alias_updated`

Reports the player's current hub-owned display alias:

```text
{
  "type":  Text("alias_updated"),
  "alias": Alias
}
```

If the hub knows an alias at registration time, it sends this after
`registered`. It sends another whenever its internal interface changes the
alias. Registration and alias update are separate because either can change
without the other.

### 7.5 `peer_available`

Hints that a recent correspondent has re-established its game connection:

```text
{
  "type":      Text("peer_available"),
  "player_id": PlayerID
}
```

This is neither delivery confirmation nor peer authentication. A player uses
it only to trigger peer-owned retransmission for an already selected peer.

### 7.6 `hub_attention`

Requests that the player draw attention to the hub UI.

```text
{
  "type": Text("hub_attention")
}
```

It has no peer-protocol semantics.

### 7.7 `closed`

Acknowledges the application-level `close` request.

```text
{
  "type": Text("closed")
}
```

### 7.8 `keepalive`

Sent by the hub every 15 seconds:

```text
{
  "type": Text("keepalive")
}
```

It proves only that this WebSocket path recently carried a hub frame.

## 8. Connection and identity lifecycle

### 8.1 Hub session ID

A new player application generates 16 cryptographically random bytes and
encodes them as 32 lowercase hexadecimal characters. It persists this value and
reuses it across reconnects and hub selections. The URL and reference
implementation use that hexadecimal representation; `identify.session_id`
decodes it and sends the original 16 bytes.

The hub HTML is opened at
`<hub-origin>/?session=<hub-session-id>&uniqueId=<local-player-id>`. The same hub
session ID is independently supplied to the game relay connection. It is never
sent to a peer. The meaning and use of the URL inside the hub HTML are otherwise
out of scope.

The current hub retains the mapping from hub session ID to player ID only for
the lifetime of the hub process.

### 8.2 Registration

Immediately after opening `/ws/game`, the player sends `identify`. The hub
responds with `registered`. Other state-changing player control messages require
this identification to have completed; the hub ignores them on an unidentified
connection.

```text
Player                         Hub
  |---- identify ------------->|
  |<--- registered ------------|
```

The player must not assume that a previous player ID remains valid until it
receives the new `registered` message. If the hub already has a game connection
for the same hub session ID, it closes the old connection with WebSocket close
code `4001` and reason `replaced_by_new_connection`.

Registration does not pair two players. It only binds one WebSocket connection
to one hub session ID and public player ID.

### 8.3 Reconnection

The player reconnects automatically after an unexpected close. The current
client uses:

- delays of 5, 10, 20, 30, and then 60 seconds;
- random jitter from 0.75 to 1.25 times the selected delay;
- a 30-second connection-attempt timeout; and
- at most 18 reconnect attempts.

The attempt counter resets after a successful open. Every successful open is a
new registration and therefore sends a new `identify`.

After receiving `registered`, the peer protocol may retransmit unacknowledged
peer messages. It may also retransmit when a matching `peer_available` arrives.
The hub itself stores no messages and performs no replay.

The player persists its last registered player ID to detect a routing-epoch
change. If a later registration returns a different ID:

- a pre-channel attempt is cancelled and rematched;
- an established off-chain channel or cooperative shutdown enters safe
  on-chain resolution automatically;
- a submitted shutdown transaction or already-on-chain/resolved channel needs
  no additional escalation.

The player must not try to rebind an existing peer session to an
unauthenticated replacement routing ID.

## 9. Hub delivery behavior

For each valid player-to-hub `relay`, the hub:

1. resolves `to` to a hub session ID;
2. finds that session's current `/ws/game` connection;
3. constructs a hub-to-player `relay` with the bound sender ID and current
   hub-owned alias; and
4. performs one WebSocket send to the target.

If no open target connection exists, it sends route-level `delivery_failure`
to the sender.

Malformed relay dictionaries are logged and dropped. The hub does not send
`delivery_failure` or close the connection solely for malformed input.

### 9.1 Recent correspondents

For every relay attempt to a known target, the hub refreshes an undirected
relationship between the two stable hub sessions. It stores no payload or
message metadata. The current policy retains at most 16 correspondents per
session for 30 minutes since the latest relay attempt, evicting the oldest
relationship and pruning expired relationships.

When a session identifies, each currently connected recent correspondent gets
one `peer_available` naming the reconnected player ID. Unknown targets cannot
form a relationship. This state is advisory, local to one hub process, and may
be lost at any time.

The hub provides no:

- payload storage or offline queue;
- pairing enforcement;
- message acknowledgement;
- deduplication;
- replay;
- ordering guarantee across WebSocket reconnections; or
- interpretation of the payload.

All end-to-end reliability belongs to the peer protocol.

## 10. Liveness, closure, and resource policy

### 10.1 Liveness and closure

The player and hub each send a control `keepalive` every 15 seconds. The current
hub marks a connection expired after 60 seconds without an inbound frame. A
15-second periodic sweep performs the close, so closure occurs after more than
60 seconds and may occur up to approximately 75 seconds after the last inbound
frame. It uses close code `4002` and reason `idle_timeout`.

Other current close codes are:

- `4001`, `replaced_by_new_connection`;
- `4008`, `rate_limited`; and
- `1001`, `server_shutdown`.

Peer keepalives are different: they are opaque addressed payloads carried
through this protocol and are specified in
[`PEER_PROTOCOL.md`](PEER_PROTOCOL.md#5-reliable-delivery-semantics).

### 10.2 Resource limits

Current hub defaults use a ten-second accounting window:

- at most 1,000 game-channel messages per connection per window;
- at most 11 MiB of game-channel frame bytes per connection per window.

Deployments may override these values. Exceeding a per-connection rate budget
closes the connection with code `4008`. The hub may also enforce local
connection caps. Rejection at that stage uses HTTP status
`503 Service Unavailable`; no WebSocket connection is established. Limits
involving the hub HTML's internal connections are out of scope.

The rate budget is not an end-to-end peer message size declaration. The current
peer receive policy separately defaults to a 10 MiB authoritative peer-message
body limit.

## 11. Terminology and trust

- **Player application**: the browser or desktop application that owns a game
  session.
- **Hub**: a third-party service that assigns public player IDs and relays
  addressed payloads.
- **Hub session ID**: a secret bearer value generated by a player application.
  It is sent as `session_id` and identifies the same player application across
  hub reconnects.
- **Player ID**: a public routing identifier assigned by the hub. Current hubs
  send it as 16 opaque bytes. The reference hub represents the same bytes
  internally as `p_` followed by 32 lowercase hexadecimal characters.
- **Peer payload**: bytes addressed to another player ID. The hub does not
  interpret these bytes.

The hub is not trusted. A conforming player must treat hub-supplied identities,
aliases, advisories, delivery status, timing, and relayed bytes as untrusted
input. The hub session ID is a bearer credential for one hub; it is not a
shared secret between peers and is not a cryptographic peer identity.

## 12. Reference implementation

- Player connection and framing:
  `front-end/src/services/HubConnection.ts`
- Peer selection and callback wiring:
  `front-end/src/components/Shell.tsx`
- Hub endpoint and relay:
  `hub/hub-service/src/index.ts`
- Hub state:
  `hub/hub-service/src/hubState.ts`
- Transport tests:
  `front-end/src/lib/tests/hub_connection.test.ts`
- Hub behavior tests:
  `hub/hub-service/src/hub.behavior.test.mjs`
