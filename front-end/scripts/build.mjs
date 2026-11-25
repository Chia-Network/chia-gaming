import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { build } from 'esbuild';

const { values } = parseArgs({
  options: {
    dev: { type: 'boolean' },
    deploy: { type: 'boolean' },
    bundle: { type: 'boolean' },
  },
});
const development = values.dev === true;
const deploy = values.deploy || values.bundle;
const appDir = development ? 'dist/app-dev' : 'dist/app';
const scriptPath = development ? 'dist/demo/index.js' : 'dist/js/index-rollup.js';
const stylePath = development ? 'dist/demo/index.css' : 'dist/css/index.css';
const run = (args) => execFileSync(process.execPath, args, { stdio: 'inherit' });
const pnpm = (args) => run([process.env.npm_execpath, ...args]);

run(['scripts/generate-game-registry.mjs']);
pnpm(['exec', 'tsc', '--project', '.', '--noEmit']);
if (deploy) rmSync(appDir, { recursive: true, force: true });

const result = await build({
  entryPoints: ['src/index.tsx'],
  bundle: true,
  sourcemap: development,
  minifySyntax: !development,
  jsx: 'automatic',
  ...(deploy ? { format: 'esm', splitting: true, outdir: appDir } : { outfile: scriptPath }),
  alias: {
    '@': './src',
    '@games': '../games',
    react: './node_modules/react',
    'clvm-lib': './node_modules/clvm-lib',
  },
  define: { __DEV_BUILD__: String(development) },
  metafile: true,
});

const shipsSimulator = Object.keys(result.metafile.inputs).some((path) =>
  path.endsWith('/FakeBlockchainInterface.ts'),
);
if (shipsSimulator !== development) {
  throw new Error('The simulator adapter must ship only in development builds');
}

pnpm([
  'exec',
  'tailwindcss',
  '-i',
  './src/index.css',
  '-o',
  deploy ? `${appDir}/index.css` : stylePath,
]);
if (values.bundle) {
  run(['scripts/assemble-bundle.mjs', ...(development ? ['--dev'] : [])]);
}
