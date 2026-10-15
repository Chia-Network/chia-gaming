# Chia Gaming Desktop

A hardened Electron shell around the existing player app (`front-end/`). The
renderer runs exactly the same React + WASM bundle the browser deploy serves;
this package supplies the process boundary, the asset origin, and the security
policy around it.

## Build and run

One command, from the repository root, builds everything and produces
installers:

```bash
tools/build-electron.sh --platform=mac   # or --platform=win / --platform=linux
```

That runs `tools/build-player-bundle.sh` (chialisp, the release WASM engine, and
the bundled React app, shared with `tools/build-deploy.sh`) and then packages the
Electron app.

Release CI builds a universal macOS app plus x64 Windows and Linux packages:

```bash
tools/build-electron.sh \
  --platform=mac \
  --arch=universal \
  --release-version=0.4.0-beta.1
```

The semantic release version is embedded in the Electron package and used in
the installer filename. Windows and Linux use `--arch=x64`.

For iterating on the desktop shell without repackaging:

```bash
tools/build-player-bundle.sh             # once, or after changing front-end/
pnpm --filter chia-gaming-desktop start  # typecheck, bundle main/preload, stage, launch
```

`start` re-runs the whole desktop build each time. After changing only the
player app, re-run `tools/build-player-bundle.sh` and then
`pnpm --filter chia-gaming-desktop run stage`.

Finished installers land in `desktop/release/`. electron-builder itself runs against a
directory under `$TMPDIR` rather than the repository, because a checkout under
`~/Documents` is managed by the iCloud File Provider, which stamps
`com.apple.FinderInfo` extended attributes that codesign rejects as "detritus".

The hub service is a separate process, unchanged by this package. Run
`./run-local-demo.sh` for it, then launch the desktop app instead of opening the
browser at `:3002`.

## Connection modes

The desktop build hides the local simulator. The preload sets
`window.__chiaDistribution = 'electron'`, and `front-end/src/util/distribution.ts`
uses it to hide the "Continue with Simulator" button and to resume a saved
session with no recorded `blockchainType` as WalletConnect rather than
simulator. WalletConnect, Sage, and Cloud Wallet remain available; Sage's chain
reads go to `api.coinset.org` (or `testnet11.api.coinset.org`), which the
network policy allows. The simulator stays in the web build.

The same flag suppresses the front end's multi-tab lease. That lease records its
owner in `localStorage` but identifies itself from `sessionStorage`, so a quit
orphans it and the next launch would read a dead run as a live peer and open the
"Another tab is active" dialog on every start. `requestSingleInstanceLock` plus a
single window means a foreign owner here is always stale, so
`front-end/src/lib/session/storageRepository.ts` treats it as no peer at all.

Because wallets display the dapp `url` to the user and fetch its icon over the
public internet, `front-end/src/util/walletConnectMetadata.ts` substitutes a
public https identity when the page origin is not http(s) — the renderer origin
here is `chiagaming://app`, which no wallet can open or fetch.

Cloud Wallet sign-in and signature approval run in the system browser, because
Electron has no passkey support: WebAuthn requests in an Electron window stay
pending with no UI. Sign-in returns through a one-time loopback listener on
`127.0.0.1` (RFC 8252 §7.3). The Cloud Wallet OAuth client must register
`http://127.0.0.1/oauth/callback`; the server accepts any loopback port for it.
Approvals need no return path because the player polls the signature request.
Token requests go through the main process, since the token endpoint answers
CORS only for http(s) client origins and the player runs on `chiagaming://app`.
No Cloud Wallet page renders inside the app.

For a local Cloud Wallet, set `CHIA_GAMING_CLOUD_WALLET_API_URL`,
`CHIA_GAMING_CLOUD_WALLET_UI_URL` and `CHIA_GAMING_CLOUD_WALLET_CLIENT_ID` on an
unpackaged run, and list both origins in `cloudWalletOrigins` (below).

## Peer-to-peer lobby (Pear spike)

**Spike.** The desktop app can play without any hub server. The hub picker
offers "Join peer-to-peer lobby", and the app then uses the worker pattern from
Holepunch's `hello-pear-electron` template.

```
renderer (PearHubConnection, PearLobby)
  ⇅ window.__chiaPear  (preload; main frame only)
main (src/main/pearWorker.ts — broker only, decides nothing)
  ⇅ framed IPC pipe (pear-runtime → bare-sidecar)
Bare worker (workers/main.cjs — IPC glue + Pear updater)
  └ workers/lobby.cjs — presence gossip, challenges, game relay
  ⇅ Noise-encrypted Hyperswarm connections
other players' workers
```

