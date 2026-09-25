import 'fake-indexeddb/auto';
import type { WalletOfferProvider } from '../../types/ChiaGaming';
import { FeeAttachmentRuntime } from '../session/feeAttachmentRuntime';
import type { FeeAttachment, FeeAttachmentOwner } from '../session/feeAttachmentStore';
import { StorageAuthorityLostError } from '../session/indexedDb';
import { storageRepository } from '../session/storageRepository';
import { WalletProviderRegistry } from '../session/walletProviderRegistry';

function makeStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    key: (index) => [...values.keys()][index] ?? null,
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => void values.set(key, String(value)),
    removeItem: (key) => void values.delete(key),
    clear: () => values.clear(),
  };
}

const owner: FeeAttachmentOwner = {
  installationPlayerId: 'player',
  peerSessionId: 'session',
  providerScope: {
    provider: 'walletconnect',
    fingerprint: '123456',
    chainId: 'chia:testnet11',
  },
};
const request = {
  kind: 'fee' as const,
  uniqueId: 'submission',
  fee: 10n,
  concurrentSpendCoinId: 'ab'.repeat(32),
};

function install(entries: FeeAttachment[]): void {
  storageRepository._replaceApplicationStateForTests({
    ...storageRepository.loadState(),
    walletContext: owner.providerScope,
    channelFundingOperations: [],
    feeAttachments: entries,
  });
}

function ports() {
  return {
    isRetired: () => false,
    getOwner: () => owner,
    requestCommit: jest.fn(),
    reportWarning: jest.fn(),
  };
}

