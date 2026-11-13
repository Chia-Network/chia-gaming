// Distribution detection.
//
// The packaged Electron build sets `window.__chiaDistribution = 'electron'`
// from its preload script before any renderer code runs. The web build never
// sets it. UI that is meaningful only on the web (e.g. the local simulator
// connection option) can branch on this.

export function isElectronDistribution(): boolean {
  return typeof window !== 'undefined' && window.__chiaDistribution === 'electron';
}

// `pnpm run dev` (run-local-demo.sh) serves the player app from localhost.
// Deployed web builds and the Electron `chiagaming://app` origin never do.
const LOCAL_DEV_HOSTNAMES = new Set(['localhost', '127.0.0.1', '[::1]']);

export function isLocalDevHost(): boolean {
  return typeof window !== 'undefined' && LOCAL_DEV_HOSTNAMES.has(window.location.hostname);
}
