import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';

const entries = [
  ['player', '../../../public/index.html'],
  ['hub', '../../../../hub/hub-frontend/public/index.html'],
] as const;

describe.each(entries)('static %s bootstrap', (kind, entry) => {
  const html = readFileSync(resolve(__dirname, entry), 'utf8');
  const script = html.match(/<script>([\s\S]*?)<\/script>/)![1];
  it.each(
    [
      ['/', '/'],
      ['/index.html', '/'],
      ['/chia-gaming/', '/chia-gaming/'],
      ['/chia-gaming/index.html', '/chia-gaming/'],
      ['/chia-gaming/oauth/callback/?code=abc&state=xyz', '/chia-gaming/'],
      ['/oauth/callback?code=abc&state=xyz', '/'],
    ].filter(([path]) => kind === 'player' || !path.includes('/oauth/')),
  )('loads assets from the installation root at %s', async (path, root) => {
    const location = new URL(path, 'https://example.org');
    const nodes: Record<string, string>[] = [];
    const rootElement = { textContent: '' };
    const window = { location, top: null as unknown };
    window.top = window;
    const fetch = jest.fn(async (_url: URL, _options: unknown) => ({
      json: async () => ({ basePath: '/app/build123/' }),
    }));
    runInNewContext(script, {
      URL,
      window,
      fetch,
      document: {
        getElementById: () => rootElement,
        createElement: (tag: string) => ({ tag }),
        head: { appendChild: (node: Record<string, string>) => nodes.push(node) },
        body: { appendChild: (node: Record<string, string>) => nodes.push(node) },
      },
    });
    // Flush the metadata fetch/JSON promise chain.
    await new Promise((resolve) => setImmediate(resolve));
    expect(rootElement.textContent).toBe('');
    expect(String(fetch.mock.calls[0][0])).toBe('https://example.org' + root + 'build-meta.json');
    const base = nodes.find((node) => node.tag === 'base')!.href;
    expect(base).toBe('https://example.org' + root + 'app/build123/');
    const icon = nodes.find((node) => node.rel === 'icon')!;
    expect(icon.href).toBe('favicon.svg');
    expect(nodes.indexOf(icon)).toBeGreaterThan(nodes.findIndex((node) => node.tag === 'base'));
    for (const asset of [
      'index.js',
      'index.css',
      'favicon.svg',
      ...(kind === 'player' ? ['chia_gaming_wasm_bg.wasm'] : []),
    ]) {
      expect(nodes.some((node) => node.src === asset || node.href === asset)).toBe(true);
      expect(new URL(asset, base).pathname).toBe(root + 'app/build123/' + asset);
    }
    if (kind === 'player') {
      expect(nodes.some((node) => node.textContent?.includes('./chia_gaming_wasm.js'))).toBe(true);
    }
  });
});
