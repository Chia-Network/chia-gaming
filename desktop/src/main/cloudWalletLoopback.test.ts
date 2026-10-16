import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  isAuthorizeUrlForCallback,
  isCloudWalletTokenUrl,
  parseCallbackRequest,
  startLoopbackCallback,
} from './cloudWalletLoopback.ts';

const WALLET = 'https://wallet.example';

describe('Cloud Wallet loopback sign-in', () => {
  it('reads the code and state, or the error, from the callback path only', () => {
    assert.deepEqual(parseCallbackRequest('/oauth/callback?code=abc&state=xyz'), {
      code: 'abc',
      state: 'xyz',
    });
    assert.deepEqual(
      parseCallbackRequest('/oauth/callback?error=access_denied&error_description=nope'),
      { error: 'access_denied: nope' },
    );
    assert.deepEqual(parseCallbackRequest('/oauth/callback?code=abc'), {
      error: 'Missing authorization code or state',
    });
    assert.equal(parseCallbackRequest('/favicon.ico'), null);
  });

  it('only opens authorize URLs on allowed origins that return to this callback', () => {
    const redirect = 'http://127.0.0.1:4321/oauth/callback';
    const allowed = new Set([WALLET]);
    const authorize = (origin: string, redirectUri: string) =>
      `${origin}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}`;

    assert.ok(isAuthorizeUrlForCallback(authorize(WALLET, redirect), redirect, allowed));
    assert.ok(
      !isAuthorizeUrlForCallback(authorize('https://evil.example', redirect), redirect, allowed),
    );
    assert.ok(
      !isAuthorizeUrlForCallback(
        authorize(WALLET, 'http://127.0.0.1:9999/oauth/callback'),
        redirect,
        allowed,
      ),
    );
    assert.ok(!isAuthorizeUrlForCallback('not a url', redirect, allowed));
  });

  it('relays token requests only to the token endpoint of an allowed origin', () => {
    const allowed = new Set([WALLET]);
    assert.ok(isCloudWalletTokenUrl(`${WALLET}/token`, allowed));
    assert.ok(!isCloudWalletTokenUrl('https://evil.example/token', allowed));
    assert.ok(!isCloudWalletTokenUrl(`${WALLET}/graphql`, allowed));
    assert.ok(!isCloudWalletTokenUrl(`${WALLET}/token?x=1`, allowed));
    assert.ok(
      !isCloudWalletTokenUrl('http://wallet.example/token', new Set(['http://wallet.example'])),
    );
  });

  it('serves exactly one callback on an ephemeral 127.0.0.1 port', async () => {
    let focused = 0;
    const callback = await startLoopbackCallback(10_000, () => {
      focused += 1;
    });
    assert.match(callback.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);

    const miss = await fetch(new URL('/favicon.ico', callback.redirectUri));
    assert.equal(miss.status, 404);

    const response = await fetch(`${callback.redirectUri}?code=the-code&state=the-state`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /return to Chia Gaming/);
    assert.deepEqual(await callback.result, { code: 'the-code', state: 'the-state' });
    assert.equal(focused, 1);

    await assert.rejects(fetch(`${callback.redirectUri}?code=again&state=again`));
  });

  it('gives up after the timeout and when cancelled', async () => {
    const timedOut = await startLoopbackCallback(20);
    assert.deepEqual(await timedOut.result, { error: 'Cloud Wallet sign-in timed out' });

    const cancelled = await startLoopbackCallback(10_000);
    cancelled.close();
    assert.deepEqual(await cancelled.result, { error: 'Cloud Wallet sign-in was cancelled' });
  });
});
