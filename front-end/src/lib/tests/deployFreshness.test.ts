import {
  basePathKey,
  isStaleDeploy,
  normalizeBasePath,
  pageBasePath,
  recoverFromMissingDeployAsset,
  resolveDeployAssetUrl,
} from '../deployFreshness';

function docWithBase(href: string | null, baseURI = 'http://localhost:3002/'): {
  querySelector: Document['querySelector'];
  baseURI: string;
} {
  return {
    baseURI: href && href.startsWith('http') ? href : href ? `http://localhost:3002${href}` : baseURI,
    querySelector: (selector: string) => {
      if (selector !== 'base' || href === null) return null;
      return {
        href: href.startsWith('http') ? href : `http://localhost:3002${href}`,
        getAttribute: (name: string) => (name === 'href' ? href : null),
      } as HTMLBaseElement;
    },
  };
}

describe('deployFreshness', () => {
  it('normalizeBasePath adds a trailing slash when missing', () => {
    expect(normalizeBasePath('/app/123/')).toBe('/app/123/');
    expect(normalizeBasePath('/app/123')).toBe('/app/123/');
  });

  it('basePathKey compares absolute URLs to path basePaths', () => {
    expect(basePathKey('http://localhost:3002/app/123/')).toBe('/app/123/');
    expect(basePathKey('/app/123')).toBe('/app/123/');
  });

  it('pageBasePath prefers the base element href', () => {
    expect(pageBasePath(docWithBase(null))).toBeNull();
    expect(pageBasePath(docWithBase('/app/old/'))).toBe('http://localhost:3002/app/old/');
  });

  it('resolveDeployAssetUrl joins relative assets onto the nonce base', () => {
    expect(
      resolveDeployAssetUrl(
        'clsp/games/calpoker/calpoker_include_calpoker_factory.hex',
        'http://localhost:3002/app/123/',
      ),
    ).toBe('http://localhost:3002/app/123/clsp/games/calpoker/calpoker_include_calpoker_factory.hex');
  });

  it('resolveDeployAssetUrl leaves absolute and root-relative URLs alone', () => {
    expect(resolveDeployAssetUrl('/clsp/x.hex', 'http://localhost:3002/app/123/')).toBe('/clsp/x.hex');
    expect(resolveDeployAssetUrl('https://cdn.example/x.hex')).toBe('https://cdn.example/x.hex');
  });

  it('isStaleDeploy is false when build-meta matches the page base', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ basePath: '/app/same' }),
    })) as unknown as typeof fetch;

    await expect(
      isStaleDeploy(fetchImpl, 'http://localhost:3002/app/same/'),
    ).resolves.toBe(false);
    expect(fetchImpl).toHaveBeenCalledWith('/build-meta.json', { cache: 'no-store' });
  });

  it('isStaleDeploy is true when build-meta points at a new nonce', async () => {
    const fetchImpl = jest.fn(async () => ({
      ok: true,
      json: async () => ({ basePath: '/app/new/' }),
    })) as unknown as typeof fetch;

    await expect(
      isStaleDeploy(fetchImpl, 'http://localhost:3002/app/old/'),
    ).resolves.toBe(true);
  });

  it('isStaleDeploy is false when there is no page base', async () => {
    const fetchImpl = jest.fn() as unknown as typeof fetch;
    await expect(isStaleDeploy(fetchImpl, null)).resolves.toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('recoverFromMissingDeployAsset throws on current-deploy 404', async () => {
    await expect(
      recoverFromMissingDeployAsset('fetchHexString', 'clsp/x.hex', 404, 'Not Found', {
        isStale: async () => false,
      }),
    ).rejects.toThrow('fetchHexString clsp/x.hex: HTTP 404 Not Found');
  });

  it('recoverFromMissingDeployAsset reloads on stale-deploy 404', async () => {
    const reload = jest.fn();
    sessionStorage.clear();
    const pending = recoverFromMissingDeployAsset(
      'fetchHexString',
      'clsp/x.hex',
      404,
      'Not Found',
      { isStale: async () => true, reload },
    );
    await Promise.race([
      pending.then(() => { throw new Error('should not settle'); }),
      new Promise((resolve) => setTimeout(resolve, 20)),
    ]);
    expect(reload).toHaveBeenCalled();
    expect(sessionStorage.getItem('appState_autoResumeOnce')).toBe('1');
  });

  it('recoverFromMissingDeployAsset throws on non-404 without checking deploy', async () => {
    const isStale = jest.fn(async () => true);
    await expect(
      recoverFromMissingDeployAsset('fetchPreset', 'clsp/x.hex', 500, 'Error', { isStale }),
    ).rejects.toThrow('fetchPreset clsp/x.hex: HTTP 500 Error');
    expect(isStale).not.toHaveBeenCalled();
  });
});
