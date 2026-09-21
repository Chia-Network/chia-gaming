import 'fake-indexeddb/auto';
import type { WalletOfferProvider } from '../../types/ChiaGaming';
import { storageRepository } from '../session/storageRepository';
import { walletOperationRuntime } from '../session/walletOperationRuntime';
import type { WalletOperationEntry, WalletOperationOwner } from '../session/walletOperationStore';
import { installReservedWalletObligation } from './wallet_operation_test_helpers';

const owner: WalletOperationOwner = {
  installationPlayerId: 'player',
  peerSessionId: 'session',
  providerScope: { provider: 'cloud', walletId: 'Wallet_1' },
};
const purpose = { kind: 'funding' as const, operationId: 'funding-op' };
const recoveryRequest = {
  kind: 'funding' as const,
  canonical: { amount: '100', fee: '0', conditions: [] },
};
const providerRequest = {
  kind: 'funding' as const,
  uniqueId: owner.installationPlayerId,
  offer: { '1': -100n },
  extraConditions: [],
  openingFee: 0n,
};

function installWallet(entries: WalletOperationEntry[]): void {
  storageRepository._replaceApplicationStateForTests({
    ...storageRepository.loadState(),
    walletContext: owner.providerScope,
    walletObligations: entries,
  });
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(check()).toBe(true);
}

