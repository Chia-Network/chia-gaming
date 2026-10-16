import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  authorizeRequestState,
  cloudWalletUrl,
  isCloudWalletTokenUrl,
} from './cloudWalletPolicy.ts';

const WALLET = 'https://wallet.example';
const ORIGINS = new Set([WALLET]);

describe('Cloud Wallet URL policy', () => {
  it('accepts only https URLs on configured Cloud Wallet origins', () => {
    assert.equal(cloudWalletUrl(`${WALLET}/approve`, ORIGINS)?.pathname, '/approve');
    assert.equal(cloudWalletUrl('https://evil.example/approve', ORIGINS), null);
    assert.equal(
      cloudWalletUrl('http://wallet.example/approve', new Set(['http://wallet.example'])),
      null,
    );
    assert.equal(cloudWalletUrl('not a url', ORIGINS), null);
    assert.equal(cloudWalletUrl(42, ORIGINS), null);
  });

  it('opens authorize URLs only for this sign-in, returning their state', () => {
    const redirect = 'http://127.0.0.1:4321/oauth/callback';
    const authorize = (origin: string, redirectUri: string, state = 'xyz') =>
      `${origin}/authorize?redirect_uri=${encodeURIComponent(redirectUri)}&state=${state}`;

    assert.equal(authorizeRequestState(authorize(WALLET, redirect), redirect, ORIGINS), 'xyz');
    assert.equal(
      authorizeRequestState(authorize('https://evil.example', redirect), redirect, ORIGINS),
      null,
    );
    assert.equal(
      authorizeRequestState(
        authorize(WALLET, 'http://127.0.0.1:9999/oauth/callback'),
        redirect,
        ORIGINS,
      ),
      null,
    );
    assert.equal(authorizeRequestState(authorize(WALLET, redirect, ''), redirect, ORIGINS), null);
  });

  it('relays token requests only to the token endpoint', () => {
    assert.ok(isCloudWalletTokenUrl(`${WALLET}/token`, ORIGINS));
    assert.ok(!isCloudWalletTokenUrl('https://evil.example/token', ORIGINS));
    assert.ok(!isCloudWalletTokenUrl(`${WALLET}/graphql`, ORIGINS));
    assert.ok(!isCloudWalletTokenUrl(`${WALLET}/token?x=1`, ORIGINS));
  });
});