- **Lobby topic.** Every player joins one well-known Hyperswarm topic per
  network (`mainnet`, `testnet`, or `simulator` for dev). Players keep a
  bounded number of lobby connections instead of a full mesh:
  - Hyperswarm dials the lobby peers it discovers, capped by
    `maxClientConnections` (6). Other players' dials add about as many
    incoming connections.
  - Above 20 unprotected connections, a player prunes its best-connected
    neighbour. The `prune` message makes both ends stop redialling.
  - Connections that carry a challenge or a game are never pruned, and
    neither are connections younger than 15 s.
- **Presence gossip.** Each player signs a small presence entry with its
  Hyperswarm key: alias, busy, preferred buy-in, and a "gone" flag on leaving.
  - Players republish their entry every 20 s, and entries expire 70 s after
    their signed timestamp.
  - Neighbours forward entries. A change (busy, alias, buy-in, leaving) goes
    to every neighbour; a plain refresh goes to 6 random neighbours.
  - A new neighbour receives the full set of live entries.
  - Entries are verified before they are stored or forwarded. Stale or
    far-future timestamps are rejected, so a peer cannot forge, alter or
    replay another player's presence.
  - Everyone sees everyone who is online without being connected to them.
- **Challenges.** A player you see but are not connected to is dialled by
  public key (`joinPeer`). Open challenges are re-sent on every new connection
  to that player, because a first connection can look open while dead (a
  failed relay; Hyperswarm notices after about 13 s and redials). The receiver
  de-duplicates them by id.
- **Hub role.** For the renderer, the worker acts as a local hub. It sends
  the same events as the hub's game socket: `registered`, `advisory_start`,
  `relay`, `delivery_failure`, `peer_available`, `peer_unavailable`,
  `alias_updated` and `hub_attention`. `PearHubConnection` maps them onto
  `HubConnectionCallbacks`. As a result, the session, reliable-frame and
  restore code above it is the same code the hub path uses.
- **Identity.** The worker derives its Hyperswarm keypair from the per-origin
  hub session credential (origin `pear://lobby`). A player id is `p_` plus
  the first 16 bytes of that public key. A restarted app therefore rejoins as
  the same player, and its live channel resumes.
- **Trust.** Everything a remote peer sends is validated in the worker before
  it is forwarded. Authority still comes from the channel handshake, as with
  the hub. Unlike hub relaying, relayed frames are end-to-end encrypted.
- **OTA updates.** The worker wires `pear-runtime`'s updater exactly as
  `hello-pear-worker` does. It stays off because no `pear://` upgrade link has
  been provisioned (`pear touch` / stage / multisig).

### What the spike does not do

- **Packaging.** Only `pnpm start` (dev) runs the worker.
  `electron-builder.config.cjs` ships no `node_modules`, keeps everything in
  asar and sets `onlyLoadAppFromAsar`. A packaged build would need the worker,
  its dependencies and the per-platform `bare` binary unpacked outside the
  asar. Holepunch's template disables asar for this reason.
- **NAT fallback.** There is no blind relay. Players behind symmetric NAT on
  both sides cannot connect.
- **Bootstrap nodes.** Discovery uses the public HyperDHT bootstrap nodes.
- **Spam and fake players.** Keys are free, so anyone can flood the lobby
  with fake players. Beyond per-peer caps on pending challenges and message
  sizes, nothing prevents this yet. Options are proof-of-work on presence
  entries, or a signature showing control of a coin worth at least the buy-in.
- **Hyperswarm internals.** Two Hyperswarm internals are relied on:
  `_attemptClientConnections()`, which has no public way to re-drain the dial
  queue after raising the cap, and the retry timer honouring
  `PeerInfo.reconnect(false)`.

### Load test

`pnpm --filter chia-gaming-desktop run test:lobby` runs the lobby tests on a
local HyperDHT testnet. `run loadtest:lobby [players] [joinsPerSecond]` runs N
lobbies in one process with the real timings. Measured on one laptop:

| Players | Everyone sees everyone | Connections / node (avg, max) | Inbound / node, steady | Clean leave seen everywhere | Abrupt leave |
| ------- | ---------------------- | ----------------------------- | ---------------------- | --------------------------- | ------------ |
| 100     | 0.6 s after last join  | 11.6, 29                      | ~10 KB/s               | 0.7 s                       | ≈ TTL (70 s) |
| 300     | 1.6 s after last join  | 11.9, 37                      | ~28 KB/s               | 1.4 s                       | ≈ TTL (70 s) |

