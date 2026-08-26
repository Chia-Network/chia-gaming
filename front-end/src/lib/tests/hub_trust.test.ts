import { hubTrustError } from '../../util/hubTrust';

describe('hub trust', () => {
  it('reports trust persistence failures separately from invalid origins', () => {
    expect(hubTrustError('persist-failed', 'https://hub.example.com')).toBe(
      'Unable to save https://hub.example.com as a trusted hub.',
    );
    expect(hubTrustError('invalid', 'not a url')).toBe('not a url is not a valid hub address.');
    expect(hubTrustError('trusted', 'https://hub.example.com')).toBeNull();
    expect(hubTrustError('granted', 'https://hub.example.com')).toBeNull();
  });
});
