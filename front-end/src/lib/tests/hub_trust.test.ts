import { hubTrustError, requestHubTrust } from '../../util/hubTrust';

describe('hub trust', () => {
  it('asks the desktop bridge to trust the origin of a directory URL', async () => {
    const previous = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const requestTrust = jest.fn(async () => 'trusted');
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { __chiaHub: { requestTrust } },
    });
    try {
      await expect(requestHubTrust('https://hub.example/hubs/beta/')).resolves.toBe('trusted');
      expect(requestTrust).toHaveBeenCalledWith('https://hub.example');
    } finally {
      if (previous) Object.defineProperty(globalThis, 'window', previous);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  });

  it('reports trust persistence failures separately from invalid origins', () => {
    expect(hubTrustError('persist-failed', 'https://hub.example.com')).toBe(
      'Unable to save https://hub.example.com as a trusted hub.',
    );
    expect(hubTrustError('invalid', 'not a url')).toBe('not a url is not a valid hub address.');
    expect(hubTrustError('trusted', 'https://hub.example.com')).toBeNull();
    expect(hubTrustError('granted', 'https://hub.example.com')).toBeNull();
  });
});
