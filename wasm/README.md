Wasm bindings for the chia-gaming frontend.

This crate packages the Rust state-channel implementation for browser and
Node.js tests via wasm-pack.

`create_peer_protocol` constructs the Rust reliable-delivery owner used by the
browser's `ReliablePeerTransport` adapter. Its methods handle numbering, ACKs,
ordering, checkpoint generations, send results, and hub/peer connectivity.
`accept_session` begins local session setup and constructs the initiator's
proposal. `wallet_address_requested` exposes the pending host request;
`provide_wallet_address` consumes the result and creates the channel engine in
the accepted session. `restore_setup` resumes an accepted pre-handshake save
without generating another proposal; `restore_channel` attaches the live phase
after the existing channel snapshot is restored.

TypeScript executes wallet calls and IndexedDB writes, reports connectivity,
and supplies carrier/application callbacks through `PeerHost`. Rust invokes the
callbacks and consumes their results while it drives delivery, ACKs, failed-send
retention and replay. The API has no queue iterators, queue mutation methods,
per-message delivery confirmations or writable counters. Snapshot/restore is
the persistence boundary; the checkpoint token is opaque to TypeScript. Host
callbacks are supplied for each call, so Rust does not retain JavaScript
closures that would keep the adapter alive across garbage collection. The existing channel bindings remain the API for gameplay
and on-chain work. See [frontend architecture](../FRONTEND_ARCHITECTURE.md) and
[peer protocol](../PEER_PROTOCOL.md) for lifetime and ordering contracts.