Steady-state traffic grows linearly with the number of players: every player
refreshes every 20 s, and everyone receives every refresh. Expect roughly
100 KB/s per node at 1,000 players. Beyond that, the next steps are a longer
refresh and TTL, a binary encoding, and digest-based sync instead of full
re-sends.

### Dev: two instances against the simulator

The simulator is hidden in desktop builds. To drive a whole game without a
wallet, set `CHIA_GAMING_DEV_SIMULATOR_URL` on an unpackaged run. Packaged
builds clear it. With it set, the simulator origin is allowed and the
"Continue with Simulator" button appears. `--user-data-dir` gives each
instance its own profile and single-instance lock:

```bash
./target/debug/chia-gaming-sim &
CHIA_GAMING_DEV_SIMULATOR_URL=http://127.0.0.1:5800 pnpm --filter chia-gaming-desktop exec electron . --user-data-dir=/tmp/cg-a
CHIA_GAMING_DEV_SIMULATOR_URL=http://127.0.0.1:5800 pnpm --filter chia-gaming-desktop exec electron . --user-data-dir=/tmp/cg-b
```

## Configuration

Optional JSON file at `<userData>/config.json`, where `<userData>` is
`~/Library/Application Support/Chia Gaming` on macOS,
`%APPDATA%\Chia Gaming` on Windows, and `~/.config/Chia Gaming` on Linux.

| Key                  | Default                                                                                                | Meaning                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `hubOrigins`         | `["http://localhost:3003", "http://127.0.0.1:3003"]`                                                   | Hub origins the app may load and connect to                             |
| `cloudWalletOrigins` | `["https://api.vault.chia.net", "https://vault.chia.net", "https://api.vault.chiatest.net", "https://vault.chiatest.net"]` | Cloud Wallet API and UI origins for GraphQL, browser sign-in and approval, and token requests |

Anything invalid is reported in an error dialog and the app exits rather than
starting with a half-applied policy.

