import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { isNavigationAllowed } from './navigationPolicy.ts';
import type { NetworkPolicy } from './networkPolicy.ts';

const policy: NetworkPolicy = {
  allowedRequestOrigins: new Set(),
  allowedFrameOrigins: new Set(['https://frames.example']),
  allowedPopupOrigins: new Set(['https://wallet.example']),
  contentSecurityPolicy: '',
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

  it('preserves popup and sub-frame allowances outside the player top frame', () => {
    assert.equal(isNavigationAllowed('about:blank', true, policy, false), true);
    assert.equal(isNavigationAllowed('chiagaming://app/oauth/callback', true, policy, false), true);
    assert.equal(
      isNavigationAllowed('https://wallet.example/authorize', true, policy, false),
      true,
    );
    assert.equal(isNavigationAllowed('https://frames.example/embed', false, policy, true), true);
    assert.equal(isNavigationAllowed('chiagaming://app/about.html', false, policy, true), false);
  });
});
