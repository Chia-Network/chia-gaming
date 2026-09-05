import fs from 'node:fs';
import path from 'node:path';

const GAMES_ROOT = path.resolve(__dirname, '../../../../games');

function notificationNamesFromRust(source: string): string[] {
  const enumStart = source.indexOf('pub enum GameNotification {');
  const enumEnd = source.indexOf('\n}\n', enumStart);
  expect(enumStart).toBeGreaterThanOrEqual(0);
  expect(enumEnd).toBeGreaterThan(enumStart);
  const body = source.slice(enumStart, enumEnd);
  expect(body).not.toContain('serde(rename_all');
  return [...body.matchAll(/^ {4}(?:#\[serde\(rename = "([^"]+)"\)\]\n {4})?([A-Z]\w*)\s*[({]/gm)]
    .map((match) => match[1] ?? match[2])
    .sort();
}

function notificationNamesFromTypeMap(source: string): string[] {
  const body = source.match(/export interface WasmNotificationMap \{([\s\S]*?)\n\}/)?.[1];
  expect(body).toBeDefined();
  return [...body!.matchAll(/^ {2}([A-Z]\w*):/gm)].map((match) => match[1]).sort();
}

function notificationNamesFromFrontendSet(source: string): string[] {
  const body = source.match(/const WASM_NOTIFICATION_TAGS = new Set\(\[([\s\S]*?)\]\);/)?.[1];
  expect(body).toBeDefined();
  return [...body!.matchAll(/^\s*'([A-Z]\w*)',?$/gm)].map((match) => match[1]).sort();
}

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

describe('game package isolation', () => {
  it('guards the generated package assembly layout', () => {
    const generated = fs.readFileSync(
      path.resolve(__dirname, '../../generated/gamePackages.ts'),
      'utf8',
    );
    expect(generated).toContain('defineGamePackage(');
    expect(generated).toContain("from '../lib/gamePackage'");
    expect(generated).not.toContain("from '../../../games/host'");
    expect(generated).toContain('GENERATED_GAME_PACKAGES_BY_KEY');
    expect(generated).not.toContain('Object.assign');
    expect(generated).not.toContain('as unknown as GamePackage');
  });

  it('guards the factory preset generator input layout', () => {
    const generator = fs.readFileSync(
      path.resolve(__dirname, '../../../scripts/generate-game-registry.mjs'),
      'utf8',
    );
    expect(generator).toContain('factory_prepared.clvm.bin');
    expect(generator).not.toContain('package_manifest.json');
  });

  it('guards notification source layouts against contract drift', () => {
    const rust = fs.readFileSync(
      path.resolve(__dirname, '../../../../src/session_phases/effects.rs'),
      'utf8',
    );
    const wasmContract = fs.readFileSync(
      path.resolve(__dirname, '../../../../wasm/contract.d.ts'),
      'utf8',
    );
    const frontend = fs.readFileSync(path.resolve(__dirname, '../../types/ChiaGaming.ts'), 'utf8');

    const rustNames = notificationNamesFromRust(rust);
    expect(notificationNamesFromTypeMap(wasmContract)).toEqual(rustNames);
    expect(notificationNamesFromFrontendSet(frontend)).toEqual(rustNames);
  });

  it('does not import this player app from game UI or game tests', () => {
    const keys = fs.readdirSync(GAMES_ROOT).filter((name) => {
      const ui = path.join(GAMES_ROOT, name, 'ui');
      return name !== 'host' && fs.existsSync(ui) && fs.statSync(ui).isDirectory();
    });
    const offenders: string[] = [];
    for (const key of keys) {
      const uiRoot = path.join(GAMES_ROOT, key, 'ui');
      for (const file of walk(uiRoot)) {
        if (!/\.(ts|tsx)$/.test(file)) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (
          /['"]@\//.test(text) ||
          /from\s+['"][^'"]*front-end\//.test(text) ||
          /from\s+['"][^'"]*(?:gamePackage|gameRegistry|gameMountRegistry|gameHandSource)['"]/.test(
            text,
          )
        ) {
          offenders.push(path.relative(GAMES_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('does not expose a shared game presentation module', () => {
    expect(fs.existsSync(path.join(GAMES_ROOT, 'host', 'ui.tsx'))).toBe(false);
    const offenders = walk(GAMES_ROOT)
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => /from\s+['"][^'"]*host\/ui['"]/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(GAMES_ROOT, file));
    expect(offenders).toEqual([]);
  });

  it('constructs cheat intents only in Space Poker', () => {
    const constructors = walk(GAMES_ROOT)
      .filter((file) => /\.(ts|tsx)$/.test(file))
      .filter((file) => !file.startsWith(path.join(GAMES_ROOT, 'host')))
      .filter((file) => /type:\s*['"]cheat['"]/.test(fs.readFileSync(file, 'utf8')))
      .map((file) => path.relative(GAMES_ROOT, file));
    expect(constructors.length).toBeGreaterThan(0);
    expect(constructors.every((file) => file.startsWith(`spacepoker${path.sep}`))).toBe(true);
  });

  it('does not import game internals from player-app production code', () => {
    const feRoot = path.resolve(__dirname, '../..');
    const offenders: string[] = [];
    for (const file of walk(feRoot)) {
      if (!/\.(ts|tsx)$/.test(file)) continue;
      if (/\.(spec|test)\.(ts|tsx)$/.test(file)) continue;
      if (file.includes(`${path.sep}tests${path.sep}`)) continue;
      if (file.endsWith(`${path.sep}generated${path.sep}gamePackages.ts`)) continue;
      const text = fs.readFileSync(file, 'utf8');
      const importRe =
        /from\s+['"](@games\/(?:calpoker|krunk|spacepoker)[^'"]*|[^'"]*games\/(?:calpoker|krunk|spacepoker)\/ui\/[^'"]*)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = importRe.exec(text))) {
        offenders.push(`${path.relative(feRoot, file)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
