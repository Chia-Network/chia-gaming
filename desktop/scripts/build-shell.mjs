import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const { positionals } = parseArgs({ allowPositionals: true });
const [entry] = positionals;
if (entry !== 'main' && entry !== 'preload') {
  throw new Error('Expected an Electron entry point: main or preload');
}

const development = process.env.CHIA_GAMING_DESKTOP_DEV === '1';
await build({
  entryPoints: [`src/${entry}/index.ts`],
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'cjs',
  external: ['electron'],
  outfile: `dist/${entry}/index.cjs`,
  sourcemap: development,
  minifySyntax: !development,
  define: {
    'process.env.CHIA_GAMING_DESKTOP_DEV': JSON.stringify(development ? '1' : '0'),
  },
});
