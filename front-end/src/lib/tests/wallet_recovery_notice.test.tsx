import { WalletConnection } from '../wallet/WalletConnection';
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
const request: FeeAttachment = {
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

describe('wallet recovery notice after changing wallets', () => {
  let renderer: ReactTestRenderer | null = null;
  let stop: (() => void) | undefined;

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
    stop?.();
    await storageRepository.checkpointDomainMutations();
    channelFundingRuntime.resetForTests();
  });

  async function mount() {
    await act(async () => {
      const wallet = new WalletConnection('test', (event) => {
        if (event.type === 'view' && renderer)
          renderer.update(<WalletRecoveryNotice notice={event.view.recoveryNotice} />);
      });
      stop = wallet.start();
      renderer = create(<WalletRecoveryNotice notice={wallet.view.recoveryNotice} />);
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

  it('clears immediately when an unfinished request retires without a funding or provider event', async () => {
    storageRepository.replaceFeeAttachments([request]);
    await mount();
    expect(JSON.stringify(renderer!.toJSON())).toContain('1 unfinished wallet request');
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

  it('dismisses the reminder without discarding requests and shows new requests', async () => {
    storageRepository.replaceFeeAttachments([request]);
    await mount();
    await act(async () => renderer!.root.findByType('button').props.onClick());
    expect(renderer!.toJSON()).toBeNull();
    expect(storageRepository.feeAttachments()).toEqual([request]);
    await act(async () =>
      storageRepository.replaceFeeAttachments([{ ...request, lastAttemptEpoch: 2n }]),
    );
    expect(renderer!.toJSON()).toBeNull();
    await act(async () =>
      storageRepository.replaceFeeAttachments([{ ...request, submissionId: 'fee-2' }]),
    );
    expect(JSON.stringify(renderer!.toJSON())).toContain('1 unfinished wallet request');
  });

  it('does not ask for the old wallet to perform best-effort cancellation', () => {
    expect(
      walletRecoveryNotice(
        [
          fee,
          { ...fee, stage: 'cancelling', recoveryId: 'cancel-1' },
          { ...fee, stage: 'best-effort-cancellation-uncertain', lastAttemptEpoch: 1n },
          { ...request, disposition: 'cancel-on-create' },
        ],
        new Set(),
      ),
    ).toBeNull();
  });

  it('only counts requests that need a missing original account', () => {
    const connected = new Set([providerScopeKey(scope)]);
    expect(walletRecoveryNotice([fee], connected)).toBeNull();
    expect(walletRecoveryNotice([request], connected)).toBeNull();
    expect(walletRecoveryNotice([fee, request], new Set())?.message).toContain(
      '1 unfinished wallet request',
    );
  });
});
