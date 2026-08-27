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
simulator. WalletConnect and Cloud Wallet remain available. The simulator
stays in the web build.

The same flag suppresses the front end's multi-tab lease. That lease records its
owner in `localStorage` but identifies itself from `sessionStorage`, so a quit
orphans it and the next launch would read a dead run as a live peer and open the
"Another tab is active" dialog on every start. `requestSingleInstanceLock` plus a
single window means a foreign owner here is always stale, so
`front-end/src/hooks/save.ts` treats it as no peer at all.

Because wallets display the dapp `url` to the user and fetch its icon over the
public internet, `front-end/src/util/walletConnectMetadata.ts` substitutes a
public https identity when the page origin is not http(s) — the renderer origin
here is `chiagaming://app`, which no wallet can open or fetch.

Cloud Wallet OAuth uses that same custom-scheme origin as `redirect_uri`
(`chiagaming://app/oauth/callback`). The protocol handler serves the player
document at that path so the callback page can `postMessage` the authorization
code to the opener. The Cloud Wallet OAuth client must allow that redirect URI.

## Configuration

Optional JSON file at `<userData>/config.json`, where `<userData>` is
`~/Library/Application Support/Chia Gaming` on macOS,
`%APPDATA%\Chia Gaming` on Windows, and `~/.config/Chia Gaming` on Linux.

| Key                  | Default                                                                                                | Meaning                                                                 |
| -------------------- | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------- |
| `hubOrigins`         | `["http://localhost:3003", "http://127.0.0.1:3003"]`                                                   | Hub origins the app may load and connect to                             |
| `cloudWalletOrigins` | `["http://127.0.0.1:3000", "http://127.0.0.1:3001", "http://localhost:3000", "http://localhost:3001"]` | Cloud Wallet API and UI origins for OAuth, GraphQL, and approval popups |

Anything invalid is reported in an error dialog and the app exits rather than
starting with a half-applied policy.

`hubOrigins` feeds both the CSP `frame-src` and the network egress allowlist. It
is a starting point rather than a fixed set: a hub typed into the in-app picker
is added to it at runtime and written back to the file. See
[Hub trust](#hub-trust).

`cloudWalletOrigins` feeds `connect-src` and the popup allowlist. They are not
framed. A production Cloud Wallet is added here (and the OAuth client must
allow `chiagaming://app/oauth/callback` as a redirect URI). A hub grant writes
`hubOrigins` without dropping a `cloudWalletOrigins` key already in the file.

## Security posture

### Process isolation

The renderer has no Node.js reachable from it at all, and the IPC surface is a
single channel described under [Hub trust](#hub-trust).

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

`src/preload/index.ts` exposes two things and nothing else: `__chiaDistribution`,
a string the front end reads during the first render to drop web-only
affordances, and `__chiaHub.requestTrust`, the app's single IPC channel. The
string has to be a preload global rather than anything asynchronous because it is
needed before the first render.

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

### Navigation and permissions

- `setWindowOpenHandler` allows a popup only when its origin is on
  `cloudWalletOrigins` (Cloud Wallet OAuth and funding approval). Those windows
  get an empty preload so they cannot see `__chiaHub`. Every other `window.open`
  is denied. About-window links still use `shell.openExternal` for the project
  URL only.
- `will-frame-navigate` keeps the player window's top frame on `chiagaming://app`,
  allows Cloud Wallet popups to reach `cloudWalletOrigins` and to return to the
  app for `/oauth/callback`, and restricts sub-frames to the frame allowlist. It
  is used in preference to `will-navigate`, which only sees the top frame.
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
- **The orphaned tab lease is only suppressed, not released.** `clearLease()` is
  exported from `front-end/src/hooks/save.ts` and still never called, so the dead
  run's owner id stays in `localStorage` until the next `claimLease()` overwrites
  it. That is harmless here because the desktop build ignores a foreign owner
  outright, but the web build still prompts after a tab is closed and reopened.
- **No code signing, notarization, or auto-update** is configured.
- **Fuses are only exercised in packaged builds**, so `pnpm start` will not
  catch a fuse-related regression.