async function waitFor(check: () => boolean): Promise<void> {
  for (let attempt = 0; attempt < 30 && !check(); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(check()).toBe(true);
}

describe('FeeAttachmentRuntime lifecycle', () => {
  beforeEach(async () => {
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: makeStorage(),
    });
    storageRepository._resetForTests();
    await storageRepository.claimApplicationState();
    const empty = {
      ...storageRepository.loadState(),
      walletContext: owner.providerScope,
      channelFundingOperations: [],
      feeAttachments: [],
    };
    storageRepository._replaceApplicationStateForTests(empty);
    await storageRepository.write(storageRepository.patchApplicationState(() => empty));
  });

  it('attempts restored creation uncertainty once in the first process readiness epoch', async () => {
    install([
      {
        owner,
        submissionId: 'restored-create',
        stage: 'best-effort-uncertain',
        disposition: 'active',
        request,
        lastAttemptEpoch: 99n,
        reason: 'response-lost',
        orphanRisk: 'pre-id-response-lost',
      },
    ]);
    const beginCreation = jest.fn().mockResolvedValue({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1replacement' },
      tradeId: 'replacement-trade',
    });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation,
      cancel: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(ports(), providers);

    await runtime.awaitIdle();
    expect(beginCreation).toHaveBeenCalledTimes(1);
    expect(storageRepository.feeAttachments()).toEqual([
      expect.objectContaining({
        submissionId: 'restored-create',
        stage: 'reserved',
        providerReservationId: 'replacement-trade',
      }),
    ]);

    providers.ready(provider);
    await runtime.awaitIdle();
    expect(beginCreation).toHaveBeenCalledTimes(1);
    runtime.detach();
  });

  it('attempts restored cancellation uncertainty once in the first process readiness epoch', async () => {
    install([
      {
        owner,
        submissionId: 'restored-cancel',
        stage: 'best-effort-cancellation-uncertain',
        providerReservationId: 'restored-trade',
        lastAttemptEpoch: 99n,
        reason: 'response-lost',
      },
    ]);
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation: jest.fn(),
      cancel,
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(ports(), providers);

    await runtime.awaitIdle();
    expect(cancel).toHaveBeenCalledTimes(1);
    expect(storageRepository.feeAttachments()).toEqual([]);

    providers.ready(provider);
    await runtime.awaitIdle();
    expect(cancel).toHaveBeenCalledTimes(1);
    runtime.detach();
  });

  it('rehydrates creation uncertainty only in a replacement after authority reclaim', async () => {
    install([
      {
        owner,
        submissionId: 'reclaimed-create',
        stage: 'best-effort-uncertain',
        disposition: 'active',
        request,
        lastAttemptEpoch: 99n,
        reason: 'response-lost',
        orphanRisk: 'pre-id-response-lost',
      },
    ]);
    await storageRepository.write(structuredClone(storageRepository.loadState()));
    const beginCreation = jest
      .fn()
      .mockResolvedValue({ kind: 'unavailable', reason: 'wallet unavailable' });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation,
      cancel: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(ports(), providers);

    await runtime.awaitIdle();
    expect(beginCreation).toHaveBeenCalledTimes(1);
    providers.ready(provider);
    await runtime.awaitIdle();
    expect(beginCreation).toHaveBeenCalledTimes(1);

    storageRepository.loseAuthority('takeover');
    await storageRepository.claimApplicationState();
    await runtime.awaitIdle();
    expect(beginCreation).toHaveBeenCalledTimes(1);

    providers.ready(provider);
    await runtime.awaitIdle();
    expect(beginCreation).toHaveBeenCalledTimes(1);

    const replacement = new FeeAttachmentRuntime(ports(), providers);
    await replacement.awaitIdle();
    expect(beginCreation).toHaveBeenCalledTimes(2);

    providers.ready(provider);
    await replacement.awaitIdle();
    expect(beginCreation).toHaveBeenCalledTimes(2);
    replacement.detach();
  });

  it('rehydrates cancellation uncertainty only in a replacement after authority reclaim', async () => {
    install([
      {
        owner,
        submissionId: 'reclaimed-cancel',
        stage: 'best-effort-cancellation-uncertain',
        providerReservationId: 'reclaimed-trade',
        lastAttemptEpoch: 99n,
        reason: 'response-lost',
      },
    ]);
    await storageRepository.write(structuredClone(storageRepository.loadState()));
    const cancel = jest
      .fn()
      .mockResolvedValue({ status: 'unavailable', reason: 'wallet unavailable' });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation: jest.fn(),
      cancel,
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(ports(), providers);

    await runtime.awaitIdle();
    expect(cancel).toHaveBeenCalledTimes(1);
    providers.ready(provider);
    await runtime.awaitIdle();
    expect(cancel).toHaveBeenCalledTimes(1);

    storageRepository.loseAuthority('takeover');
    await storageRepository.claimApplicationState();
    await runtime.awaitIdle();
    expect(cancel).toHaveBeenCalledTimes(1);

    providers.ready(provider);
    await runtime.awaitIdle();
    expect(cancel).toHaveBeenCalledTimes(1);

    const replacement = new FeeAttachmentRuntime(ports(), providers);
    await replacement.awaitIdle();
    expect(cancel).toHaveBeenCalledTimes(2);

    providers.ready(provider);
    await replacement.awaitIdle();
    expect(cancel).toHaveBeenCalledTimes(2);
    replacement.detach();
  });

  it('rejects reserve after storage authority loss', async () => {
    const beginCreation = jest.fn();
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation,
      cancel: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(ports(), providers);

    storageRepository.loseAuthority('takeover');

    await expect(runtime.reserve(owner, 'retired-runtime', request, () => false)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'Fee runtime lost storage authority',
    });
    expect(beginCreation).not.toHaveBeenCalled();
  });

  it('cancels a stale fee result without mutating the aggregate reclaimed after takeover', async () => {
    let resolveCreation!: (value: {
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }) => void;
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveCreation = resolve;
          }),
      ),
      cancel,
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(ports(), providers);
    const reservation = runtime.reserve(owner, 'takeover-flight', request, () => false);
    await waitFor(() => provider.beginCreation.mock.calls.length === 1);

    storageRepository.loseAuthority('takeover');
    resolveCreation({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1stale' },
      tradeId: 'stale-fee-trade',
    });
    await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
    await waitFor(() => cancel.mock.calls.length === 1);
    expect(cancel).toHaveBeenCalledWith('stale-fee-trade');

    await storageRepository.claimApplicationState();
    await runtime.awaitIdle();
    expect(storageRepository.feeAttachments()).toEqual([]);
    runtime.detach();
  });

  it('cancels through the originating provider when authority is lost during the installed reservation checkpoint', async () => {
    let resolveCreation!: (value: {
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }) => void;
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveCreation = resolve;
          }),
      ),
      cancel,
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(ports(), providers);
    const reservation = runtime.reserve(owner, 'checkpoint-takeover', request, () => false);
    await waitFor(() => provider.beginCreation.mock.calls.length === 1);

    storageRepository.attachRuntime({
      requestCommit: jest.fn(),
      flush: async () => {
        expect(storageRepository.feeAttachments()[0]?.providerReservationId).toBe(
          'checkpoint-takeover-trade',
        );
        storageRepository.loseAuthority('takeover');
        throw new StorageAuthorityLostError();
      },
    });
    resolveCreation({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1checkpoint' },
      tradeId: 'checkpoint-takeover-trade',
    });

    await expect(reservation).resolves.toEqual({
      kind: 'unavailable',
      reason: 'Storage authority changed during fee creation',
    });
    await waitFor(() => cancel.mock.calls.length === 1);
    expect(cancel).toHaveBeenCalledWith('checkpoint-takeover-trade');

    await storageRepository.claimApplicationState();
    expect(storageRepository.feeAttachments()).toEqual([]);
    runtime.detach();
  });

  it('does not cancel an installed reservation when hard reset wins its checkpoint', async () => {
    let resolveCreation!: (value: {
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }) => void;
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveCreation = resolve;
          }),
      ),
      cancel,
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(ports(), providers);
    const reservation = runtime.reserve(owner, 'checkpoint-reset', request, () => false);
    await waitFor(() => provider.beginCreation.mock.calls.length === 1);

    let resetCompleted = false;
    storageRepository.attachRuntime({
      requestCommit: jest.fn(),
      flush: async () => {
        expect(storageRepository.feeAttachments()[0]?.providerReservationId).toBe(
          'checkpoint-reset-trade',
        );
        await expect(storageRepository.hardReset()).resolves.toEqual({ success: true });
        resetCompleted = true;
        throw new StorageAuthorityLostError();
      },
    });
    resolveCreation({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1checkpointreset' },
      tradeId: 'checkpoint-reset-trade',
    });

    await expect(reservation).resolves.toEqual({
      kind: 'unavailable',
      reason: 'Storage authority changed during fee creation',
    });
    expect(resetCompleted).toBe(true);
    await storageRepository.claimApplicationState();

    expect(storageRepository.feeAttachments()).toEqual([]);
    expect(cancel).not.toHaveBeenCalled();
    runtime.detach();
  });

  it('cancels a direct reservation returned after its submission dies', async () => {
    let resolveCreation!: (value: {
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }) => void;
    let inactive = false;
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveCreation = resolve;
          }),
      ),
      cancel,
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(ports(), providers);
    const reservation = runtime.reserve(owner, 'dead-direct', request, () => inactive);
    await waitFor(() => provider.beginCreation.mock.calls.length === 1);

    inactive = true;
    resolveCreation({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1dead' },
      tradeId: 'dead-direct-trade',
    });

    await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
    await waitFor(() => cancel.mock.calls.length === 1);
    expect(cancel).toHaveBeenCalledWith('dead-direct-trade');
    expect(storageRepository.feeAttachments()).toEqual([]);
    runtime.detach();
  });

  it('reconciles and cancels a recovery id returned after its submission dies', async () => {
    let resolveCreation!: (value: { kind: 'pending'; recoveryId: string }) => void;
    let inactive = false;
    const beginCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const provider: WalletOfferProvider = {
      capability: 'recoverable',
      scope: owner.providerScope,
      beginCreation: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveCreation = resolve;
          }),
      ),
      reconcileCreation: jest.fn().mockResolvedValue({
        kind: 'created-reserved',
        material: { kind: 'offer', offer: 'offer1reconciled' },
        tradeId: 'dead-reconciled-trade',
      }),
      beginCancellation,
      reconcileCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(ports(), providers);
    const reservation = runtime.reserve(owner, 'dead-pending', request, () => inactive);
    await waitFor(() => provider.beginCreation.mock.calls.length === 1);

    inactive = true;
    resolveCreation({ kind: 'pending', recoveryId: 'dead-recovery-id' });

    await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
    expect(provider.reconcileCreation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'dead-recovery-id',
    );
    await waitFor(() => beginCancellation.mock.calls.length === 1);
    expect(beginCancellation).toHaveBeenCalledWith('dead-reconciled-trade');
    expect(storageRepository.feeAttachments()).toEqual([]);
    runtime.detach();
  });

  it('does not install pre-id uncertainty after its submission dies', async () => {
    let resolveCreation!: (value: { kind: 'unavailable'; reason: string }) => void;
    let inactive = false;
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveCreation = resolve;
          }),
      ),
      cancel: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(ports(), providers);
    const reservation = runtime.reserve(owner, 'dead-pre-id', request, () => inactive);
    await waitFor(() => provider.beginCreation.mock.calls.length === 1);

    inactive = true;
    resolveCreation({ kind: 'unavailable', reason: 'response lost' });

    await expect(reservation).resolves.toEqual({
      kind: 'unavailable',
      reason: 'response lost',
    });
    expect(storageRepository.feeAttachments()).toEqual([]);
    expect(provider.cancel).not.toHaveBeenCalled();
    runtime.detach();
  });

  it('does not cache a recovered completion after its submission dies', async () => {
    install([
      {
        owner,
        submissionId: 'dead-recovery-cache',
        stage: 'creating',
        disposition: 'active',
        request,
        recoveryId: 'recovery-cache-id',
        reason: 'fee-creation-pending',
      },
    ]);
    let resolveReconcile!: (value: {
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }) => void;
    const beginCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const beginCreation = jest.fn().mockResolvedValue({ kind: 'failure', reason: 'new attempt' });
    const provider: WalletOfferProvider = {
      capability: 'recoverable',
      scope: owner.providerScope,
      beginCreation,
      reconcileCreation: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveReconcile = resolve;
          }),
      ),
      beginCancellation,
      reconcileCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(ports(), providers);
    await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);

    runtime.retire(owner, 'dead-recovery-cache');
    resolveReconcile({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1recovereddead' },
      tradeId: 'dead-recovery-cache-trade',
    });
    await runtime.awaitIdle();
    await waitFor(() => beginCancellation.mock.calls.length === 1);
    expect(storageRepository.feeAttachments()).toEqual([]);

    await expect(
      runtime.reserve(owner, 'dead-recovery-cache', request, () => false),
    ).resolves.toEqual({ kind: 'failure', reason: 'new attempt' });
    expect(beginCreation).toHaveBeenCalledTimes(1);
    runtime.detach();
  });

  it('discards a late fee completion across hard reset', async () => {
    let resolveCreation!: (value: {
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }) => void;
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveCreation = resolve;
          }),
      ),
      cancel: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(ports(), providers);
    const reservation = runtime.reserve(owner, 'reset-flight', request, () => false);
    await waitFor(() => provider.beginCreation.mock.calls.length === 1);

    const reset = storageRepository.hardReset();
    await waitFor(() => !storageRepository.hasAuthority());
    resolveCreation({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1reset' },
      tradeId: 'reset-trade',
    });
    await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
    await expect(reset).resolves.toEqual({ success: true });
    await storageRepository.claimApplicationState();

    expect(storageRepository.feeAttachments()).toEqual([]);
    expect(provider.cancel).not.toHaveBeenCalled();
    runtime.detach();
  });

  it('returns unreserved fee material without writing a ledger entry or cancelling', async () => {
    const beginCreation = jest.fn().mockResolvedValue({
      kind: 'created-ephemeral',
      material: { kind: 'bundle', bundle: { coin_spends: [], aggregated_signature: '0xc0' } },
    });
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      feeMaterial: 'unreserved-bundle',
      scope: owner.providerScope,
      beginCreation,
      cancel,
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(ports(), providers);

    await expect(runtime.reserve(owner, 'unreserved', request, () => false)).resolves.toEqual({
      kind: 'created-ephemeral',
      material: { kind: 'bundle', bundle: { coin_spends: [], aggregated_signature: '0xc0' } },
    });
    expect(beginCreation).toHaveBeenCalledTimes(1);
    await runtime.awaitIdle();
    expect(storageRepository.feeAttachments()).toEqual([]);
    expect(cancel).not.toHaveBeenCalled();
    runtime.detach();
  });

  it('reports unreserved fee material as unavailable when its submission dies during creation', async () => {
    let resolveCreation!: (value: {
      kind: 'created-ephemeral';
      material: { kind: 'bundle'; bundle: unknown };
    }) => void;
    let inactive = false;
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      feeMaterial: 'unreserved-bundle',
      scope: owner.providerScope,
      beginCreation: jest.fn(
        () =>
          new Promise((resolve) => {
            resolveCreation = resolve;
          }),
      ),
      cancel,
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const runtime = new FeeAttachmentRuntime(ports(), providers);
    const reservation = runtime.reserve(owner, 'unreserved-dead', request, () => inactive);
    await waitFor(() => provider.beginCreation.mock.calls.length === 1);

    inactive = true;
    resolveCreation({ kind: 'created-ephemeral', material: { kind: 'bundle', bundle: {} } });

    await expect(reservation).resolves.toEqual({
      kind: 'unavailable',
      reason: 'Fee consumer retired during wallet creation',
    });
    expect(storageRepository.feeAttachments()).toEqual([]);
    expect(cancel).not.toHaveBeenCalled();
    runtime.detach();
  });

  it('unsubscribes a detached runtime only after its provider flight leaves the map', async () => {
    let resolveCreation!: (value: { kind: 'failure'; reason: string }) => void;
    const beginCreation = jest.fn(
      () =>
        new Promise<{ kind: 'failure'; reason: string }>((resolve) => {
          resolveCreation = resolve;
        }),
    );
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation,
      cancel,
    };
    const providers = new WalletProviderRegistry();
    providers.attach(provider);
    const first = new FeeAttachmentRuntime(ports(), providers);
    const reservation = first.reserve(owner, 'detached-flight', request, () => false);
    await waitFor(() => beginCreation.mock.calls.length === 1);

    first.detach();
    const replacement = new FeeAttachmentRuntime(ports(), providers);
    resolveCreation({ kind: 'failure', reason: 'declined' });
    await expect(reservation).resolves.toEqual({ kind: 'failure', reason: 'declined' });
    await first.awaitIdle();

    install([
      {
        owner,
        submissionId: 'cleanup',
        stage: 'cancel-required',
        providerReservationId: 'cleanup-trade',
        reason: 'cleanup',
      },
    ]);
    providers.reconnectReady(provider);
    await replacement.awaitIdle();

    expect(cancel).toHaveBeenCalledTimes(1);
    replacement.detach();
  });
});
