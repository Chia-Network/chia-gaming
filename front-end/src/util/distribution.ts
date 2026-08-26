// Distribution detection.
//
// The packaged Electron build sets `window.__chiaDistribution = 'electron'`
// from its preload script before any renderer code runs. The web build never
// sets it. UI that is meaningful only on the web (e.g. the local simulator
// connection option) can branch on this.

export function isElectronDistribution(): boolean {
  return typeof window !== 'undefined' && window.__chiaDistribution === 'electron';
}
