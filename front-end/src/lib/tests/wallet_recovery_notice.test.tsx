import 'fake-indexeddb/auto';

import React from 'react';
import { act, create, type ReactTestRenderer } from 'react-test-renderer';
import WalletRecoveryNotice from '../../components/WalletRecoveryNotice';
import { channelFundingRuntime } from '../session/channelFundingRuntime';
import { walletRecoveryNotice } from '../session/channelFundingSelectors';
import type { FeeAttachment } from '../session/feeAttachmentStore';
import { providerScopeKey } from '../session/providerKeys';
import { storageRepository } from '../session/storageRepository';

const scope = {
  provider: 'walletconnect' as const,
  fingerprint: '123456',
  chainId: 'chia:mainnet',
};
const owner = { installationPlayerId: 'player', peerSessionId: 'finished', providerScope: scope };
const fee: FeeAttachment = {
  owner,
  submissionId: 'fee-1',
  stage: 'cancel-required',
  providerReservationId: 'trade-1',
  reason: 'fee-submission-retired',
};

describe('wallet recovery notice after changing wallets', () => {
  let renderer: ReactTestRenderer | null = null;

  beforeEach(async () => {
    storageRepository._resetForTests();
    channelFundingRuntime.resetForTests();
    await storageRepository.claimApplicationState();
    storageRepository.patchApplicationState((state) => ({
      ...state,
      session: null,
      walletContext: scope,
      channelFundingOperations: [],
      feeAttachments: [],
    }));
  });

  afterEach(async () => {
    await act(async () => renderer?.unmount());
    renderer = null;
    await storageRepository.checkpointDomainMutations();
    channelFundingRuntime.resetForTests();
  });

  async function mount() {
    await act(async () => {
      renderer = create(<WalletRecoveryNotice />);
    });
  }

  it('does not call ordinary reserved or replayable offers pending cleanup', () => {
    expect(
      walletRecoveryNotice(
        [
          { ...fee, stage: 'reserved' },
          { ...fee, stage: 'retained-for-replay' },
        ],
        new Set([providerScopeKey({ provider: 'cloud', walletId: 'different-wallet' })]),
      ),
    ).toBeNull();
    expect(
      walletRecoveryNotice(
        [
          {
            owner,
            purpose: { kind: 'funding', operationId: 'funding' },
            stage: 'awaiting-channel',
            providerReservationId: 'funding-trade',
            request: { kind: 'funding', canonical: { amount: '100', fee: '0', conditions: [] } },
            reason: 'offer-created',
          },
        ],
        new Set(),
      ),
    ).toBeNull();
  });

  it('clears immediately when fee cleanup finishes without a funding or provider event', async () => {
    storageRepository.replaceFeeAttachments([fee]);
    await mount();
    expect(JSON.stringify(renderer!.toJSON())).toContain('1 offer cancellation');
    await act(async () => storageRepository.replaceFeeAttachments([]));
    expect(renderer!.toJSON()).toBeNull();
  });

  it('does not show a recovery warning just because a previous wallet retained a fee offer', async () => {
    const original = {
      capability: 'best-effort' as const,
      scope,
      beginCreation: jest.fn(),
      cancel: jest.fn(),
    };
    const cloud = {
      ...original,
      scope: { provider: 'cloud' as const, walletId: 'cloud-wallet' },
    };
    storageRepository.replaceFeeAttachments([{ ...fee, stage: 'retained-for-replay' }]);
    channelFundingRuntime.attachProvider(original);
    await mount();
    expect(renderer!.toJSON()).toBeNull();
    await act(async () => {
      channelFundingRuntime.detachProvider(original);
      channelFundingRuntime.attachProvider(cloud);
    });
    expect(renderer!.toJSON()).toBeNull();
    expect(storageRepository.feeAttachments()).toHaveLength(1);
  });

  it('dismisses the reminder without discarding cleanup and shows new obligations', async () => {
    storageRepository.replaceFeeAttachments([fee]);
    await mount();
    await act(async () => renderer!.root.findByType('button').props.onClick());
    expect(renderer!.toJSON()).toBeNull();
    expect(storageRepository.feeAttachments()).toEqual([fee]);
    await act(async () =>
      storageRepository.replaceFeeAttachments([
        { ...fee, stage: 'cancelling', recoveryId: 'cancel-1' },
      ]),
    );
    expect(renderer!.toJSON()).toBeNull();
    await act(async () =>
      storageRepository.replaceFeeAttachments([{ ...fee, submissionId: 'fee-2' }]),
    );
    expect(JSON.stringify(renderer!.toJSON())).toContain('1 offer cancellation');
  });

  it('only counts requests that need a missing original account', () => {
    const connected = new Set([providerScopeKey(scope)]);
    expect(walletRecoveryNotice([fee], connected)).toBeNull();
    const uncertain: FeeAttachment = {
      owner,
      submissionId: 'unknown-fee',
      stage: 'best-effort-uncertain',
      disposition: 'active',
      request: {
        kind: 'fee',
        uniqueId: 'unknown-fee',
        fee: 10n,
        concurrentSpendCoinId: 'ab'.repeat(32),
      },
      lastAttemptEpoch: 1n,
      reason: 'response-lost',
    };
    expect(walletRecoveryNotice([fee, uncertain], new Set())?.message).toContain(
      '1 offer cancellation and 1 unfinished wallet request',
    );
  });
});
