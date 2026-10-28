Wasm bindings for the chia-gaming frontend.

This crate packages the Rust state-channel implementation for browser and
Node.js tests via wasm-pack.

`create_peer_protocol` constructs the Rust peer-session owner used by the
browser's `ReliablePeerTransport` adapter. Rust handles numbering, ACKs,
ordering, replay, proposal/rejection policy, and terminal-message tracking.
`peer_session::session::Session` directly contains reliability state and the
optional channel, including its allocator, RNG and transaction manager.
Incoming channel messages, outgoing message allocation, and terminal
acknowledgements use native Rust calls and results. There is no internal
JavaScript conversion, host-notification routing or channel back-reference.
Retiring or freeing that owner releases its channel; replacing a hub carrier
transfers the same owner without creating another channel.
`accept_session` starts local acceptance and constructs the initiator's proposal.
`open_channel` resumes the accepted setup, calls the supplied address provider,
awaits its result, and creates the channel. Retiring setup cancels construction
even when its address request is still in flight. TypeScript's WalletConnect
adapter continues to own RPC normalization, retries and connection recovery.

The host has three capabilities: send a frame, report consumer availability, and
handle notifications. Rust owns delivery eligibility, rejection
recognition, and terminal-frame reconciliation, send/ACK bookkeeping and retry
eligibility. Rust completes the channel directly on terminal acknowledgement;
a failed completion retains the acknowledged binding for retry. Channel output
notifies TypeScript only of presentation and wallet work, never peer messages.
TypeScript supplies application effects and IndexedDB writes, and reports
connection events and checkpoint outcomes. Snapshot/restore carries saved data;
the checkpoint token is opaque. The API has no queue accessors, per-message
policy callbacks or sent/ACK confirmation sequence.

Synchronous host callbacks run without a Rust session borrow. They are passed
per call; the address-provider callback is retained only for its asynchronous
request. Existing gameplay and on-chain handles resolve to the same session
owner at the WASM boundary; standalone engine bindings remain available for
callers that do not use peer reliability. See [frontend architecture](../FRONTEND_ARCHITECTURE.md) and
[peer protocol](../PEER_PROTOCOL.md) for lifetime and ordering contracts.
