import fs from 'node:fs';
import path from 'node:path';

const GAMES_ROOT = path.resolve(__dirname, '../../../../games');

function walk(dir: string, files: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, files);
    else files.push(full);
  }
  return files;
}

describe('game package isolation', () => {
  it('does not import this player app from production game UI', () => {
    const keys = fs.readdirSync(GAMES_ROOT).filter((name) => {
      const ui = path.join(GAMES_ROOT, name, 'ui');
      return name !== 'host' && fs.existsSync(ui) && fs.statSync(ui).isDirectory();
    });
    const offenders: string[] = [];
    for (const key of keys) {
      const uiRoot = path.join(GAMES_ROOT, key, 'ui');
      for (const file of walk(uiRoot)) {
        if (!/\.(ts|tsx)$/.test(file)) continue;
        if (/\.(spec|test)\.(ts|tsx)$/.test(file)) continue;
        const text = fs.readFileSync(file, 'utf8');
        if (/['"]@\//.test(text) || /from\s+['"]\.\.\/\.\.\/front-end/.test(text)) {
          offenders.push(path.relative(GAMES_ROOT, file));
        }
      }
    }
    expect(offenders).toEqual([]);
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
        /from\s+['"](@games\/(?:calpoker|krunk|spacepoker)[^'"]*|[^'"]*games\/(?:calpoker|krunk|spacepoker)\/ui\/(?!package)[^'"]*)['"]/g;
      let match: RegExpExecArray | null;
      while ((match = importRe.exec(text))) {
        offenders.push(`${path.relative(feRoot, file)}: ${match[0]}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
