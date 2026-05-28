# Deploying

This guide covers building and running the two deployable artifacts:

1. **Player app** — fully static HTML/JS/CSS/WASM served from any web server.
2. **Tracker** — Express + WebSocket service that provides the lobby UI (iframe)
  and relays game messages between peers.

For architecture details, see `[FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md)`.
For the Rust test suite, see `[DEBUGGING_GUIDE.md](DEBUGGING_GUIDE.md)`.

## Prerequisites

- **Rust** (stable) with the `wasm32-unknown-unknown` target:
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- **wasm-pack** (0.13.1):
  ```bash
  cargo install wasm-pack --version 0.13.1
  ```
- **Node 20+** and **pnpm 10.33**:
  ```bash
  brew install node@20        # or download from https://nodejs.org
  npm install -g pnpm@10.33.0
  ```
- **macOS only** — Homebrew LLVM for WASM builds. If present, build scripts
automatically set `CC_wasm32_unknown_unknown` and `AR_wasm32_unknown_unknown`
to the Homebrew LLVM paths. Install with `brew install llvm` if WASM builds
fail with clang errors.

## Quick Start (Local Demo)

`run-local-demo.sh` builds everything and starts three services:

```bash
./run-local-demo.sh
```


| Service    | Default URL             | Override env var |
| ---------- | ----------------------- | ---------------- |
| Player app | `http://localhost:3002` | `GAME_PORT`      |
| Tracker    | `http://localhost:3003` | `TRACKER_PORT`   |
| Simulator  | `http://localhost:5800` | (hardcoded)      |


Flags:

- `--skip-build` — skip all build steps, use existing artifacts.
- `--force-build` — `cargo clean` before building.

Press Ctrl-C to stop all services.

## Building Tarballs

`tools/build-deploy.sh` runs all build steps below and packages the results:

```bash
./tools/build-deploy.sh
```

This produces four files in subdirectories (tgz and zip of each artifact):

- `deploy_player_app/chia-gaming-YYYYMMDD-HASH.tgz` / `.zip` — player app
- `deploy_tracker/chia-gaming-lobby-YYYYMMDD-HASH.tgz` / `.zip` — lobby frontend + service

Both formats have identical contents, ready to extract onto their respective
servers.

## Building Step by Steppr

For CI, production, or partial rebuilds. Run commands from the repo root
unless noted. The CI workflow
`[.github/workflows/frontend.yml](.github/workflows/frontend.yml)` is the
canonical reference for the full build sequence.

### 1. Chialisp (.hex files)

```bash
find clsp -name '*.hex' -delete
cp build.rs.disabled build.rs
cargo build
```

This compiles `.clsp` sources to `.hex` via the Rust build script. The hex
files are loaded by the WASM module at runtime over HTTP.

### 2. WASM (browser target)

```bash
(cd wasm && wasm-pack build --out-dir=../front-end/dist --release --target=web)
```

For development, substitute `--dev` for `--release` (faster builds, larger
output). The `rebuild-wasm.sh` script does this with the macOS workaround
applied.

### 3. Player app (frontend JS/CSS)

```bash
(cd front-end && pnpm install --frozen-lockfile && pnpm run build)
```

Outputs `dist/js/index-rollup.js` and `dist/css/index.css`.

### 4. Lobby frontend

```bash
(cd lobby && pnpm install --frozen-lockfile)
(cd lobby && pnpm --filter chia-gaming-lobby-frontend run build)
```

Outputs `lobby/lobby-frontend/public/index.js` and
`lobby/lobby-frontend/dist/css/index.css`.

### 5. Lobby service

```bash
(cd lobby && pnpm --filter chia-gaming-lobby-service run build)
```

Outputs `lobby/lobby-service/dist/index-rollup.cjs`.

### 6. Simulator (development only)

```bash
cargo build --features sim-server --bin chia-gaming-sim
```

Binary at `target/debug/chia-gaming-sim`. Listens on port 5800 (HTTP) and
5801 (WebSocket), both hardcoded.

## Staging (Asset Layout)

Both apps use a nonce-based directory layout for cache-busting. The nonce is
a millisecond timestamp. `run-local-demo.sh` assembles these as symlink
trees; for production, copy the files instead.

### Player app

