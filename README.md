# chia-gaming

Two-player games over Chia state channels. Players fund a shared channel coin on
the Chia blockchain, then play games entirely off-chain by exchanging signed
messages (the "potato protocol"). The blockchain is only touched for opening,
closing, or resolving disputes.

The reference game implementation is **Calpoker** — a poker variant using
commit-reveal randomness.

## Documentation

- **[OVERVIEW.md](OVERVIEW.md)** — How state channels, the referee, the
  potato protocol, and Calpoker work. Links to detailed docs.
- **[DEBUGGING_GUIDE.md](DEBUGGING_GUIDE.md)** — How to build, run tests, read
  output, and debug failures.
- **[FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md)** — Player app and
  tracker: React components, WASM bridge, WebSocket relay protocol.
## Quick Start

```bash
# Build test binaries (no test execution)
./cb.sh

# Run full default test flow:
# - rust + chialisp build
# - rust sim tests
# - JS/WASM integration tests
./ct.sh

# Run only matching sim test(s) while debugging
./ct.sh -o accept_finished

# Start full suite from first matching test name (wraparound)
./ct.sh accept_finished

# Run JS/WASM integration tests (builds WASM, starts simulator, runs Jest)
./tools/local-wasm-tests.sh
```

### Prerequisites

- **Rust** (nightly) with `wasm32-unknown-unknown` target (`rustup target add wasm32-unknown-unknown`)
- **Node.js** and **pnpm** — for JS/WASM integration tests
- **wasm-pack** — for building the WASM package (`cargo install wasm-pack`)
- **LLVM** (Homebrew) — on macOS, needed for compiling `blst` to wasm (`brew install llvm`)

### JS Package Manager Policy

Use **pnpm** for repository JS package workflows and lockfiles. Avoid mixing package
managers inside a given package directory.

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
front-end/          — Player frontend (React + WASM bridge)
lobby/              — Lobby frontend, tracker service, and nginx/deploy helpers
wc-stub/            — WalletConnect stub service
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
| `GameAction` | Enum of test actions (Move, Accept, Shutdown, Cheat, etc.) |
| `Spend` | Spend bundle for an on-chain referee action |
| `SynchronousGameCradle` | High-level game wrapper used in tests |
