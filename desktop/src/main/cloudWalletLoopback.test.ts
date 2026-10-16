import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseCallbackRequest, startLoopbackCallback } from './cloudWalletLoopback.ts';

describe('Cloud Wallet loopback sign-in', () => {
  it('reads the code, state, or error from the callback path only', () => {
    assert.deepEqual(parseCallbackRequest('/oauth/callback?code=abc&state=xyz'), {
      state: 'xyz',
      outcome: { code: 'abc', state: 'xyz' },
    });
    assert.deepEqual(
      parseCallbackRequest('/oauth/callback?error=access_denied&error_description=nope&state=xyz'),
      { state: 'xyz', outcome: { error: 'access_denied: nope' } },
    );
    assert.deepEqual(parseCallbackRequest('/oauth/callback?code=abc'), {
      state: null,
      outcome: { error: 'Missing authorization code or state' },
    });
    assert.equal(parseCallbackRequest('/favicon.ico'), null);
  });

  it('settles only on a callback carrying the expected state, then closes', async () => {
    let focused = 0;
    const callback = await startLoopbackCallback(10_000, () => {
      focused += 1;
    });
    assert.match(callback.redirectUri, /^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/);

    // Before the authorize URL is opened, nothing is expected.
    const early = await fetch(`${callback.redirectUri}?code=early&state=the-state`);
    assert.equal(early.status, 400);

    callback.expectState('the-state');
    assert.equal((await fetch(new URL('/favicon.ico', callback.redirectUri))).status, 404);
    const forged = await fetch(`${callback.redirectUri}?code=forged&state=other`);
    assert.equal(forged.status, 400);

    const response = await fetch(`${callback.redirectUri}?code=the-code&state=the-state`);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /return to Chia Gaming/);
    assert.deepEqual(await callback.result, { code: 'the-code', state: 'the-state' });
    assert.equal(focused, 1);

    await assert.rejects(fetch(`${callback.redirectUri}?code=again&state=the-state`));
  });

  it('reports an error redirect for this sign-in', async () => {
    const callback = await startLoopbackCallback(10_000);
    callback.expectState('s');
    const response = await fetch(`${callback.redirectUri}?error=access_denied&state=s`);
    assert.equal(response.status, 400);
    assert.deepEqual(await callback.result, { error: 'access_denied' });
  });

  it('gives up after the timeout and when cancelled', async () => {
    const timedOut = await startLoopbackCallback(20);
    assert.deepEqual(await timedOut.result, { error: 'Cloud Wallet sign-in timed out' });

    const cancelled = await startLoopbackCallback(10_000);
    cancelled.close();
    assert.deepEqual(await cancelled.result, { error: 'Cloud Wallet sign-in was cancelled' });
  });
});
