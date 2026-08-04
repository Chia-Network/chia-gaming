import { contextBridge } from 'electron';

// This preload deliberately does not import ipcRenderer: there is no
// renderer-to-main IPC surface at all. Everything the player app needs is
// either a plain web API or this one flag.

/**
 * Sub-frames are remote content — the hub lobby UI and the WalletConnect Verify
 * attestation frame — and must not see anything exposed here.
 *
 * `process.isMainFrame` is not part of the `process` subset a sandboxed preload
 * gets, and `webFrame.parent` reports null for out-of-process frames, so
 * identity against `window.top` is the check that actually holds.
 */
if (window === window.top) {
  // front-end/src/util/distribution.ts reads this to drop web-only
  // affordances. It has to be set before the first render, which is why it is
  // a preload global rather than anything asynchronous.
  contextBridge.exposeInMainWorld('__chiaDistribution', 'electron');
}
