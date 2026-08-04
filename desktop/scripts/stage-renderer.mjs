// Stages the tree served over the chiagaming:// scheme.
//
// It is the player-app deploy bundle (front-end/dist/app) plus the desktop HTML
// entry, which replaces the browser bootstrap so the document needs no inline
// script. Floor checks at the end fail the build loudly rather than shipping a
// bundle whose wasm or chialisp assets are missing.

import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO = resolve(DESKTOP, '..');
const PLAYER_BUNDLE = process.env.PLAYER_APP_DIR || join(REPO, 'front-end', 'dist', 'app');
const OUT = join(DESKTOP, 'dist', 'renderer');

if (!existsSync(join(PLAYER_BUNDLE, 'index.js'))) {
  throw new Error(
    `stage-renderer: no player app bundle at ${PLAYER_BUNDLE}\n` +
      'Build it first, from the repository root:\n' +
      '  tools/build-player-bundle.sh\n' +
      'Or build and package the desktop app in one step:\n' +
      '  tools/build-electron.sh --platform=mac',
  );
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });
cpSync(PLAYER_BUNDLE, OUT, { recursive: true });

for (const file of ['index.html', 'bootstrap.mjs']) {
  copyFileSync(join(DESKTOP, 'renderer', file), join(OUT, file));
}

const favicon = join(REPO, 'front-end', 'public', 'favicon.svg');
if (existsSync(favicon)) {
  copyFileSync(favicon, join(OUT, 'favicon.svg'));
}

const errors = [
  'index.html',
  'bootstrap.mjs',
  'index.js',
  'index.css',
  'chia_gaming_wasm.js',
  'chia_gaming_wasm_bg.wasm',
]
  .filter((file) => !existsSync(join(OUT, file)))
  .map((file) => `missing required file: ${file}`);

const clsp = join(OUT, 'clsp');
if (!existsSync(clsp) || readdirSync(clsp).length === 0) {
  errors.push('clsp/ is missing or empty (no compiled .hex)');
}

if (errors.length) {
  throw new Error(`stage-renderer: incomplete renderer in ${OUT}:\n  - ${errors.join('\n  - ')}`);
}

console.log(`stage-renderer: ok -> ${OUT}`);
