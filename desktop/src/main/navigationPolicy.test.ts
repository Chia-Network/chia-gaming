import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isNavigationAllowed } from './navigationPolicy.ts';
import type { NetworkPolicy } from './networkPolicy.ts';

const policy: NetworkPolicy = {
  allowedRequestOrigins: new Set(),
  hubOrigins: new Set(['https://frames.example']),
  allowedFrameOrigins: new Set(['https://frames.example']),
  cloudWalletOrigins: new Set(['https://wallet.example']),
  contentSecurityPolicy: '',
  hubContentSecurityPolicy: '',
  hubConnectionAllowlist: '',
};

describe('desktop navigation policy', () => {
  it('keeps the player top frame on the canonical app document', () => {
    assert.equal(isNavigationAllowed('chiagaming://app/index.html', true, policy, true), true);
    assert.equal(isNavigationAllowed('about:blank', true, policy, true), false);
    assert.equal(isNavigationAllowed('chiagaming://app/oauth/callback', true, policy, true), false);
    assert.equal(
      isNavigationAllowed('https://wallet.example/authorize', true, policy, true),
      false,
    );
  });

  it('keeps other top-level windows on app documents and frames on allowed origins', () => {
    assert.equal(isNavigationAllowed('about:blank', true, policy, false), true);
    assert.equal(isNavigationAllowed('chiagaming://app/about.html', true, policy, false), true);
    // Cloud Wallet pages open in the system browser, never in an app window.
    assert.equal(
      isNavigationAllowed('https://wallet.example/authorize', true, policy, false),
      false,
    );
    assert.equal(isNavigationAllowed('https://frames.example/embed', false, policy, true), true);
    assert.equal(isNavigationAllowed('chiagaming://app/about.html', false, policy, true), false);
  });
});
