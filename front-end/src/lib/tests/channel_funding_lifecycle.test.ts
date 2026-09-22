import 'fake-indexeddb/auto';
import type { WalletOfferProvider } from '../../types/ChiaGaming';
import { storageRepository } from '../session/storageRepository';
import { channelFundingRuntime } from '../session/channelFundingRuntime';
import type { ChannelFundingEntry, ChannelFundingOwner } from '../session/channelFundingStore';

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

const owner: ChannelFundingOwner = {
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

function installWallet(entries: ChannelFundingEntry[]): void {
  storageRepository._replaceApplicationStateForTests({
    ...storageRepository.loadState(),
    walletContext: owner.providerScope,
    channelFundingOperations: entries.filter((entry) => entry.purpose.kind === 'funding'),
    feeAttachments: entries.filter((entry) => entry.purpose.kind === 'fee'),
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
    Object.defineProperty(globalThis, 'sessionStorage', {
      configurable: true,
      value: makeStorage(),
    });
    storageRepository._resetForTests();
    channelFundingRuntime.resetForTests();
    await storageRepository.claimApplicationState();
    const empty = {
      ...storageRepository.loadState(),
      session: null,
      walletContext: owner.providerScope,
      channelFundingOperations: [],
      feeAttachments: [],
    };
    storageRepository._replaceApplicationStateForTests(empty);
    await storageRepository.write(storageRepository.patchApplicationState(() => empty));
  });

  afterEach(() => channelFundingRuntime.resetForTests());

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
        providerReservationId: 'Offer_reload_required',
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
        providerReservationId: 'Offer_reload_uncertain',
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
        providerReservationId: 'Offer_reload_cancelling',
        recoveryId: 'SR_reload_cancel',
        reason: 'pending',
      },
      expectedStage: 'cancelling',
    },
  ])('reloads $label from the whole aggregate', async ({ entry, expectedStage }) => {
    installWallet([entry]);
    await storageRepository.write(
      storageRepository.patchApplicationState(() => storageRepository.loadState()),
    );

    storageRepository._resetForTests();
    channelFundingRuntime.resetForTests();
    const claimed = await storageRepository.claimApplicationState();

    expect([...claimed.channelFundingOperations, ...claimed.feeAttachments]).toEqual([
      expect.objectContaining({ stage: expectedStage }),
    ]);
    expect(storageRepository.channelFundingOperations()).toEqual([
      ...claimed.channelFundingOperations,
      ...claimed.feeAttachments,
    ]);
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
    channelFundingRuntime.attachProvider(provider);

    const creation = channelFundingRuntime.createOffer(
      owner,
      purpose,
      providerRequest,
      recoveryRequest,
    );
    await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);
    expect(storageRepository.channelFundingOperations()).toEqual([
      expect.objectContaining({ stage: 'creating', recoveryId: 'SR_exact' }),
    ]);
    expect((await storageRepository.inspect()).applicationState?.channelFundingOperations).toEqual([
      expect.objectContaining({ stage: 'creating', recoveryId: 'SR_exact' }),
    ]);

    resolveReconcile({ kind: 'unavailable', reason: 'offline' });
    await expect(creation).resolves.toEqual({ kind: 'unavailable', reason: 'offline' });
  });

  it('reconciles a late recovery id locally without installing it for a retired consumer', async () => {
    let resolveBegin!: (value: { kind: 'pending'; recoveryId: string }) => void;
    let retired = false;
    const provider: WalletOfferProvider = {
      capability: 'recoverable',
      scope: owner.providerScope,
      beginCreation: jest.fn(
        () =>
          new Promise<{ kind: 'pending'; recoveryId: string }>((resolve) => {
            resolveBegin = resolve;
          }),
      ),
      reconcileCreation: jest
        .fn()
        .mockResolvedValue({ kind: 'unavailable', reason: 'wallet disconnected' }),
      beginCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' }),
      reconcileCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    channelFundingRuntime.attachProvider(provider);

    const creation = channelFundingRuntime.createOffer(
      owner,
      purpose,
      providerRequest,
      recoveryRequest,
      () => retired,
    );
    await waitFor(() => provider.beginCreation.mock.calls.length === 1);
    retired = true;
    resolveBegin({ kind: 'pending', recoveryId: 'SR_retired' });

    await expect(creation).resolves.toMatchObject({ kind: 'unavailable' });
    expect(provider.reconcileCreation).toHaveBeenCalledTimes(1);
    expect(provider.reconcileCreation).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      'SR_retired',
    );
    expect(storageRepository.channelFundingOperations()).toEqual([]);
  });

  it('flushes the attached runtime before each provider mutation', async () => {
    const order: string[] = [];
    let resolveReconcile!: (value: { kind: 'unavailable'; reason: string }) => void;
    const reconcile = new Promise<{ kind: 'unavailable'; reason: string }>((resolve) => {
      resolveReconcile = resolve;
    });
    const detach = storageRepository.attachRuntime({
      requestCommit: jest.fn(),
      flush: async () => {
        order.push('checkpoint');
        await storageRepository.write(structuredClone(storageRepository.loadState()));
      },
    });
    const provider: WalletOfferProvider = {
      capability: 'recoverable',
      scope: owner.providerScope,
      beginCreation: jest.fn(async () => {
        order.push('begin');
        return { kind: 'pending', recoveryId: 'SR_attached' };
      }),
      reconcileCreation: jest.fn(async () => {
        order.push('reconcile');
        expect(
          (await storageRepository.inspect()).applicationState?.channelFundingOperations,
        ).toEqual([expect.objectContaining({ stage: 'creating', recoveryId: 'SR_attached' })]);
        return reconcile;
      }),
      beginCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' }),
      reconcileCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    channelFundingRuntime.attachProvider(provider);

    const creation = channelFundingRuntime.createOffer(
      owner,
      purpose,
      providerRequest,
      recoveryRequest,
    );
    await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);
    expect(order).toEqual(['checkpoint', 'begin', 'checkpoint', 'reconcile']);

    resolveReconcile({ kind: 'unavailable', reason: 'offline' });
    await expect(creation).resolves.toEqual({ kind: 'unavailable', reason: 'offline' });
    detach();
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
    channelFundingRuntime.attachProvider(provider);

    await expect(
      channelFundingRuntime.createOffer(owner, purpose, providerRequest, recoveryRequest),
    ).resolves.toMatchObject({ kind: 'unavailable' });
    expect(beginCreation).toHaveBeenCalledTimes(1);
    expect(storageRepository.channelFundingOperations()).toEqual([
      expect.objectContaining({
        stage: 'best-effort-uncertain',
        orphanRisk: 'pre-id-response-lost',
      }),
    ]);

    await Promise.resolve();
    expect(beginCreation).toHaveBeenCalledTimes(1);
    channelFundingRuntime.providerReconnectReady(provider);
    await waitFor(() => beginCreation.mock.calls.length === 2);
    expect(beginCreation).toHaveBeenCalledTimes(2);
    expect(storageRepository.channelFundingOperations()).toEqual([
      expect.objectContaining({
        stage: 'awaiting-channel',
        providerReservationId: 'replacement',
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
        providerReservationId: 'Offer_cancel',
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
    channelFundingRuntime.attachProvider(provider);
    await waitFor(() => provider.reconcileCancellation.mock.calls.length === 1);

    expect(storageRepository.channelFundingOperations()).toEqual([
      expect.objectContaining({
        stage: 'cancelling',
        providerReservationId: 'Offer_cancel',
        recoveryId: 'SR_cancel',
      }),
    ]);
    expect((await storageRepository.inspect()).applicationState?.channelFundingOperations).toEqual([
      expect.objectContaining({ stage: 'cancelling', recoveryId: 'SR_cancel' }),
    ]);

    resolveCancellation({ status: 'cancelled' });
    await channelFundingRuntime.flush();
    expect(storageRepository.channelFundingOperations()).toEqual([]);
  });

  it('cancels a stale result without mutating the aggregate reclaimed after takeover', async () => {
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
    await storageRepository.write(storageRepository.patchApplicationState(() => scoped));
    channelFundingRuntime.attachProvider(provider);
    const creation = channelFundingRuntime.createOffer(
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
    await waitFor(() => cancel.mock.calls.length === 1);
    expect(cancel).toHaveBeenCalledWith('stale-trade');

    await storageRepository.claimApplicationState();
    await channelFundingRuntime.flush();
    expect(storageRepository.channelFundingOperations()).toEqual([]);
  });

  it('discards a late creation completion across hard reset', async () => {
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
    channelFundingRuntime.attachProvider(provider);
    const creation = channelFundingRuntime.createOffer(
      owner,
      purpose,
      providerRequest,
      recoveryRequest,
    );
    await waitFor(() => provider.beginCreation.mock.calls.length === 1);

    const reset = storageRepository.hardReset();
    await waitFor(() => !storageRepository.hasAuthority());
    resolveCreation({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1reset' },
      tradeId: 'reset-trade',
    });
    await expect(creation).resolves.toMatchObject({ kind: 'unavailable' });
    await expect(reset).resolves.toEqual({ success: true });
    await storageRepository.claimApplicationState();

    expect(storageRepository.channelFundingOperations()).toEqual([]);
    expect(provider.cancel).not.toHaveBeenCalled();
  });

  it('does not call a provider under aggregate scope mismatch', async () => {
    installWallet([
      {
        owner,
        purpose,
        stage: 'cancel-required',
        providerReservationId: 'Offer_original',
        reason: 'cleanup',
      },
    ]);
    const cancel = jest.fn();
    channelFundingRuntime.attachProvider({
      capability: 'best-effort',
      scope: { provider: 'cloud', walletId: 'Wallet_2' },
      beginCreation: jest.fn(),
      cancel,
    });
    channelFundingRuntime.retryCancelRequired(owner);
    await Promise.resolve();
    expect(cancel).not.toHaveBeenCalled();
    expect(storageRepository.channelFundingOperations()).toHaveLength(1);
  });
});
