import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';

function setTestGlobal(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}

const stored = new Map<string, string>();
const storage = {
  getItem: (key: string) => stored.get(key) ?? null,
  setItem: (key: string, value: string) => void stored.set(key, value),
  removeItem: (key: string) => void stored.delete(key),
};
setTestGlobal('localStorage', storage);
setTestGlobal('sessionStorage', storage);
setTestGlobal('window', globalThis);

import CloudWalletCancellationNotice from '../../components/CloudWalletCancellationNotice';
import { cloudBlockchainInfo } from '../wallet/CloudBlockchainInterface';
import { saveCloudWalletAuth } from '../wallet/cloudWalletAuth';

const offerId = `Offer_${'ab'.repeat(32)}`;
const reason = 'Organization does not have required feature flags: OFFER_CANCEL_OFF_CHAIN';

describe('CloudWalletCancellationNotice', () => {
  let renderer: ReactTestRenderer;

  beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    saveCloudWalletAuth({
      accessToken: 'access-token',
      refreshToken: 'refresh-token',
      expiresAt: Date.now() + 10 * 60_000,
      walletId: 'Wallet_1',
    });
    await cloudBlockchainInfo.beginConnect('player');
    setTestGlobal(
      'fetch',
      jest.fn(async () => ({
        status: 200,
        ok: true,
        text: async () =>
          JSON.stringify({
            data: { cancelOffer: null },
            errors: [{ message: reason, extensions: { code: 'UNAUTHORIZED' } }],
          }),
      })),
    );
    act(() => {
      renderer = create(<CloudWalletCancellationNotice />);
    });
  });

  afterEach(() => {
    act(() => renderer.unmount());
    cloudBlockchainInfo.dismissRefusedCancellation(offerId);
    setTestGlobal('fetch', undefined);
  });

  it('shows the offer, the wallet reason, and what to do, until dismissed', async () => {
    expect(renderer.toJSON()).toBeNull();

    await act(async () => {
      await cloudBlockchainInfo.beginWalletOfferCancellation(offerId);
    });
    const text = JSON.stringify(renderer.toJSON());
    expect(text).toContain(offerId);
    expect(text).toContain(reason);
    expect(text).toContain('Cancel the offer in Cloud Wallet');

    act(() =>
      renderer.root.findByProps({ 'aria-label': 'Dismiss refused cancellation' }).props.onClick(),
    );
    expect(renderer.toJSON()).toBeNull();

    await act(async () => {
      await cloudBlockchainInfo.beginWalletOfferCancellation(offerId);
    });
    expect(JSON.stringify(renderer.toJSON())).toContain(reason);
  });
});
