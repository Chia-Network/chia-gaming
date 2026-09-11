# chia-gaming

This project enables two-player games for real money over Chia state channels, with no trusted intermediary. Play can usually be done in real time. Players fund a shared channel coin on the Chia blockchain, then play games entirely off-chain by exchanging signed
messages (the "potato protocol"). The blockchain is only touched for opening,
closing, or resolving disputes.

The reference games are **California Poker** (commit-reveal), **Space Poker**
(Texas Hold'em-style), and **Krunk** (Wordle-style paired games). See
**[GAME_WRITING_GUIDE.md](GAME_WRITING_GUIDE.md)** to add a game.

For production builds, tarballs, and step-by-step build instructions, see
**[DEVELOPMENT.md](DEVELOPMENT.md)**.


## Documentation

- **[OVERVIEW.md](OVERVIEW.md)** — How state channels, the referee, and the
  potato protocol work. Links to detailed docs.
- **[GAME_WRITING_GUIDE.md](GAME_WRITING_GUIDE.md)** — How to write a game: package
  layout, registry, host and CLVM APIs.
- **[DEVELOPMENT.md](DEVELOPMENT.md)** — Build, debug, and run the player app and
  hub locally or in production.
- **[FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md)** — Player app and
  hub: React components, WASM bridge, WebSocket relay protocol.


## Project Structure

```
src/
  channel_state/    — State channel management and the potato protocol
  referee/          — Referee coin logic (on-chain move validation, slashing)
  session_phases/   — High-level game orchestration and on-chain actions
  peer_container.rs — Peer-to-peer game cradle (synchronous wrapper)
  simulator/        — Chia blockchain simulator and integration tests
  test_support/     — Shared test utilities
  common/           — Shared types, CLVM utilities, standard coin logic
  shutdown.rs       — Clean shutdown conditions

games/              — Game packages (`<key>/{clsp,ui}` with optional `rust/`) and `host/`
  registry.json     — Only catalog (`production` vs `test`)
clsp/
  referee/onchain/  — Referee puzzle (on-chain arbitration)
  unroll/           — Unroll puzzle (state channel dispute resolution)
  handler_api.md    — CLVM handler calling conventions
  test/             — Chialisp test programs

wasm/               — WebAssembly bindings for browser use
front-end/          — Player frontend (React + WASM bridge)
hub/                — Hub service + hub UX frontend
```
