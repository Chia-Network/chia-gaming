// Run electron-builder with its output redirected outside the repository.
//
// This repository can live under ~/Documents, which iCloud manages via File
// Provider. File Provider stamps com.apple.FinderInfo extended attributes on
// files it syncs, and codesign rejects those as "resource fork, Finder
// information, or similar detritus not allowed". $TMPDIR (/var/folders/...) is
// never synced, so building there keeps signing clean; the finished installers
// are sealed by the time they are copied back.

import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(tmpdir(), 'chia-gaming-desktop-build');
const RELEASE_DIR = join(DESKTOP, 'release');

const INSTALLER_EXTENSIONS = ['.dmg', '.zip', '.exe', '.AppImage', '.deb'];

rmSync(BUILD_DIR, { recursive: true, force: true });
mkdirSync(BUILD_DIR, { recursive: true });

const result = spawnSync(
  'electron-builder',
  [
    '--config',
    'electron-builder.config.cjs',
    `-c.directories.output=${BUILD_DIR}`,
    ...process.argv.slice(2),
  ],
  { cwd: DESKTOP, stdio: 'inherit', shell: false },
);

if (result.error) {
  throw result.error;
}
if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

mkdirSync(RELEASE_DIR, { recursive: true });
const installers = readdirSync(BUILD_DIR).filter((name) =>
  INSTALLER_EXTENSIONS.some((extension) => name.endsWith(extension)),
);
for (const name of installers) {
  copyFileSync(join(BUILD_DIR, name), join(RELEASE_DIR, name));
}

console.log(`\nbuild dir (not synced): ${BUILD_DIR}`);
if (installers.length === 0) {
  console.log(`no installer artifacts found in ${BUILD_DIR}`);
} else {
  console.log(`installers copied to:   ${RELEASE_DIR}`);
  for (const name of installers) {
    console.log(`  ${name}`);
  }
}
