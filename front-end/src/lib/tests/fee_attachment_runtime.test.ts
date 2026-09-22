import 'fake-indexeddb/auto';
import type { WalletOfferProvider } from '../../types/ChiaGaming';
import { FeeAttachmentRuntime } from '../session/feeAttachmentRuntime';
import type { FeeAttachment, FeeAttachmentOwner } from '../session/feeAttachmentStore';
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
    await storageRepository.checkpointApplicationState(empty);
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
