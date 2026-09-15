import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { appAssetCacheControl, isAppSchemeRequestAllowed } from './appProtocolPolicy.ts';

function request(
  url: string,
  headers: Record<string, string>,
  referrer = '',
): { url: string; headers: Headers; referrer: string } {
  return { url, headers: new Headers(headers), referrer };
}

describe('app protocol policy', () => {
  it('does not cache documents as immutable assets', () => {
    assert.equal(appAssetCacheControl('/renderer/index.html'), 'no-store');
    assert.equal(appAssetCacheControl('/renderer/INDEX.HTML'), 'no-store');
    assert.equal(appAssetCacheControl('/renderer/app.js'), 'public, max-age=31536000, immutable');
  });

  it('allows app requests and only the OAuth cross-site navigation', () => {
    assert.equal(
      isAppSchemeRequestAllowed(
        request('chiagaming://app/index.js', { 'sec-fetch-site': 'same-origin' }),
      ),
      true,
    );
    assert.equal(
      isAppSchemeRequestAllowed(
        request('chiagaming://app/index.js', { 'sec-fetch-site': 'cross-site' }),
      ),
      false,
    );
    assert.equal(
      isAppSchemeRequestAllowed(
        request('chiagaming://app/oauth/callback', {
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        }),
      ),
      true,
    );
    assert.equal(
      isAppSchemeRequestAllowed(
        request('chiagaming://app/oauth/callback/', {
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        }),
      ),
      true,
    );
    assert.equal(
      isAppSchemeRequestAllowed(
        request('chiagaming://app/oauth/callback', {
          'sec-fetch-site': 'cross-site',
          'sec-fetch-mode': 'no-cors',
          'sec-fetch-dest': 'image',
        }),
      ),
      false,
    );
  });

  it('uses initiator metadata when Fetch Metadata is unavailable', () => {
    assert.equal(
      isAppSchemeRequestAllowed(
        request('chiagaming://app/index.js', {}, 'chiagaming://app/index.html'),
      ),
      true,
    );
    assert.equal(
      isAppSchemeRequestAllowed(
        request('chiagaming://app/index.js', {}, 'https://malicious-hub.example/'),
      ),
      false,
    );
    assert.equal(
      isAppSchemeRequestAllowed(
        request('chiagaming://app/index.html', {
          'sec-fetch-mode': 'navigate',
          'sec-fetch-dest': 'document',
        }),
      ),
      true,
    );
    assert.equal(isAppSchemeRequestAllowed(request('chiagaming://app/index.html', {})), true);
    assert.equal(isAppSchemeRequestAllowed(request('chiagaming://app/index.js', {})), true);
  });
});
