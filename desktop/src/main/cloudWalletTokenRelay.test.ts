import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { relayCloudWalletToken } from './cloudWalletTokenRelay.ts';

const TOKEN_URL = 'https://wallet.example/token';
const BODIES = [
  'grant_type=authorization_code&code=secret-code',
  'grant_type=refresh_token&refresh_token=secret-refresh',
];

describe('Cloud Wallet token relay', () => {
  for (const body of BODIES) {
    it(`returns a direct response for ${new URLSearchParams(body).get('grant_type')}`, async () => {
      const calls: Array<{ url: string; init: RequestInit }> = [];
      const result = await relayCloudWalletToken(TOKEN_URL, body, async (url, init) => {
        calls.push({ url, init });
        return { status: 200, text: async () => '{"access_token":"ok"}' };
      });

      assert.deepEqual(result, { status: 200, text: '{"access_token":"ok"}' });
      assert.equal(calls.length, 1);
      assert.equal(calls[0].url, TOKEN_URL);
      assert.equal(calls[0].init.body, body);
      assert.equal(calls[0].init.redirect, 'error');
    });

    it(`stops a redirect for ${new URLSearchParams(body).get('grant_type')}`, async () => {
      const requests: string[] = [];
      const result = await relayCloudWalletToken(TOKEN_URL, body, async (url, init) => {
        requests.push(url);
        if (init.redirect === 'error') throw new TypeError('redirect blocked');
        requests.push('https://other.example/token');
        return { status: 200, text: async () => 'redirected' };
      });

      assert.deepEqual(result, { transportError: 'redirect blocked' });
      assert.deepEqual(requests, [TOKEN_URL]);
    });
  }
});
