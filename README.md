# chia-gaming

This project enables two-player games for real money over Chia state channels, with no trusted intermediary. Play can usually be done in real time. Players fund a shared channel coin on the Chia blockchain, then play games entirely off-chain by exchanging signed
messages (the "potato protocol"). The blockchain is only touched for opening,
closing, or resolving disputes.

The reference games are **California Poker** — a poker variant using commit-reveal randomness, and **Space Poker**, a Texas Hold'em variant.

For production builds, tarballs, and step-by-step build instructions, see
**[DEVELOPMENT.md](DEVELOPMENT.md)**.


## Documentation

- **[OVERVIEW.md](OVERVIEW.md)** — How state channels, the referee, the
  potato protocol, and Calpoker work. Links to detailed docs.
- **[DEVELOPMENT.md](DEVELOPMENT.md)** — Build, debug, and run the player app and lobby
  tracker locally or in production.
- **[FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md)** — Player app and
  tracker: React components, WASM bridge, WebSocket relay protocol.


## Project Structure

```
src/
  channel_handler/  — State channel management and the potato protocol
  referee/          — Referee coin logic (on-chain move validation, slashing)
  potato_handler/   — High-level game orchestration and on-chain actions
  games/            — Game registration (calpoker, spacepoker, test-only debug game)
  peer_container.rs — Peer-to-peer game cradle (synchronous wrapper)
  simulator/        — Chia blockchain simulator and integration tests
  test_support/     — Shared test utilities
  common/           — Shared types, CLVM utilities, standard coin logic
  shutdown.rs       — Clean shutdown conditions

clsp/
  games/calpoker/   — Calpoker chialisp (handlers, validators, handcalc)
  games/spacepoker/ — Space Poker chialisp (handlers, validators, hand eval)
  referee/onchain/  — Referee puzzle (on-chain arbitration)
  unroll/           — Unroll puzzle (state channel dispute resolution)
  test/             — Chialisp test programs

wasm/               — WebAssembly bindings for browser use
front-end/          — Player frontend (React + WASM bridge)
lobby/              — Lobby frontend and tracker service
```
