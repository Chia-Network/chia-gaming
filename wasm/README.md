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

TypeScript executes wallet calls, socket sends, and IndexedDB writes. It supplies
checkpoint completion and carrier results to Rust; Rust does not access those
services directly. The existing channel bindings remain the API for gameplay
and on-chain work. See [frontend architecture](../FRONTEND_ARCHITECTURE.md) and
[peer protocol](../PEER_PROTOCOL.md) for lifetime and ordering contracts.
