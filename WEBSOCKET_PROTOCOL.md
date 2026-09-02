# Game Relay WebSocket Protocol

## 1. Scope

This document specifies the game relay WebSocket protocol between the player
application and a hub. It covers:

- the `/ws/game` connection lifecycle;
- hub control messages carried on that connection;
- addressed binary relay frames;
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

## 3. Bencodex control grammar

Hub control frames use the following Bencodex encodings:

```text
False         f
True          t
UTF-8 text    u<decimal byte length>:<UTF-8 bytes>
Dictionary    d<key><value>...e
```

Control dictionaries use text keys sorted by unsigned bytewise lexical order of
their UTF-8 encodings and have a required text field named `type`. Text lengths
count UTF-8 bytes. A decoder rejects trailing bytes after the top-level
dictionary.

The complete peer-wire Bencodex grammar is specified in
[`PEER_PROTOCOL.md`](PEER_PROTOCOL.md#3-bencodex-wire-encoding).

Unknown control message types and malformed control dictionaries are ignored.
Fields not defined for a known message have no protocol meaning and should be
ignored.

## 4. Frame-class multiplexing

The connection multiplexes two frame classes:

1. **Hub control frames** are Bencodex dictionaries. A dictionary begins with
   byte `0x64` (`d`).
2. **Addressed relay frames** begin with a four-byte big-endian identifier
   length.

The receiver distinguishes them using the first byte:

```text
first byte == 0x64   Bencodex hub control frame
first byte != 0x64   addressed relay frame
```

Current player IDs are exactly 34 UTF-8 bytes, so an addressed client frame
begins `00 00 00 22`. Implementations must address assigned player IDs rather
than arbitrary identifiers. This keeps the first-byte multiplexing rule
unambiguous.

## 5. Addressed relay byte layouts

### 5.1 Player to hub

```text
+----------------------+--------------------+------------------+
| target_len: u32 BE   | target_id: UTF-8   | payload: bytes   |
+----------------------+--------------------+------------------+
```

`target_len` is the number of bytes, not characters, in `target_id`.

The hub derives the sender identity from the identified WebSocket connection;
there is no sender field in this frame. A frame from an unidentified connection
is discarded.

### 5.2 Hub to player

```text
+----------------------+--------------------+
| sender_len: u32 BE   | sender_id: UTF-8   |
+----------------------+--------------------+
| alias_len: u32 BE    | sender_alias: UTF-8|
+----------------------+--------------------+
| payload: bytes                            |
+-------------------------------------------+
```

Both lengths count UTF-8 bytes. The hub constructs `sender_id` from its
connection metadata and chooses `sender_alias` as untrusted presentation
metadata. Its internal alias-selection policy is out of scope.

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
  "session_id": Text,
  "busy":       Bool,       // optional in the decoder; always sent by the current client
  "alias":      Text        // optional
}
```

`session_id` is required. `busy` reports whether the player application is
currently unavailable for matchmaking. `alias` is presentation metadata.

The hub assigns or recovers the player ID, binds this connection, retains the
reported presentation metadata, and replies with `registered`. Any use of that
metadata by the hub HTML is out of scope.

### 6.2 `set_busy`

Updates player-reported matchmaking availability.

```text
{
  "type":  Text("set_busy"),
  "busy":  Bool,
  "alias": Text        // optional
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
  "player_id": Text
}
```

`player_id` is the player's public routing identifier for this hub process.

### 7.2 `advisory_start`

Suggests that the player application initiate a peer session.

```text
{
  "type":            Text("advisory_start"),
  "peer_id":         Text,
  "peer_alias":      Text,
  "my_amount":       Text,
  "their_amount":    Text,
  "channel_timeout": Text,  // optional
  "unroll_timeout":  Text   // optional
}
```

Amounts are positive canonical decimal integer strings. Here canonical means
ASCII digits only, no sign, and no leading zero. Timeouts, when present, use the
same canonical form and are block counts in the current accepted range 3
through 30.

This message is advisory and untrusted. It does not start the peer protocol.
The player validates it, checks local availability, and asks for local consent.
If unavailable, the player ignores it.

Hub policy determines when this advisory is emitted. Amount names are from the
recipient's perspective.

### 7.3 `delivery_failure`

Reports that the target of an addressed frame was not deliverable when the hub
attempted delivery. This includes both an unknown player ID and a known player
without an open game connection.

```text
{
  "type": Text("delivery_failure"),
  "to":   Text
}
```

This report is not an acknowledgement of any other frame and is not
cryptographically trustworthy. It does not imply that previous frames were or
were not delivered.

### 7.4 `hub_attention`

Requests that the player draw attention to the hub UI.

```text
{
  "type": Text("hub_attention")
}
```

It has no peer-protocol semantics.

### 7.5 `closed`

Acknowledges the application-level `close` request.

```text
{
  "type": Text("closed")
}
```

### 7.6 `keepalive`

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
reuses it across reconnects and hub selections.

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
peer messages. The hub itself stores no messages and performs no replay.

## 9. Hub delivery behavior

For each valid addressed frame, the hub:

1. resolves `target_id` to a hub session ID;
2. finds that session's current `/ws/game` connection;
3. prepends the sender ID and alias; and
4. performs one WebSocket send to the target.

If no open target connection exists, it sends `delivery_failure` to the sender.

If an addressed frame is shorter than its declared header lengths, the
receiver logs and drops it. It does not send `delivery_failure` or close the
connection solely for that malformed frame.

The hub provides no:

- storage or offline queue;
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
  encode it as `p_` followed by 32 lowercase hexadecimal characters.
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