```
index.html              ← front-end/public/index.html
local-static-test-server.js ← local-static-test-server.js
build-meta.json         ← {"basePath":"/app/NONCE/"}
favicon.svg             ← front-end/public/favicon.svg (if present)
app/
  NONCE/
    index.js            ← front-end/dist/js/index-rollup.js
    index.css           ← front-end/dist/css/index.css
    chia_gaming_wasm.js ← front-end/dist/chia_gaming_wasm.js
    chia_gaming_wasm_bg.wasm ← front-end/dist/chia_gaming_wasm_bg.wasm
    clsp/               ← clsp/ directory (compiled .hex files)
    images/             ← front-end/public/images/ (if present)
```

### Lobby

```
index.html              ← lobby/lobby-frontend/public/index.html
build-meta.json         ← {"basePath":"/app/NONCE/"}
service.js              ← lobby/lobby-service/dist/index-rollup.cjs
app/
  NONCE/
    index.js            ← lobby/lobby-frontend/public/index.js
    index.css           ← lobby/lobby-frontend/dist/css/index.css
```

## Running the Services

### Player app

Any static file server. No server-side logic required.
For example:

```bash
python3 -m http.server 3002
```

**Development (from repo checkout):**

```bash
node local-static-test-server.js front-end/serve 3002
```

**Development (from extracted tarball):**

```bash
node local-static-test-server.js . 3002
```

**Production:** Serve the staging directory with nginx, Caddy,
S3 + CloudFront, or any static host. Apply the caching rules in
[Production Notes](#production-notes).

### Tracker (lobby service)

From an extracted lobby tarball:

```bash
PORT=3003 node service.js \
  --self 'http://localhost:3003' \
  --dir .
```

Or from the repo checkout:

```bash
PORT=3003 node lobby/lobby-service/dist/index-rollup.cjs \
  --self 'http://localhost:3003' \
  --dir lobby/lobby-frontend/serve
```


| Flag / env  | Required | Purpose                                                                                        |
| ----------- | -------- | ---------------------------------------------------------------------------------------------- |
| `--self`    | yes      | Public HTTP origin of this tracker (used for WebSocket URL derivation)                         |
| `--dir`     | yes      | Root directory to serve static lobby files from                                                |
| `--verbose` | no       | Verbose logging                                                                                |
| `PORT`      | no       | Listen port (default `5801` — conflicts with the simulator; always override when running both) |


### Simulator (development only, from repo checkout)

```bash
./target/debug/chia-gaming-sim
```

Ports 5800 (HTTP) and 5801 (WebSocket) are hardcoded. The simulator binary
is built by `cargo build --features sim-server` and is not included in the
tarballs. Not used in production; players connect to a real Chia wallet via
WalletConnect.

## Production Notes

- **Separate origins.** The player app and tracker must be served from
different origins. The lobby loads inside an iframe from the tracker's
origin; same-origin would break the security boundary.
- **Asset co-location.** WASM files and `.hex` chialisp files must be
under the same `basePath` as `index.js`. The WASM module fetches `.hex`
files via relative HTTP paths at runtime.
- `**--self` must match the public URL.** The tracker uses it to derive
WebSocket URLs. Mismatches cause connection failures.
- **Caching rules.** Configure your production web server (nginx, Caddy,
CloudFront, etc.) with these headers. The dev servers
(`local-static-test-server.js` and the tracker service) already apply
them automatically.
  - `index.html` and `build-meta.json`: `**Cache-Control: no-store`** (must
  always be fresh so the app picks up new nonces).
  - Everything under `/app/`: `**Cache-Control: public, max-age=31536000, immutable**`
  (content-addressed by nonce, never changes).
- **No simulator.** In production there is no simulator. Players connect
their Chia wallet via WalletConnect and play against real XCH.
- **CI artifacts.** The
[frontend workflow](.github/workflows/frontend.yml) produces two
downloadable artifacts on each build:
  - `chia-gaming-frontend` — player app files (`dist/`, `public/`, `clsp/`)
  - `chia-gaming-lobby` — lobby frontend files (`public/`, `dist/css/`) and
  the tracker service (`service.js`, a copy of `index-rollup.cjs`)

## Troubleshooting

### `ERR_PNPM_IGNORED_BUILDS`

During `pnpm install` you may see:

```
[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: @parcel/watcher@2.5.6, esbuild@0.25.11

Run "pnpm approve-builds" to pick which dependencies should be allowed to run scripts.
```

This is harmless. pnpm 10+ requires explicit approval for dependency
install scripts. The affected packages (`@parcel/watcher`, `esbuild`) ship
pre-built native binaries as fallbacks, so the builds complete and the
tarballs are correct without running those scripts. You can silence the
warning by running `pnpm approve-builds` once in the relevant directory
(`front-end/` or `lobby/`) and committing the updated
`.pnpm-approve-builds` file.