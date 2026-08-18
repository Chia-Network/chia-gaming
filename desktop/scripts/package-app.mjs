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
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const DESKTOP = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_DIR = join(tmpdir(), 'chia-gaming-desktop-build');
const RELEASE_DIR = join(DESKTOP, 'release');
const ELECTRON_BUILDER_CLI = createRequire(import.meta.url).resolve('electron-builder/cli.js');

const INSTALLER_EXTENSIONS = ['.dmg', '.zip', '.exe', '.AppImage', '.deb'];
const WINDOWS_SIGNING =
  process.platform === 'win32' && process.env.HAS_SIGNING_SECRET === 'true';

rmSync(BUILD_DIR, { recursive: true, force: true });
mkdirSync(BUILD_DIR, { recursive: true });

function run(command, args) {
  const result = spawnSync(command, args, {
    cwd: DESKTOP,
    stdio: 'inherit',
    shell: false,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function electronBuilder(args) {
  run(process.execPath, [
    ELECTRON_BUILDER_CLI,
    '--config',
    'electron-builder.config.cjs',
    `-c.directories.output=${BUILD_DIR}`,
    ...args,
  ]);
}

function executablePaths(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      return executablePaths(path);
    }
    return entry.isFile() && entry.name.endsWith('.exe') ? [path] : [];
  });
}

function signAndVerify(path) {
  const certificateHash = process.env.SM_CODE_SIGNING_CERT_SHA1_HASH;
  if (!certificateHash) {
    throw new Error('SM_CODE_SIGNING_CERT_SHA1_HASH is required for Windows signing');
  }
  run('signtool.exe', [
    'sign',
    '/sha1',
    certificateHash,
    '/tr',
    'http://timestamp.digicert.com',
    '/td',
    'SHA256',
    '/fd',
    'SHA256',
    path,
  ]);
  run('signtool.exe', ['verify', '/v', '/pa', path]);
}

const builderArgs = process.argv.slice(2);
if (WINDOWS_SIGNING) {
  electronBuilder([...builderArgs, '--dir']);
  const unpackedDirectory = join(BUILD_DIR, 'win-unpacked');
  for (const path of executablePaths(unpackedDirectory)) {
    signAndVerify(path);
  }
  electronBuilder([...builderArgs, '--prepackaged', unpackedDirectory]);
  for (const path of executablePaths(BUILD_DIR)) {
    if (dirname(path) === BUILD_DIR) {
      signAndVerify(path);
    }
  }
} else {
  electronBuilder(builderArgs);
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