describe('aggregate wallet offer lifecycle', () => {
  beforeEach(async () => {
    storageRepository._resetForTests();
    walletOperationRuntime.resetForTests();
    await storageRepository.claimApplicationState();
    const empty = {
      ...storageRepository.loadState(),
      session: null,
      walletContext: owner.providerScope,
      walletObligations: [],
    };
    storageRepository._replaceApplicationStateForTests(empty);
    await storageRepository.checkpointApplicationState(empty);
  });

  afterEach(() => walletOperationRuntime.resetForTests());

  it.each([
    {
      label: 'exact creation',
      entry: {
        owner,
        purpose,
        stage: 'creating' as const,
        disposition: 'active' as const,
        recoveryId: 'SR_reload_create',
        request: recoveryRequest,
        reason: 'pending',
      },
      expectedStage: 'creating',
    },
    {
      label: 'pre-id creation uncertainty',
      entry: {
        owner,
        purpose,
        stage: 'best-effort-uncertain' as const,
        disposition: 'active' as const,
        request: recoveryRequest,
        generation: 1n,
        lastAttemptEpoch: 1n,
        reason: 'response-lost',
        orphanRisk: 'pre-id-response-lost' as const,
      },
      expectedStage: 'best-effort-uncertain',
    },
    {
      label: 'unlaunched cancellation',
      entry: {
        owner,
        purpose,
        stage: 'cancel-required' as const,
        tradeId: 'Offer_reload_required',
        reason: 'cleanup',
      },
      expectedStage: 'cancel-required',
    },
    {
      label: 'pre-id cancellation uncertainty',
      entry: {
        owner,
        purpose,
        stage: 'best-effort-cancellation-uncertain' as const,
        tradeId: 'Offer_reload_uncertain',
        generation: 1n,
        lastAttemptEpoch: 1n,
        reason: 'response-lost',
      },
      expectedStage: 'best-effort-cancellation-uncertain',
    },
    {
      label: 'exact cancellation',
      entry: {
        owner,
        purpose,
        stage: 'cancelling' as const,
        tradeId: 'Offer_reload_cancelling',
        recoveryId: 'SR_reload_cancel',
        reason: 'pending',
      },
      expectedStage: 'cancelling',
    },
  ])('reloads $label from the whole aggregate', async ({ entry, expectedStage }) => {
    installWallet([entry]);
    await storageRepository.checkpointApplicationState(storageRepository.loadState());

    storageRepository._resetForTests();
    walletOperationRuntime.resetForTests();
    const claimed = await storageRepository.claimApplicationState();

    expect(claimed.walletObligations).toEqual([expect.objectContaining({ stage: expectedStage })]);
    expect(storageRepository.walletObligations()).toEqual(claimed.walletObligations);
  });

  it('checkpoints a Cloud recovery id before exact reconciliation', async () => {
    let resolveReconcile!: (value: { kind: 'unavailable'; reason: string }) => void;
    const reconcile = new Promise<{ kind: 'unavailable'; reason: string }>((resolve) => {
      resolveReconcile = resolve;
    });
    const provider: WalletOfferProvider = {
      capability: 'recoverable',
      scope: owner.providerScope,
      beginCreation: jest.fn().mockResolvedValue({ kind: 'pending', recoveryId: 'SR_exact' }),
      reconcileCreation: jest.fn(() => reconcile),
      beginCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' }),
      reconcileCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    walletOperationRuntime.attachProvider(provider);

    const creation = walletOperationRuntime.createOffer(
      owner,
      purpose,
      providerRequest,
      recoveryRequest,
    );
    await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);
    expect(storageRepository.walletObligations()).toEqual([
      expect.objectContaining({ stage: 'creating', recoveryId: 'SR_exact' }),
    ]);
    expect((await storageRepository.inspect()).applicationState?.walletObligations).toEqual([
      expect.objectContaining({ stage: 'creating', recoveryId: 'SR_exact' }),
    ]);

    resolveReconcile({ kind: 'unavailable', reason: 'offline' });
    await expect(creation).resolves.toEqual({ kind: 'unavailable', reason: 'offline' });
  });

  it('retries pre-id uncertainty once on a later readiness epoch', async () => {
    const beginCreation = jest
      .fn()
      .mockRejectedValueOnce(new Error('response lost'))
      .mockResolvedValueOnce({
        kind: 'created-reserved',
        material: { kind: 'offer', offer: 'offer1replacement' },
        tradeId: 'replacement',
      });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation,
      cancel: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    walletOperationRuntime.attachProvider(provider);

    await expect(
      walletOperationRuntime.createOffer(owner, purpose, providerRequest, recoveryRequest),
    ).resolves.toMatchObject({ kind: 'unavailable' });
    expect(beginCreation).toHaveBeenCalledTimes(1);
    expect(storageRepository.walletObligations()).toEqual([
      expect.objectContaining({
        stage: 'best-effort-uncertain',
        orphanRisk: 'pre-id-response-lost',
      }),
    ]);

    await Promise.resolve();
    expect(beginCreation).toHaveBeenCalledTimes(1);
    walletOperationRuntime.providerReconnectReady(provider);
    await waitFor(() => beginCreation.mock.calls.length === 2);
    expect(beginCreation).toHaveBeenCalledTimes(2);
    expect(storageRepository.walletObligations()).toEqual([
      expect.objectContaining({
        stage: 'reserved',
        tradeId: 'replacement',
        orphanRisk: 'pre-id-response-lost',
      }),
    ]);
  });

  it('checkpoints cancellation recovery before exact completion', async () => {
    let resolveCancellation!: (value: { status: 'cancelled' }) => void;
    const cancellation = new Promise<{ status: 'cancelled' }>((resolve) => {
      resolveCancellation = resolve;
    });
    installWallet([
      {
        owner,
        purpose,
        stage: 'cancel-required',
        tradeId: 'Offer_cancel',
        reason: 'cleanup',
      },
    ]);
    const provider: WalletOfferProvider = {
      capability: 'recoverable-after-begin',
      scope: owner.providerScope,
      beginCreation: jest.fn(),
      reconcileCreation: jest.fn(),
      beginCancellation: jest
        .fn()
        .mockResolvedValue({ status: 'pending', recoveryId: 'SR_cancel' }),
      reconcileCancellation: jest.fn(() => cancellation),
    };
    walletOperationRuntime.attachProvider(provider);
    await waitFor(() => provider.reconcileCancellation.mock.calls.length === 1);

    expect(storageRepository.walletObligations()).toEqual([
      expect.objectContaining({
        stage: 'cancelling',
        tradeId: 'Offer_cancel',
        recoveryId: 'SR_cancel',
      }),
    ]);
    expect((await storageRepository.inspect()).applicationState?.walletObligations).toEqual([
      expect.objectContaining({ stage: 'cancelling', recoveryId: 'SR_cancel' }),
    ]);

    resolveCancellation({ status: 'cancelled' });
    await walletOperationRuntime.awaitOwner(owner);
    expect(storageRepository.walletObligations()).toEqual([]);
  });

  it('fences a stale response and transfers cleanup after authority reclaim', async () => {
    let resolveCreation!: (value: {
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }) => void;
    const creationResponse = new Promise<{
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }>((resolve) => {
      resolveCreation = resolve;
    });
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation: jest.fn(() => creationResponse),
      cancel,
    };
    const scoped = {
      ...storageRepository.loadState(),
      walletContext: owner.providerScope,
    };
    storageRepository._replaceApplicationStateForTests(scoped);
    await storageRepository.checkpointApplicationState(scoped);
    walletOperationRuntime.attachProvider(provider);
    const creation = walletOperationRuntime.createOffer(
      owner,
      purpose,
      providerRequest,
      recoveryRequest,
    );
    await waitFor(() => provider.beginCreation.mock.calls.length === 1);

    storageRepository.loseAuthority('takeover');
    resolveCreation({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1stale' },
      tradeId: 'stale-trade',
    });
    await expect(creation).resolves.toMatchObject({ kind: 'unavailable' });
    expect(cancel).not.toHaveBeenCalled();

    await storageRepository.claimApplicationState();
    walletOperationRuntime.attachProvider(provider);
    expect(storageRepository.walletObligations()).toEqual([
      expect.objectContaining({ tradeId: 'stale-trade', stage: 'cancel-required' }),
    ]);
    await waitFor(() => cancel.mock.calls.length === 1);
    await walletOperationRuntime.awaitOwner(owner);
    expect(cancel).toHaveBeenCalledWith('stale-trade');
    expect(storageRepository.walletObligations()).toEqual([]);
  });

  it('does not call a provider under aggregate scope mismatch', async () => {
    installWallet([
      {
        owner,
        purpose,
        stage: 'cancel-required',
        tradeId: 'Offer_original',
        reason: 'cleanup',
      },
    ]);
    const cancel = jest.fn();
    walletOperationRuntime.attachProvider({
      capability: 'best-effort',
      scope: { provider: 'cloud', walletId: 'Wallet_2' },
      beginCreation: jest.fn(),
      cancel,
    });
    walletOperationRuntime.retryCancelRequired(owner);
    await Promise.resolve();
    expect(cancel).not.toHaveBeenCalled();
    expect(storageRepository.walletObligations()).toHaveLength(1);
  });

  it('keeps replay fee ownership until explicit cleanup', () => {
    installReservedWalletObligation('Offer_fee', owner, {
      kind: 'fee',
      operationId: 'submission',
    });
    walletOperationRuntime.settleTrade(
      'Offer_fee',
      'retained-for-replay',
      'wallet-delivery-acknowledged',
    );
    walletOperationRuntime.retireSession('player', 'session', 'controller-retired');
    expect(storageRepository.walletObligations()).toEqual([
      expect.objectContaining({ stage: 'retained-for-replay', tradeId: 'Offer_fee' }),
    ]);

    walletOperationRuntime.settleTrade('Offer_fee', 'cancel-required', 'submission-retired');
    expect(storageRepository.walletObligations()).toEqual([
      expect.objectContaining({ stage: 'cancel-required', tradeId: 'Offer_fee' }),
    ]);
  });
});
