import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { BoundedAssetReader, isAppSchemeRequestAllowed } from './appProtocolPolicy.ts';

function request(
  url: string,
  headers: Record<string, string>,
  referrer = '',
): { url: string; headers: Headers; referrer: string } {
  return { url, headers: new Headers(headers), referrer };
}

describe('app protocol policy', () => {
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
    assert.equal(isAppSchemeRequestAllowed(request('chiagaming://app/index.js', {})), false);
  });

  it('coalesces repeated asset reads and limits distinct reads', async () => {
    let activeReads = 0;
    let maximumActiveReads = 0;
    let readCount = 0;
    const releases: Array<() => void> = [];
    const reader = new BoundedAssetReader(async () => {
      readCount += 1;
      activeReads += 1;
      maximumActiveReads = Math.max(maximumActiveReads, activeReads);
      await new Promise<void>((resolve) => releases.push(resolve));
      activeReads -= 1;
      return Uint8Array.of(1);
    });

    const reads = [
      ...Array.from({ length: 16 }, () => reader.readAsset('/same.wasm')),
      ...Array.from({ length: 8 }, (_, index) => reader.readAsset(`/${index}.js`)),
    ];
    await new Promise<void>((resolve) => setImmediate(resolve));
    while (releases.length > 0 || activeReads > 0) {
      releases.splice(0).forEach((release) => release());
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await Promise.all(reads);

    assert.equal(readCount, 9);
    assert.equal(maximumActiveReads, 4);
  });
});
