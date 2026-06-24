# Running from Checkout

## Quick Start

Run the full local stack locally — player app, lobby tracker, and blockchain simulator:

```bash
./run-local-demo.sh
```

`run-local-demo.sh` builds everything and starts three services:

| Service    | Default URL             | Override env var |
| ---------- | ----------------------- | ---------------- |
| Player app | `http://localhost:3002` | `GAME_PORT`      |
| Tracker    | `http://localhost:3003` | `TRACKER_PORT`   |
| Simulator  | `http://localhost:5800` | (hardcoded)      |


`run-local-demo.sh` Flags:

- `--skip-build` — skip all build steps, use existing artifacts.
- `--force-build` — `cargo clean` before building.

Press Ctrl-C to stop all services.

You can use either the simulator, or mainnnet with the files hosted locally.

This will run the player app on localhost:3002 and the tracker on localhost:3003

There are two game modes: playing on a simulated blockchain, or on Chia's mainnet.
To play on mainnet, you must have the Chia Wallet 2.7.1 or later running and
configured, with at least 1000 mojos in your wallet.

## Prerequisites

- **Rust** (stable) with the `wasm32-unknown-unknown` target:
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- **wasm-pack** (0.15.0):
  ```bash
  cargo install wasm-pack --version 0.15.0
  ```
- **Node 20+** and **pnpm 10.33** and [Node Version Manager](https://nvmnode.com/):
  ```bash
  brew install node@20        # or download from https://nodejs.org
  npm install -g pnpm@10.33.0
  ```
- **macOS only** — Homebrew LLVM for WASM builds. If present, build scripts
automatically set `CC_wasm32_unknown_unknown` and `AR_wasm32_unknown_unknown`
to the Homebrew LLVM paths. Install with `brew install llvm` if WASM builds
fail with clang errors.

## Building & Testing

```bash
# Build test binaries (no test execution)
./cb.sh

# Run full default test flow:
# - rust + chialisp build
# - rust sim tests
# - JS/WASM integration tests
./ct.sh

# Run only sim test(s) matching 'accept_finished' (while debugging)
./ct.sh -o accept_finished

# Run JS/WASM integration tests (builds WASM, starts simulator, runs Jest)
./tools/local-wasm-tests.sh
```


# Running from tarball or zipfile

This guide covers building and running the two production artifacts:

1. **Player app** — fully static HTML/JS/CSS/WASM served from any web server.
2. **Tracker** — Express + WebSocket service that provides the lobby UI (iframe)
  and relays game messages between peers.

For architecture details, see [FRONTEND_ARCHITECTURE.md](FRONTEND_ARCHITECTURE.md).
For the Rust test suite, see [DEBUGGING_GUIDE.md](DEBUGGING_GUIDE.md).

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

### Verifying archives

After building, run the deploy archive test to confirm both tgz and zip
formats extract correctly, contain a complete staged tree, and serve over HTTP:

```bash
./tools/test-deploy-archives.sh
```

With a platform-tagged build (as in CI):

```bash
./tools/test-deploy-archives.sh --platform=linux
```

The test extracts each archive, runs `verify-stage.mjs`, floor-checks required
bundle files (WASM, clsp hex, images, service.js, etc.), compares tgz vs zip
trees for parity, and smoke-tests HTTP serving via `static-server.js` (player)
and `service.js` (lobby). CI runs this automatically after `build-deploy.sh` in
the Linux and macOS release jobs.

# Build Details

## Building in CI

The CI workflow [.github/workflows/frontend.yml](.github/workflows/frontend.yml) is the
canonical reference for the full build sequence.


## Building Locally

Run commands from the repo root unless noted.

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
static-server.js        ← static-server.js
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

### Running from Checkout

Run from a repo checkout. See [Quick Start](#quick-start) for the full local
stack (`./run-local-demo.sh` starts the player app, tracker, and simulator).

#### Player app

```bash
node static-server.js front-end/serve 3002
```

Open `http://localhost:3002`. `static-server.js` is a
zero-dependency Node server that sets correct MIME types (including `.wasm`)
and cache headers. Do not use `python3 -m http.server` — it does not
reliably serve `.wasm` with the correct MIME type.

To smoke-test a production tarball locally (after `./tools/build-deploy.sh`):

```bash
mkdir chia-gaming-player
tar -xzf deploy_player_app/chia-gaming-YYYYMMDD-HASH.tgz -C chia-gaming-player
# unzip deploy_player_app/chia-gaming-YYYYMMDD-HASH.zip -d chia-gaming-player

cd chia-gaming-player
node static-server.js . 3002
```

The `.` argument is the extracted root (the directory that contains
`index.html`, `build-meta.json`, and `app/`). Production tarballs include
`static-server.js` for this purpose.

#### Tracker

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

#### Simulator

```bash
./target/debug/chia-gaming-sim
```

Ports 5800 (HTTP) and 5801 (WebSocket) are hardcoded. Built by
`cargo build --features sim-server --bin chia-gaming-sim`. Not included in
production tarballs.

### Running from tarball or zipfile

#### Player app

No server-side logic required. Extract the player app tarball/zip onto your
static host and serve the staging directory with nginx, Caddy, S3 +
CloudFront, or any static file server:

```bash
mkdir -p /var/www/chia-gaming-player
tar -xzf chia-gaming-YYYYMMDD-HASH.tgz -C /var/www/chia-gaming-player
# or, unzip chia-gaming-YYYYMMDD-HASH.zip -d /var/www/chia-gaming-player
cd /var/www/chia-gaming-player
caddy file-server --listen :3002
```

See [Staging (Asset Layout)](#staging-asset-layout) for the directory
structure. Apply the caching and origin rules below.

#### Tracker

Extract the lobby tarball, then run the bundled service:

```bash
PORT=443 node service.js \
  --self 'https://tracker.example.com' \
  --dir .
```

Set `--self` to the tracker's public URL. The same `--dir`, `--self`,
`--verbose`, and `PORT` flags apply as when running from checkout (see table above).

#### Production notes

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
(`static-server.js` and the tracker service) already apply
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