`hubOrigins` feeds both the CSP `frame-src` and the network egress allowlist. It
is a starting point rather than a fixed set: a hub typed into the in-app picker
is added to it at runtime and written back to the file. See
[Hub trust](#hub-trust).

`cloudWalletOrigins` feeds `connect-src` and decides which https Cloud Wallet
pages the app opens in the system browser and which `/token` endpoints main
relays to. They are never framed or opened in an app window. A production Cloud
Wallet is added here (and its OAuth client must register
`http://127.0.0.1/oauth/callback`). A hub grant writes `hubOrigins` without
dropping a `cloudWalletOrigins` key already in the file.

## Security posture

### Process isolation

The renderer has no Node.js reachable from it at all. The IPC surface is the hub
trust request described under [Hub trust](#hub-trust), the Cloud Wallet
channels described under [Cloud Wallet in the browser](#cloud-wallet-in-the-browser),
and the two Pear lobby channels described under
[Peer-to-peer lobby (Pear spike)](#peer-to-peer-lobby-pear-spike). Every handler
checks that the sender is the player document's top frame.

| Setting                       | Value                                                                     |
| ----------------------------- | ------------------------------------------------------------------------- |
| `sandbox`                     | `true` (also `app.enableSandbox()`, which covers renderers created later) |
| `contextIsolation`            | `true`                                                                    |
| `nodeIntegration`             | `false`                                                                   |
| `nodeIntegrationInWorker`     | `false`                                                                   |
| `nodeIntegrationInSubFrames`  | `false`                                                                   |
| `webSecurity`                 | `true`                                                                    |
| `allowRunningInsecureContent` | `false`                                                                   |
| `experimentalFeatures`        | `false`                                                                   |
| `webviewTag`                  | `false`                                                                   |
| `navigateOnDragDrop`          | `false`                                                                   |
| `devTools`                    | only in unpackaged builds                                                 |

`src/preload/index.ts` exposes `__chiaDistribution`, a string the front end
reads during the first render to drop web-only affordances,
`__chiaHub.requestTrust`, `__chiaCloudWallet` (browser sign-in, opening an
approval in the browser, and token requests), and `__chiaPear` (the lobby
worker). In unpackaged builds it can also expose the
`CHIA_GAMING_CLOUD_WALLET_*` endpoint overrides and the dev simulator URL; main
deletes those variables in packaged builds. The distribution string has to be a preload global
rather than anything asynchronous because it is needed before the first render.

The exposure is guarded on `window === window.top`. Sub-frames here are remote
content (the hub lobby UI, the WalletConnect Verify frame) and get nothing.
`process.isMainFrame` is not available to a sandboxed preload and
`webFrame.parent` reports `null` for out-of-process frames, so neither is a
usable guard.

### Renderer origin

The renderer is served from `chiagaming://app`, a scheme registered as
`standard` + `secure`, not from `file://`. A real origin is what makes
`localStorage`, IndexedDB, `crypto.subtle` and relative asset URLs behave the
same as in the browser deploy, with `webSecurity` left on and no `file://`
privileges granted to anything.

`src/main/appProtocol.ts` resolves each request inside the staged renderer
directory and rejects anything that escapes it. It reads through Node's `fs`
rather than `net.fetch(file://…)` because asar support is implemented as an `fs`
shim; that is what lets the renderer stay sealed inside `app.asar`, where the
integrity-validation fuse still covers it, instead of being unpacked beside it.
Requests positively identified as cross-site by Chromium Fetch Metadata are
rejected. Electron omits all initiator metadata from both app-owned
custom-scheme subresources and deliberately unlabelled remote requests, so an
empty metadata set is not treated as proof of origin. Hub documents instead
receive a CSP whose web-only `default-src` prevents them from requesting the
custom scheme. The protocol handler independently coalesces reads by resolved
file path, retains successful immutable asset bodies, and permits at most four
distinct ASAR filesystem reads at once. Query strings cannot bypass that bound
or cache. Response extensions are normalized once for MIME, caching, and
security-header decisions. HTML receives `Cache-Control: no-store`; other
assets receive immutable browser cache headers. Both HTML and SVG responses
receive the current CSP because either can act as a script-bearing document.

### Content Security Policy

Served with the document by the protocol handler, so there is a single source
of truth:

```
default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self'; connect-src 'self' <allowlist>;
frame-src <allowlist>; worker-src 'none'; media-src 'none'; object-src 'none';
manifest-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'
```

Three of those need explanation:

- `'wasm-unsafe-eval'` is what lets the Rust engine compile. JavaScript `eval`
  stays blocked.
- No inline script is permitted, which is why `renderer/index.html` exists
  instead of reusing `front-end/public/index.html` — the browser entry point
  bootstraps through an inline `<script>` that would need a hash or a nonce.
- `style-src` allows inline styles because Radix's scroll-lock injects a
  `<style>` element at runtime. Inline _style_ is not an XSS vector the way
  inline _script_ is.

### Network egress

`onBeforeRequest` cancels every `http`, `https`, `ws` and `wss` request whose
origin is not on the allowlist, and logs it. The allowlist is the configured hub
origins (plus their WebSocket forms), the configured Cloud Wallet origins, and
the WalletConnect endpoints `sign-client` actually reaches: the `.com` and
`.org` relays, the Verify API, and `pulse.walletconnect.org`. Requests on
`chiagaming://` are answered from disk and never touch the network stack.

Chromium transports that do not pass through `onBeforeRequest` are restricted
on each configured hub document itself. The main process replaces any
hub-supplied `Connection-Allowlist` response header with one that permits the
configured hub origins and sets `webrtc=block`. The desktop enables Chromium
150's `ConnectionAllowlists` feature and its origin-trial override before
startup, so the injected header rejects `RTCPeerConnection` construction
without trusting a token from the hub. It also appends a `connect-src` CSP
limited to those hubs and their WebSocket forms, which is the policy
WebTransport enforces before opening QUIC. Every web contents additionally uses
Electron's `disable_non_proxied_udp` WebRTC IP policy as defense in depth.

### Hub trust

A hub is third-party infrastructure the player is meant to choose, so the
allowlist is extensible at runtime. `src/main/hubTrust.ts` adds an origin the
player document asks for, rebuilds the policy, and persists the list so the same
hub costs nothing on the next launch. Because the CSP is stamped onto the
document when it loads, the renderer reloads once after a new origin is added.

The allowlist stays in the main process so that a hub cannot widen it: the
preload exposes no bridge to sub-frames, a hub can never navigate the top frame,
and the handler checks that the sender is the app's own main frame as well. The
player document's request is then granted without a prompt. That document is our
own bundle under a CSP with no inline, remote or `eval`-able script, so a native
prompt would only guard against a compromised bundle, which could equally well
fake the prompt's own UI or leave through the hub already on the allowlist. What
a hub can see, and a warning when it would be reached over plain http, are
disclosed in `front-end/src/components/HubPicker.tsx` instead, where the player
is actually choosing.

### Cloud Wallet in the browser

`src/main/cloudWalletBrowser.ts` handles the Cloud Wallet channels:

- Sign-in binds a one-time listener on an ephemeral `127.0.0.1` port and opens
  the authorize URL with `shell.openExternal`, only if it is an https URL on
  `cloudWalletOrigins` whose `redirect_uri` is that listener. Only a callback
  carrying the authorize request's `state` settles the sign-in, so a stray or
  forged local request cannot consume it. Starting another sign-in cancels the
  previous one, and an unanswered sign-in gives up after five minutes. The
  callback refocuses the window that started it.
- Approval pages open with `shell.openExternal`, again only on
  `cloudWalletOrigins`. The player polls the signature request for the result.
- Token requests (code exchange and refresh) are relayed with `net.fetch`, only
  to `https://<cloud wallet origin>/token`.

### Navigation and permissions

- `setWindowOpenHandler` denies every `window.open`; no page opens in an app
  window. About-window links still use `shell.openExternal` for the project URL
  only.
- `will-frame-navigate` keeps the player window's top frame on
  `chiagaming://app/index.html`, keeps other top-level windows on app documents,
  and restricts sub-frames to the frame allowlist. It is used in preference to
  `will-navigate`, which only sees the top frame.
- `will-attach-webview` is blocked, on top of `webviewTag: false`.
- Permission requests and checks are denied except `clipboard-sanitized-write`
  from the app origin, which is what `navigator.clipboard.writeText` needs to
  copy WalletConnect URIs and diagnostic logs.
- `setDevicePermissionHandler` denies all WebUSB / WebHID / Web Serial devices.
- One instance at a time, via `requestSingleInstanceLock`.

### Packaged builds

`electron-builder.config.cjs` flips the Electron fuses: no
`ELECTRON_RUN_AS_NODE`, no `NODE_OPTIONS`, no `--inspect`, cookie encryption on,
ASAR integrity validation on, and the app loadable only from `app.asar`.

macOS builds use the hardened runtime with three entitlements:
`com.apple.security.network.client`, `com.apple.security.cs.allow-jit` for the
V8 and WebAssembly JIT, and `com.apple.security.cs.disable-library-validation`.
The last one is not optional — a custom entitlements file replaces
electron-builder's defaults rather than extending them, and without it the
hardened runtime refuses to load the Electron Framework and the app dies at
launch in dyld with "different Team IDs".

`packaging/afterPack.cjs` clears extended attributes from the packed app before
codesign, because macOS stamps `com.apple.provenance` on executables it writes
and codesign rejects that as "detritus".

## Release signing

CI signs automatically when a platform's complete credential set is available.
Complete Apple credentials enable Developer ID signing followed by notarization
and stapling. Complete Azure credentials in the `windows-code-signing`
environment sign and verify the Windows application and installer. Partial
credential sets fail rather than silently degrading.

When no credential set is configured, CI intentionally produces unsigned
installers. The macOS package is still checked for both arm64 and x86_64 slices
and for a valid post-fuse bundle signature. Users should expect Gatekeeper or
SmartScreen warnings, and the GitHub release notes must identify the installers
as unsigned. Linux packages are distributed with SHA-256 checksums but are not
repository-signed.

## Known gaps

- **Trusting a new hub costs a renderer reload.** The main-process checks
  (`onBeforeRequest`, `will-frame-navigate`) pick up a new origin immediately, but
  the CSP is attached to the document at load time, so the hub is not reachable
  from the document that asked for it. Dropping `connect-src` and `frame-src` from
  the document CSP and leaning on the main-process checks alone would remove the
  reload at the cost of a layer.
- **The hub lobby UI is still a cross-origin iframe** inside the player
  document, as it is in the browser. It receives no bridge API and cannot
  navigate the top frame, but it does share the renderer process boundary with
  the player app. Moving it to its own `WebContentsView` with a separate session
  partition would be stronger and requires geometry plumbing.
- **Session state at rest is unchanged** — the bencodex session blob still uses
  the front-end's own IndexedDB obfuscation. Electron's `safeStorage` could key
  it to the OS keychain, which needs the front-end to opt in.
- **No auto-update is configured.** Signing and notarization depend on optional
  CI credentials; unsigned beta fallback remains enabled.
- **Fuses are only exercised in packaged builds**, so `pnpm start` will not
  catch a fuse-related regression.
