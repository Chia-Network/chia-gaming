// Distribution detection.
//
// The packaged Electron build sets `window.__chiaDistribution = 'electron'`
// from its preload script before any renderer code runs. The web build never
// sets it. Storage coordination uses this to recognize the single-window shell.

export function isElectronDistribution(): boolean {
  return typeof window !== 'undefined' && window.__chiaDistribution === 'electron';
}
