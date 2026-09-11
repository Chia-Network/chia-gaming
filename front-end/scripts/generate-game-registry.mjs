#!/usr/bin/env node
// Generates front-end/src/generated/gamePackages.ts from games/registry.json.
import { mkdirSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const FE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(FE, '..', '..');
const registry = JSON.parse(readFileSync(join(ROOT, 'games', 'registry.json'), 'utf8'));
const production = registry.production;
if (!Array.isArray(production) || production.length === 0) {
  throw new Error('games/registry.json production list is empty');
}

function factoryBinary(key) {
  const factory = `games/${key}/clsp/factory_prepared.clvm.bin`;
  if (!existsSync(join(ROOT, factory))) {
    throw new Error(`Missing ${factory}; run ./cb.sh to build game factories`);
  }
  return factory;
}

function tsString(value) {
  return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
}

function tsProperty(value) {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? value : tsString(value);
}

function tsArray(values, multiline = false) {
  if (!multiline) return `[${values.join(', ')}]`;
  return `[\n${values.map((value) => `  ${value},`).join('\n')}\n]`;
}

const presetFiles = production.map(factoryBinary);
function relTo(key, file) {
  const rel = relative(join(FE, '../src/generated'), join(ROOT, 'games', key, 'ui', file))
    .replace(/\\/g, '/')
    .replace(/\.tsx?$/, '');
  return rel.startsWith('.') ? rel : `./${rel}`;
}
const imports = production
  .map((key, index) => {
    return [
      `import handProposal${index} from '${relTo(key, 'handProposal.ts')}';`,
      `import { HandProposalForm as HandProposalForm${index} } from '${relTo(key, 'handProposalForm.tsx')}';`,
      `import { play as play${index} } from '${relTo(key, 'play.tsx')}';`,
      `const pkg${index} = defineGamePackage(handProposal${index}, HandProposalForm${index}, play${index});`,
    ].join('\n');
  })
  .join('\n');
const productionList = tsArray(production.map(tsString));
const presetList = tsArray(presetFiles.map(tsString), true);
const packageMap = production.map((key, index) => `  ${tsProperty(key)}: pkg${index},`).join('\n');

const destDir = join(FE, '../src/generated');
mkdirSync(destDir, { recursive: true });

writeFileSync(
  join(destDir, 'gamePresets.ts'),
  `// Generated from games/registry.json. Do not edit.
export const PRODUCTION_PACKAGE_KEYS = ${productionList} as const;
export type CatalogGameType = (typeof PRODUCTION_PACKAGE_KEYS)[number];
export const CORE_PRESET_FILES = [
  'clsp/unroll/unroll_puzzle_state_channel_unrolling.clvm.bin',
  'clsp/referee/onchain/referee.clvm.bin',
] as const;
export const GAME_PRESET_FILES = ${presetList} as const;
export const PRESET_FILES = [...CORE_PRESET_FILES, ...GAME_PRESET_FILES];
`,
);

writeFileSync(
  join(destDir, 'gamePackages.ts'),
  `// Generated from games/registry.json. Do not edit.
import { defineGamePackage } from '../lib/gamePackage';
${imports}

export const PRODUCTION_PACKAGE_KEYS = ${productionList} as const;
export type CatalogGameType = (typeof PRODUCTION_PACKAGE_KEYS)[number];
export const GENERATED_GAME_PACKAGES_BY_KEY = {
${packageMap}
} as const;
export const GENERATED_GAME_PACKAGES = Object.values(GENERATED_GAME_PACKAGES_BY_KEY);
export { PRESET_FILES, GAME_PRESET_FILES, CORE_PRESET_FILES } from './gamePresets';
`,
);

const styleImports = production.flatMap((key) => {
  const styles = join(ROOT, 'games', key, 'ui/styles.css');
  if (!existsSync(styles)) return [];
  const rel = relative(join(FE, '../src/generated'), styles).replace(/\\/g, '/');
  return [`@import '${rel.startsWith('.') ? rel : `./${rel}`}';`];
});
writeFileSync(
  join(destDir, 'gameStyles.css'),
  `/* Generated from games/registry.json. Do not edit. */\n${styleImports.join('\n')}${styleImports.length ? '\n' : ''}`,
);
console.log(`generate-game-registry: ${production.length} production packages`);
