# chia-gaming

Two-player games over Chia state channels. Players fund a shared channel coin on
the Chia blockchain, then play games entirely off-chain by exchanging signed
messages (the "potato protocol"). The blockchain is only touched for opening,
closing, or resolving disputes.

The reference game implementation is **Calpoker** — a poker variant using
commit-reveal randomness.

## Documentation

- **[ARCHITECTURE.md](ARCHITECTURE.md)** — How state channels, the referee, the
  potato protocol, and Calpoker work.
- **[DEBUGGING_GUIDE.md](DEBUGGING_GUIDE.md)** — How to build, run tests, read
  output, and debug failures.
## Quick Start

```bash
# Build
cargo build

# Run unit tests
cargo test

# Run chialisp + python tests
./run-clsp-tests.sh

# Run simulation tests (requires Docker)
./docker-sim-tests.sh

# Run everything
./run-all-tests.sh
```

### Prerequisites

- **Rust** (nightly)
- **Docker** with BuildKit — for simulation and integration tests
- **Python 3.11–3.13** and **uv** — for chialisp/python tests

## Project Structure

```
src/
  channel_handler/  — State channel management and the potato protocol
  referee/          — Referee coin logic (on-chain move validation, slashing)
  potato_handler/   — High-level game orchestration and on-chain actions
  games/            — Game implementations (calpoker, debug game)
  peer_container/   — Peer-to-peer game cradle (synchronous wrapper)
  simulator/        — Chia blockchain simulator and integration tests
  test_support/     — Shared test utilities
  common/           — Shared types, CLVM utilities, standard coin logic
  shutdown/         — Clean shutdown conditions

clsp/
  games/calpoker/   — Calpoker chialisp (handlers, validators, handcalc)
  referee/onchain/  — Referee puzzle (on-chain arbitration)
  unroll/           — Unroll puzzle (state channel dispute resolution)
  test/             — Chialisp test programs

wasm/               — WebAssembly bindings for browser use
python/             — Python test harness for chialisp validation
resources/          — Frontend (gaming-fe), lobby, and test infrastructure
```

## Key Concepts

**State channel**: A shared coin on-chain controlled by two players. All game
activity happens off-chain; the chain is only used for setup and disputes.

**Potato protocol**: Players take turns holding a "potato" (signing authority).
Each potato pass includes updated signatures for the current channel state, so
either player can unilaterally close the channel to the latest agreed state.

**Referee**: A chialisp puzzle that validates game moves on-chain. Each game has
a chain of validator programs (a, b, c, d, e for calpoker) that verify moves and
compute state transitions. The referee supports two actions: advancing the game
(move) and penalizing cheaters (slash).

**Calpoker**: A poker game using commit-reveal for shared randomness. Alice
commits a hash, Bob reveals his seed, Alice reveals hers, then both discard and
select cards. The five on-chain validator steps (a–e) enforce this protocol.

## Key Types

| Type | Purpose |
|------|---------|
| `CoinString` | Structured coin representation (parent, puzzle hash, amount) |
| `ChannelHandlerEnv` | Environment for channel handler operations |
| `GameHandler` | My-turn or their-turn game logic (chialisp programs) |
| `GameStartInfo` | Initial game parameters (state, handler, validator, timeout) |
| `Referee` | Manages referee coin state and on-chain transactions |
| `GameFactory` | Holds proposal and parser programs for a game type |
| `GameAction` | Enum of test actions (Move, Accept, Shutdown, RedoMove, etc.) |
| `RefereeOnChainTransaction` | Spend bundle for an on-chain referee action |
| `SynchronousGameCradle` | High-level game wrapper used in tests |
