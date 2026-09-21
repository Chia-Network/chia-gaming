import type { WalletOfferProvider } from '../../types/ChiaGaming';
import { log } from '../../services/log';
import { WalletOperationRuntime } from '../session/walletOperationRuntime';
import type { CanonicalFundingRequest } from '../session/fundingRequest';
import { encodeWalletOperationRecord } from '../session/walletOperationCodec';
import { StorageAuthorityLostError } from '../session/indexedDb';
import {
  walletProviderScopeKey,
  walletOperationKey,
  walletOperationOwnerKey,
  type WalletOperationOwner,
} from '../session/walletOperationStore';
import {
  entriesForOwner,
  providerRequestFromRecovery,
  scopeStatus,
} from '../session/walletOperationSelectors';

jest.mock('../../services/log', () => ({ log: jest.fn() }));

const owner: WalletOperationOwner = {
  installationPlayerId: 'player',
  peerSessionId: 'session',
  providerScope: { provider: 'cloud', walletId: 'Wallet_1' },
};

const fundingPurpose = { kind: 'funding' as const, operationId: 'funding-op' };
const fundingRequest = {
  amount: '100',
  fee: '0',
  conditions: [],
};

function fundingTestPort(
  runtime: WalletOperationRuntime,
  operationOwner: WalletOperationOwner,
  purpose: typeof fundingPurpose,
) {
  let retired = false;
  return {
    createFunding(request: CanonicalFundingRequest) {
      const recovery = { kind: 'funding' as const, canonical: request };
      return runtime.createOffer(
        operationOwner,
        purpose,
        providerRequestFromRecovery(operationOwner, recovery),
        recovery,
        () => retired,
      );
    },
    settle(
      disposition: 'consumed' | 'cancel-required' | 'retained-for-replay',
      reason: string,
      coordinated = false,
    ) {
      runtime.settleOperation(operationOwner, purpose, disposition, reason, coordinated);
    },
    retire(reason: string) {
      retired = true;
      runtime.retireOperation(operationOwner, purpose, reason);
    },
  };
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}

function recoverableProvider(
  overrides: Partial<Extract<WalletOfferProvider, { capability: 'recoverable' }>> = {},
): Extract<WalletOfferProvider, { capability: 'recoverable' }> {
  return {
    capability: 'recoverable',
    scope: owner.providerScope,
    beginCreation: jest.fn().mockResolvedValue({ kind: 'pending', recoveryId: 'SR_exact' }),
    reconcileCreation: jest.fn().mockResolvedValue({ kind: 'unavailable', reason: 'disconnected' }),
    beginCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    reconcileCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    ...overrides,
  };
}

function recoverableAfterBeginProvider(
  overrides: Partial<Extract<WalletOfferProvider, { capability: 'recoverable-after-begin' }>> = {},
): Extract<WalletOfferProvider, { capability: 'recoverable-after-begin' }> {
  return {
    capability: 'recoverable-after-begin',
    scope: owner.providerScope,
    beginCreation: jest.fn().mockResolvedValue({ kind: 'pending', recoveryId: 'SR_exact' }),
    reconcileCreation: jest.fn().mockResolvedValue({ kind: 'unavailable', reason: 'disconnected' }),
    beginCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    reconcileCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    ...overrides,
  };
}

describe('provider-neutral wallet offer lifecycle', () => {
  it('fences a stale create completion across conflicting authority hydrate', async () => {
    let generation = 1;
    const writes: unknown[][] = [];
    let resolveCreate!: (value: {
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }) => void;
    const create = new Promise<{
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }>((resolve) => {
      resolveCreate = resolve;
    });
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const beginCreation = jest.fn(() => create);
    const runtime = new WalletOperationRuntime();
    runtime.configurePersistence(async (entries) => {
      writes.push(structuredClone(entries));
    });
    runtime.configureLifecycle({
      generation: () => generation,
      isCurrent: (captured) => captured === generation,
    });
    runtime.attachProvider({
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation,
      cancel,
    });

    const stale = fundingTestPort(runtime, owner, fundingPurpose).createFunding(fundingRequest);
    while (beginCreation.mock.calls.length === 0) await Promise.resolve();
    generation = 2;
    resolveCreate({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1stale' },
      tradeId: 'stale-trade',
    });
    await expect(stale).resolves.toMatchObject({
      kind: 'unavailable',
      reason: expect.stringMatching(/authority changed/i),
    });
    expect(cancel).not.toHaveBeenCalled();

    runtime.hydrateClaimedSnapshot(
      encodeWalletOperationRecord([
        {
          owner,
          purpose: fundingPurpose,
          stage: 'creating',
          disposition: 'active',
          recoveryId: 'winner-recovery',
          request: { kind: 'funding', canonical: fundingRequest },
          reason: 'winner',
        },
      ]),
      owner.providerScope,
    );
    await runtime.awaitOwner(owner);

    expect(cancel).toHaveBeenCalledWith('stale-trade');
    expect(writes).toContainEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'creating', recoveryId: 'winner-recovery' }),
        expect.objectContaining({ stage: 'cancel-required', tradeId: 'stale-trade' }),
      ]),
      owner.providerScope,
    );
    expect(runtime.snapshot()).toEqual([
      expect.objectContaining({ stage: 'creating', recoveryId: 'winner-recovery' }),
    ]);
  });

  it('does not carry stale cleanup across a different saved wallet scope', async () => {
    let generation = 1;
    let resolveCreate!: (value: {
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }) => void;
    const create = new Promise<{
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }>((resolve) => {
      resolveCreate = resolve;
    });
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' as const });
    const beginCreation = jest.fn(() => create);
    const runtime = new WalletOperationRuntime();
    runtime.configureLifecycle({
      generation: () => generation,
      isCurrent: (captured) => captured === generation,
    });
    runtime.attachProvider({
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation,
      cancel,
    });

    const stale = fundingTestPort(runtime, owner, fundingPurpose).createFunding(fundingRequest);
    while (beginCreation.mock.calls.length === 0) await Promise.resolve();
    generation = 2;
    resolveCreate({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1staleowner' },
      tradeId: 'stale-owner-trade',
    });
    await stale;
    const otherOwner = {
      ...owner,
      providerScope: { provider: 'cloud' as const, walletId: 'Wallet_2' },
    };
    runtime.hydrateClaimedSnapshot(
      encodeWalletOperationRecord([
        {
          owner: otherOwner,
          purpose: fundingPurpose,
          stage: 'creating',
          disposition: 'active',
          recoveryId: 'other-owner-recovery',
          request: { kind: 'funding', canonical: fundingRequest },
          reason: 'other-owner-winner',
        },
      ]),
      otherOwner.providerScope,
    );
    expect(cancel).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toEqual([
      expect.objectContaining({ owner: otherOwner, recoveryId: 'other-owner-recovery' }),
    ]);

    await runtime.awaitOwner(owner);
    expect(cancel).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toEqual([
      expect.objectContaining({ owner: otherOwner, recoveryId: 'other-owner-recovery' }),
    ]);
  });

  it.each([
    {
      label: 'unavailable',
      first: { status: 'unavailable' as const, detail: 'wallet offline' },
    },
    {
      label: 'rejected',
      first: { status: 'rejected' as const, detail: 'wallet refused cancellation' },
    },
  ])('retains stale cleanup after a $label cancellation outcome', async ({ first }) => {
    let generation = 1;
    let resolveCreate!: (value: {
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }) => void;
    const create = new Promise<{
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }>((resolve) => {
      resolveCreate = resolve;
    });
    const cancel = jest
      .fn()
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce({ status: 'cancelled' as const });
    const beginCreation = jest.fn(() => create);
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation,
      cancel,
    };
    const runtime = new WalletOperationRuntime();
    runtime.configureLifecycle({
      generation: () => generation,
      isCurrent: (captured) => captured === generation,
    });
    runtime.attachProvider(provider);

    const stale = fundingTestPort(runtime, owner, fundingPurpose).createFunding(fundingRequest);
    while (beginCreation.mock.calls.length === 0) await Promise.resolve();
    generation = 2;
    runtime.hydrateClaimedSnapshot(null, owner.providerScope);
    resolveCreate({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1stale' },
      tradeId: 'stale-trade',
    });
    await stale;
    await runtime.awaitOwner(owner);

    expect(runtime.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'cancel-required',
        tradeId: 'stale-trade',
        reason: 'stale-create-result',
      }),
    ]);
    runtime.providerReconnectReady(provider);
    await runtime.awaitOwner(owner);
    expect(cancel).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot()).toEqual([]);
  });

  it('persists uncertain Cloud cleanup and removes it only after exact terminal recovery', async () => {
    let generation = 1;
    let resolveCreate!: (value: {
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }) => void;
    const create = new Promise<{
      kind: 'created-reserved';
      material: { kind: 'offer'; offer: string };
      tradeId: string;
    }>((resolve) => {
      resolveCreate = resolve;
    });
    const beginCancellation = jest
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable' as const, detail: 'response lost' })
      .mockResolvedValueOnce({ status: 'pending' as const, recoveryId: 'SR_cancel_stale' });
    const reconcileCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'cancelled' as const, detail: 'SUBMITTED' });
    const beginCreation = jest.fn(() => create);
    const provider = recoverableAfterBeginProvider({
      beginCreation,
      beginCancellation,
      reconcileCancellation,
    });
    const runtime = new WalletOperationRuntime();
    runtime.configureLifecycle({
      generation: () => generation,
      isCurrent: (captured) => captured === generation,
    });
    runtime.attachProvider(provider);

    const stale = fundingTestPort(runtime, owner, fundingPurpose).createFunding(fundingRequest);
    while (beginCreation.mock.calls.length === 0) await Promise.resolve();
    generation = 2;
    runtime.hydrateClaimedSnapshot(null, owner.providerScope);
    resolveCreate({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1cloudstale' },
      tradeId: 'Offer_cloud_stale',
    });
    await stale;
    await runtime.awaitOwner(owner);

    expect(runtime.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'best-effort-cancellation-uncertain',
        tradeId: 'Offer_cloud_stale',
        reason: 'cloud-cancellation-response-lost-orphan-risk',
      }),
    ]);
    runtime.providerReconnectReady(provider);
    await runtime.awaitOwner(owner);
    expect(beginCancellation).toHaveBeenCalledTimes(2);
    expect(reconcileCancellation).toHaveBeenCalledWith('Offer_cloud_stale', 'SR_cancel_stale');
    expect(runtime.snapshot()).toEqual([]);
  });

  it('does not launch creation or cancellation after their authority generation is stale', async () => {
    let generation = 1;
    const beginCreation = jest.fn();
    const cancel = jest.fn();
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation,
      cancel,
    };
    const runtime = new WalletOperationRuntime();
    runtime.configureLifecycle({
      generation: () => generation,
      isCurrent: (captured) => captured === generation,
    });
    runtime.attachProvider(provider);

    const creation = fundingTestPort(runtime, owner, fundingPurpose).createFunding(fundingRequest);
    generation = 2;
    await expect(creation).resolves.toMatchObject({
      kind: 'unavailable',
      reason: expect.stringMatching(/authority changed/i),
    });
    expect(beginCreation).not.toHaveBeenCalled();

    generation = 3;
    runtime.hydrateClaimedSnapshot(null, owner.providerScope);
    runtime.registerReserved('cancel-before-launch', owner, fundingPurpose);
    runtime.settleTrade('cancel-before-launch', 'cancel-required', 'authority-fence-test');
    generation = 4;
    await runtime.awaitOwner(owner);
    expect(cancel).not.toHaveBeenCalled();
    expect(runtime.snapshot()).toEqual([
      expect.objectContaining({ stage: 'cancel-required', tradeId: 'cancel-before-launch' }),
    ]);
  });

  it('hands a creation recovery id to the hydrated authority without recreating', async () => {
    let generation = 1;
    const result = deferred<{ kind: 'pending'; recoveryId: string }>();
    const beginCreation = jest.fn(() => result.promise);
    const reconcileCreation = jest
      .fn()
      .mockResolvedValue({ kind: 'unavailable', reason: 'still pending' });
    const provider = recoverableProvider({ beginCreation, reconcileCreation });
    const runtime = new WalletOperationRuntime();
    runtime.configureLifecycle({
      generation: () => generation,
      isCurrent: (captured) => captured === generation,
    });
    runtime.attachProvider(provider);

    const stale = fundingTestPort(runtime, owner, fundingPurpose).createFunding(fundingRequest);
    while (beginCreation.mock.calls.length === 0) await Promise.resolve();
    generation = 2;
    result.resolve({ kind: 'pending', recoveryId: 'SR_handoff_create' });
    await expect(stale).resolves.toMatchObject({
      kind: 'unavailable',
      reason: expect.stringMatching(/authority changed/i),
    });

    runtime.hydrateClaimedSnapshot(null, owner.providerScope);
    await runtime.awaitOwner(owner);
    expect(runtime.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'creating',
        recoveryId: 'SR_handoff_create',
        disposition: 'active',
        request: { kind: 'funding', canonical: fundingRequest },
      }),
    ]);
    await fundingTestPort(runtime, owner, fundingPurpose).createFunding(fundingRequest);
    expect(beginCreation).toHaveBeenCalledTimes(1);
    expect(reconcileCreation).toHaveBeenCalledWith(
      { owner, purpose: fundingPurpose },
      expect.objectContaining({ kind: 'funding' }),
      'SR_handoff_create',
    );
  });

  it('hands creation pre-id uncertainty to the next readiness epoch', async () => {
    let generation = 1;
    const result = deferred<{ kind: 'unavailable'; reason: string }>();
    const beginCreation = jest
      .fn()
      .mockImplementationOnce(() => result.promise)
      .mockResolvedValueOnce({ kind: 'pending', recoveryId: 'SR_after_readiness' });
    const provider = recoverableAfterBeginProvider({ beginCreation });
    const runtime = new WalletOperationRuntime();
    runtime.configureLifecycle({
      generation: () => generation,
      isCurrent: (captured) => captured === generation,
    });
    runtime.attachProvider(provider);
    const operation = fundingTestPort(runtime, owner, fundingPurpose);

    const stale = operation.createFunding(fundingRequest);
    while (beginCreation.mock.calls.length === 0) await Promise.resolve();
    generation = 2;
    result.resolve({ kind: 'unavailable', reason: 'response lost' });
    await stale;
    runtime.hydrateClaimedSnapshot(null, owner.providerScope);
    await runtime.awaitOwner(owner);

    expect(runtime.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'best-effort-uncertain',
        reason: 'cloud-response-unavailable',
        orphanRisk: 'pre-id-response-lost',
        lastAttemptEpoch: 1n,
      }),
    ]);
    await operation.createFunding(fundingRequest);
    expect(beginCreation).toHaveBeenCalledTimes(1);
    runtime.providerReconnectReady(provider);
    await runtime.awaitOwner(owner);
    expect(beginCreation).toHaveBeenCalledTimes(2);
    expect(runtime.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'creating',
        recoveryId: 'SR_after_readiness',
        orphanRisk: 'pre-id-response-lost',
      }),
    ]);
  });

  it('hands a cancellation recovery id to the hydrated authority', async () => {
    let generation = 1;
    const result = deferred<{ status: 'pending'; recoveryId: string }>();
    const beginCancellation = jest.fn(() => result.promise);
    const reconcileCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'unavailable', detail: 'still pending' });
    const provider = recoverableAfterBeginProvider({
      beginCancellation,
      reconcileCancellation,
    });
    const runtime = new WalletOperationRuntime();
    runtime.configureLifecycle({
      generation: () => generation,
      isCurrent: (captured) => captured === generation,
    });
    runtime.attachProvider(provider);
    runtime.registerReserved('Offer_cancel_handoff', owner, fundingPurpose);
    runtime.settleTrade('Offer_cancel_handoff', 'cancel-required', 'retired');
    while (beginCancellation.mock.calls.length === 0) await Promise.resolve();
    generation = 2;
    result.resolve({ status: 'pending', recoveryId: 'SR_cancel_handoff' });
    await runtime.awaitOwner(owner);

    runtime.hydrateClaimedSnapshot(
      encodeWalletOperationRecord([
        {
          owner,
          purpose: fundingPurpose,
          stage: 'cancel-required',
          tradeId: 'Offer_cancel_handoff',
          reason: 'winner',
          orphanRisk: 'pre-id-response-lost',
        },
      ]),
      owner.providerScope,
    );
    await runtime.awaitOwner(owner);
    expect(beginCancellation).toHaveBeenCalledTimes(1);
    expect(reconcileCancellation).toHaveBeenCalledWith('Offer_cancel_handoff', 'SR_cancel_handoff');
    expect(runtime.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'cancelling',
        tradeId: 'Offer_cancel_handoff',
        recoveryId: 'SR_cancel_handoff',
        orphanRisk: 'pre-id-response-lost',
      }),
    ]);
  });

  it('hands cancellation pre-id uncertainty to the next readiness epoch', async () => {
    let generation = 1;
    const result = deferred<{ status: 'unavailable'; detail: string }>();
    const beginCancellation = jest
      .fn()
      .mockImplementationOnce(() => result.promise)
      .mockResolvedValueOnce({ status: 'pending', recoveryId: 'SR_cancel_after_readiness' });
    const reconcileCancellation = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const provider = recoverableAfterBeginProvider({
      beginCancellation,
      reconcileCancellation,
    });
    const runtime = new WalletOperationRuntime();
    runtime.configureLifecycle({
      generation: () => generation,
      isCurrent: (captured) => captured === generation,
    });
    runtime.attachProvider(provider);
    runtime.registerReserved('Offer_cancel_uncertain', owner, fundingPurpose);
    runtime.settleTrade('Offer_cancel_uncertain', 'cancel-required', 'retired');
    while (beginCancellation.mock.calls.length === 0) await Promise.resolve();
    generation = 2;
    result.resolve({ status: 'unavailable', detail: 'response lost' });
    await runtime.awaitOwner(owner);

    runtime.hydrateClaimedSnapshot(
      encodeWalletOperationRecord([
        {
          owner,
          purpose: fundingPurpose,
          stage: 'cancel-required',
          tradeId: 'Offer_cancel_uncertain',
          reason: 'winner',
          orphanRisk: 'pre-id-response-lost',
        },
      ]),
      owner.providerScope,
    );
    await runtime.awaitOwner(owner);
    expect(beginCancellation).toHaveBeenCalledTimes(1);
    expect(runtime.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'best-effort-cancellation-uncertain',
        tradeId: 'Offer_cancel_uncertain',
        reason: 'cloud-cancellation-response-lost-orphan-risk',
        lastAttemptEpoch: 1n,
        orphanRisk: 'pre-id-response-lost',
      }),
    ]);
    runtime.providerReconnectReady(provider);
    await runtime.awaitOwner(owner);
    expect(beginCancellation).toHaveBeenCalledTimes(2);
    expect(reconcileCancellation).toHaveBeenCalledWith(
      'Offer_cancel_uncertain',
      'SR_cancel_after_readiness',
    );
    expect(runtime.snapshot()).toEqual([]);
  });

  it('continues handed-off exact cleanup after an ordinary failed winner write', async () => {
    let generation = 1;
    let failNextWrite = false;
    const writes: unknown[][] = [];
    const result = deferred<{ status: 'pending'; recoveryId: string }>();
    const beginCancellation = jest.fn(() => result.promise);
    const reconcileCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'unavailable', detail: 'still pending' });
    const provider = recoverableAfterBeginProvider({
      beginCancellation,
      reconcileCancellation,
    });
    const runtime = new WalletOperationRuntime();
    runtime.configurePersistence(async (entries) => {
      writes.push(structuredClone(entries));
      if (failNextWrite) {
        failNextWrite = false;
        throw new Error('ordinary checkpoint failure');
      }
    });
    runtime.configureLifecycle({
      generation: () => generation,
      isCurrent: (captured) => captured === generation,
    });
    runtime.attachProvider(provider);
    runtime.registerReserved('Offer_failed_handoff_write', owner, fundingPurpose);
    runtime.settleTrade('Offer_failed_handoff_write', 'cancel-required', 'retired');
    while (beginCancellation.mock.calls.length === 0) await Promise.resolve();
    generation = 2;
    result.resolve({ status: 'pending', recoveryId: 'SR_failed_handoff_write' });
    await runtime.awaitOwner(owner);

    writes.length = 0;
    failNextWrite = true;
    runtime.hydrateClaimedSnapshot(
      encodeWalletOperationRecord([
        {
          owner,
          purpose: fundingPurpose,
          stage: 'cancel-required',
          tradeId: 'Offer_failed_handoff_write',
          reason: 'winner',
        },
      ]),
      owner.providerScope,
    );
    await runtime.awaitHydrated();
    await runtime.awaitOwner(owner);

    expect(writes).toEqual([
      [
        expect.objectContaining({
          stage: 'cancelling',
          tradeId: 'Offer_failed_handoff_write',
          recoveryId: 'SR_failed_handoff_write',
        }),
      ],
    ]);
    expect(runtime.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'cancelling',
        tradeId: 'Offer_failed_handoff_write',
        recoveryId: 'SR_failed_handoff_write',
      }),
    ]);
    expect(runtime.isDirty()).toBe(true);
    expect(beginCancellation).toHaveBeenCalledTimes(1);
    expect(reconcileCancellation).toHaveBeenCalledTimes(1);

    await runtime.persistIfDirty();
    expect(writes.at(-1)).toEqual([
      expect.objectContaining({
        stage: 'cancelling',
        tradeId: 'Offer_failed_handoff_write',
        recoveryId: 'SR_failed_handoff_write',
      }),
    ]);
    expect(runtime.isDirty()).toBe(false);
    expect(reconcileCancellation).toHaveBeenCalledTimes(1);
  });

  it('fences handed-off cleanup when the winner write loses authority', async () => {
    let generation = 1;
    let loseAuthority = false;
    let rejectAuthorityWrite!: (error: unknown) => void;
    const authorityWrite = new Promise<void>((_resolve, reject) => {
      rejectAuthorityWrite = reject;
    });
    const writes: unknown[][] = [];
    const result = deferred<{ status: 'pending'; recoveryId: string }>();
    const beginCancellation = jest.fn(() => result.promise);
    const reconcileCancellation = jest.fn();
    const provider = recoverableAfterBeginProvider({
      beginCancellation,
      reconcileCancellation,
    });
    const runtime = new WalletOperationRuntime();
    runtime.configurePersistence(async (entries) => {
      writes.push(structuredClone(entries));
      if (loseAuthority) return authorityWrite;
    });
    runtime.configureLifecycle({
      generation: () => generation,
      isCurrent: (captured) => captured === generation,
    });
    runtime.attachProvider(provider);
    runtime.registerReserved('Offer_authority_lost_handoff', owner, fundingPurpose);
    runtime.settleTrade('Offer_authority_lost_handoff', 'cancel-required', 'retired');
    while (beginCancellation.mock.calls.length === 0) await Promise.resolve();
    generation = 2;
    result.resolve({ status: 'pending', recoveryId: 'SR_authority_lost_handoff' });
    await runtime.awaitOwner(owner);

    writes.length = 0;
    loseAuthority = true;
    runtime.hydrateClaimedSnapshot(
      encodeWalletOperationRecord([
        {
          owner,
          purpose: fundingPurpose,
          stage: 'cancel-required',
          tradeId: 'Offer_authority_lost_handoff',
          reason: 'winner',
        },
      ]),
      owner.providerScope,
    );
    const hydration = runtime.awaitHydrated();
    await Promise.resolve();
    rejectAuthorityWrite(new StorageAuthorityLostError());
    await expect(hydration).resolves.toBeUndefined();
    await runtime.awaitOwner(owner);

    expect(writes).toEqual([
      [
        expect.objectContaining({
          stage: 'cancelling',
          tradeId: 'Offer_authority_lost_handoff',
          recoveryId: 'SR_authority_lost_handoff',
        }),
      ],
    ]);
    expect(runtime.isDirty()).toBe(true);
    expect(beginCancellation).toHaveBeenCalledTimes(1);
    expect(reconcileCancellation).not.toHaveBeenCalled();
  });

  it('persists a Cloud recovery id before reconcile and resumes it without recreating', async () => {
    const ledger = new WalletOperationRuntime();
    const writes: unknown[][] = [];
    ledger.configurePersistence(async (entries) => {
      writes.push(structuredClone(entries));
    });
    const begin = jest.fn().mockResolvedValue({ kind: 'pending', recoveryId: 'SR_exact' });
    const reconcile = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'disconnected' })
      .mockResolvedValueOnce({
        kind: 'created-reserved',
        material: { kind: 'offer', offer: 'offer1canonical' },
        tradeId: 'Offer_exact',
      });
    const provider = recoverableProvider({
      beginCreation: begin,
      reconcileCreation: reconcile,
    });
    ledger.attachProvider(provider);
    const operation = fundingTestPort(ledger, owner, fundingPurpose);

    await expect(operation.createFunding(fundingRequest)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'disconnected',
    });
    expect(writes[0]).toEqual([
      expect.objectContaining({
        stage: 'creating',
        recoveryId: 'SR_exact',
        disposition: 'active',
        owner,
        purpose: fundingPurpose,
        request: { kind: 'funding', canonical: fundingRequest },
      }),
    ]);

    const restored = new WalletOperationRuntime();
    restored.restore(ledger.snapshot());
    restored.attachProvider(provider);
    await expect(
      fundingTestPort(restored, owner, fundingPurpose).createFunding(fundingRequest),
    ).resolves.toEqual({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1canonical' },
      tradeId: 'Offer_exact',
    });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenNthCalledWith(
      2,
      { owner, purpose: fundingPurpose },
      expect.objectContaining({ kind: 'funding', offer: { '1': -100n } }),
      'SR_exact',
    );
    expect(entriesForOwner(restored.snapshot(), owner)).toEqual([
      expect.objectContaining({ stage: 'reserved', tradeId: 'Offer_exact' }),
    ]);
  });

  it('quarantines a recovery owned by another provider account', async () => {
    const ledger = new WalletOperationRuntime();
    ledger.restore([
      {
        owner,
        purpose: fundingPurpose,
        stage: 'creating',
        disposition: 'active',
        recoveryId: 'SR_original',
        request: { kind: 'funding', canonical: fundingRequest },
        reason: 'pending',
      },
    ]);
    const begin = jest.fn();
    const reconcile = jest.fn();
    const wrongProvider = recoverableProvider({
      scope: { provider: 'cloud', walletId: 'Wallet_other' },
      beginCreation: begin,
      reconcileCreation: reconcile,
    });
    ledger.attachProvider(wrongProvider);

    await expect(
      fundingTestPort(ledger, owner, fundingPurpose).createFunding(fundingRequest),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: expect.stringMatching(/original wallet account/i),
    });
    expect(begin).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(scopeStatus(ledger.snapshot(), ledger.providerScopeKeys(), 'player', 'session')).toEqual(
      {
        kind: 'mismatch',
      },
    );
  });

  it('matches equivalent provider scopes independently of object property order', async () => {
    const scopedOwner: WalletOperationOwner = {
      installationPlayerId: 'player',
      peerSessionId: 'session',
      providerScope: {
        provider: 'walletconnect',
        fingerprint: '123456',
        chainId: 'chia:testnet11',
      },
    };
    const ledger = new WalletOperationRuntime();
    ledger.restore([
      {
        owner: scopedOwner,
        purpose: fundingPurpose,
        stage: 'creating',
        disposition: 'active',
        recoveryId: 'SR_order',
        request: { kind: 'funding', canonical: fundingRequest },
        reason: 'pending',
      },
    ]);
    const reconcile = jest.fn().mockResolvedValue({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1ordered' },
      tradeId: 'trade-ordered',
    });
    const provider = recoverableProvider({
      scope: {
        provider: 'walletconnect',
        chainId: 'chia:testnet11',
        fingerprint: '123456',
      },
      reconcileCreation: reconcile,
    });
    ledger.attachProvider(provider);

    expect(scopeStatus(ledger.snapshot(), ledger.providerScopeKeys(), 'player', 'session')).toEqual(
      {
        kind: 'ready',
      },
    );
    await expect(
      fundingTestPort(ledger, scopedOwner, fundingPurpose).createFunding(fundingRequest),
    ).resolves.toMatchObject({ kind: 'created-reserved', tradeId: 'trade-ordered' });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('does not match an unavailable provider scope', async () => {
    const ledger = new WalletOperationRuntime();
    ledger.restore([
      {
        owner,
        purpose: fundingPurpose,
        stage: 'creating',
        disposition: 'active',
        recoveryId: 'SR_missing_scope',
        request: { kind: 'funding', canonical: fundingRequest },
        reason: 'pending',
      },
    ]);

    expect(scopeStatus(ledger.snapshot(), ledger.providerScopeKeys(), 'player', 'session')).toEqual(
      {
        kind: 'unavailable',
      },
    );
  });

  it('returns a terminally failed cancellation to cancel-required without looping', async () => {
    const beginCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'pending', recoveryId: 'SR_cancel_exact' });
    const reconcileCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'rejected', detail: 'terminal cancellation failure' });
    const provider = recoverableProvider({ beginCancellation, reconcileCancellation });
    const coordinator = new WalletOperationRuntime();
    coordinator.attachProvider(provider);
    coordinator.registerReserved('Offer_cancel', owner, fundingPurpose);
    coordinator.settleOperation(owner, fundingPurpose, 'cancel-required', 'retired');
    await coordinator.awaitOwner(owner);

    expect(beginCancellation).toHaveBeenCalledTimes(1);
    expect(reconcileCancellation).toHaveBeenCalledTimes(1);
    expect(coordinator.snapshot()).toEqual([
      expect.objectContaining({ tradeId: 'Offer_cancel', stage: 'cancel-required' }),
    ]);
    await Promise.resolve();
    expect(beginCancellation).toHaveBeenCalledTimes(1);
  });

  it('preserves a cancellation recovery id across unavailable reconcile without a new mutation', async () => {
    const beginCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'pending', recoveryId: 'SR_cancel_exact' });
    const reconcileCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'unavailable', detail: 'temporarily missing' });
    const provider = recoverableProvider({ beginCancellation, reconcileCancellation });
    const coordinator = new WalletOperationRuntime();
    coordinator.attachProvider(provider);
    coordinator.registerReserved('Offer_cancel', owner, fundingPurpose);
    coordinator.settleOperation(owner, fundingPurpose, 'cancel-required', 'retired');
    await coordinator.awaitOwner(owner);

    expect(coordinator.snapshot()).toEqual([
      expect.objectContaining({
        tradeId: 'Offer_cancel',
        stage: 'cancelling',
        recoveryId: 'SR_cancel_exact',
      }),
    ]);
    coordinator.providerReady(provider);
    await coordinator.awaitOwner(owner);

    expect(beginCancellation).toHaveBeenCalledTimes(1);
    expect(reconcileCancellation).toHaveBeenCalledTimes(2);
  });

  it('preserves a cancellation recovery id when queued transport throws', async () => {
    const beginCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'pending', recoveryId: 'SR_cancel_transport' });
    const reconcileCancellation = jest
      .fn()
      .mockRejectedValueOnce(new Error('wallet disconnected'))
      .mockResolvedValueOnce({ status: 'cancelled', detail: 'SUBMITTED' });
    const provider = recoverableProvider({ beginCancellation, reconcileCancellation });
    const coordinator = new WalletOperationRuntime();
    coordinator.attachProvider(provider);
    coordinator.registerReserved('Offer_cancel', owner, fundingPurpose);
    coordinator.settleOperation(owner, fundingPurpose, 'cancel-required', 'retired');
    await coordinator.awaitOwner(owner);

    expect(coordinator.snapshot()).toEqual([
      expect.objectContaining({
        tradeId: 'Offer_cancel',
        stage: 'cancelling',
        recoveryId: 'SR_cancel_transport',
      }),
    ]);
    coordinator.providerReady(provider);
    await coordinator.awaitOwner(owner);

    expect(beginCancellation).toHaveBeenCalledTimes(1);
    expect(reconcileCancellation).toHaveBeenCalledTimes(2);
    expect(coordinator.snapshot()).toEqual([]);
  });

  it('drops cancellation recovery metadata when cancellation is required again', async () => {
    let finishReconcile!: () => void;
    const reconcile = new Promise<{
      status: 'unavailable';
      detail: string;
    }>((resolve) => {
      finishReconcile = () => resolve({ status: 'unavailable', detail: 'offline' });
    });
    const provider = recoverableProvider({
      beginCancellation: jest
        .fn()
        .mockResolvedValue({ status: 'pending', recoveryId: 'SR_cancel_exact' }),
      reconcileCancellation: jest.fn(() => reconcile),
    });
    const coordinator = new WalletOperationRuntime();
    coordinator.attachProvider(provider);
    coordinator.registerReserved('Offer_cancel', owner, fundingPurpose);
    coordinator.settleOperation(owner, fundingPurpose, 'cancel-required', 'first-retirement');
    await Promise.resolve();
    await Promise.resolve();

    coordinator.settleOperation(owner, fundingPurpose, 'cancel-required', 'second-retirement');
    const snapshot = coordinator.snapshot();
    expect(snapshot).toEqual([
      expect.objectContaining({
        tradeId: 'Offer_cancel',
        stage: 'cancel-required',
        reason: 'second-retirement',
      }),
    ]);
    expect(snapshot[0]).not.toHaveProperty('recoveryId');
    expect(() => encodeWalletOperationRecord(snapshot)).not.toThrow();
    finishReconcile();
    await coordinator.awaitOwner(owner);
  });

  it('uses collision-free keys for external scope and operation strings', () => {
    const firstOwner: WalletOperationOwner = {
      installationPlayerId: 'player\0peer',
      peerSessionId: 'session',
      providerScope: {
        provider: 'walletconnect',
        fingerprint: 'fingerprint\0chain',
        chainId: 'id',
      },
    };
    const secondOwner: WalletOperationOwner = {
      installationPlayerId: 'player',
      peerSessionId: 'peer\0session',
      providerScope: {
        provider: 'walletconnect',
        fingerprint: 'fingerprint',
        chainId: 'chain\0id',
      },
    };

    expect(walletProviderScopeKey(firstOwner.providerScope)).not.toBe(
      walletProviderScopeKey(secondOwner.providerScope),
    );
    expect(walletOperationOwnerKey(firstOwner)).not.toBe(walletOperationOwnerKey(secondOwner));
    expect(
      walletOperationKey(firstOwner, {
        kind: 'fee',
        operationId: 'operation\0suffix',
      }),
    ).not.toBe(
      walletOperationKey(secondOwner, {
        kind: 'fee',
        operationId: 'peer\0operation\0suffix',
      }),
    );
  });

  it('starts one best-effort replacement on a later readiness epoch', async () => {
    const ledger = new WalletOperationRuntime();
    const begin = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'transport lost' })
      .mockResolvedValueOnce({
        kind: 'created-reserved',
        material: { kind: 'offer', offer: 'offer1retry' },
        tradeId: 'trade-retry',
      });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: owner.providerScope,
      beginCreation: begin,
      cancel: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    ledger.attachProvider(provider);
    const operation = fundingTestPort(ledger, owner, fundingPurpose);

    await operation.createFunding(fundingRequest);
    await operation.createFunding(fundingRequest);
    ledger.providerReady(provider);
    await Promise.resolve();
    expect(begin).toHaveBeenCalledTimes(1);

    ledger.detachProvider(provider);
    ledger.attachProvider(provider);
    await ledger.awaitOwner(owner);
    await expect(operation.createFunding(fundingRequest)).resolves.toMatchObject({
      kind: 'created-reserved',
      tradeId: 'trade-retry',
    });

    expect(begin).toHaveBeenCalledTimes(2);
  });

  it('persists WalletConnect uncertainty and deduplicates readiness epochs across reload', async () => {
    const scopedOwner: WalletOperationOwner = {
      ...owner,
      providerScope: {
        provider: 'walletconnect',
        fingerprint: '123',
        chainId: 'chia:testnet11',
      },
    };
    const begin = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'response lost' })
      .mockResolvedValueOnce({
        kind: 'created-reserved',
        material: { kind: 'offer', offer: 'offer1replacement' },
        tradeId: 'trade-replacement',
      });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: scopedOwner.providerScope,
      beginCreation: begin,
      cancel: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    const first = new WalletOperationRuntime();
    first.attachProvider(provider);
    await fundingTestPort(first, scopedOwner, fundingPurpose).createFunding(fundingRequest);
    expect(first.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'best-effort-uncertain',
        generation: 0n,
        lastAttemptEpoch: 1n,
      }),
    ]);

    const restored = new WalletOperationRuntime();
    restored.restore(first.snapshot());
    restored.attachProvider(provider);
    restored.providerReady(provider);
    await Promise.resolve();
    expect(begin).toHaveBeenCalledTimes(1);

    restored.detachProvider(provider);
    restored.attachProvider(provider);
    await restored.awaitOwner(scopedOwner);
    restored.providerReady(provider);
    await restored.awaitOwner(scopedOwner);
    expect(begin).toHaveBeenCalledTimes(2);
  });

  it('rebases a restored high readiness epoch and retries exactly once per new edge', async () => {
    const scopedOwner: WalletOperationOwner = {
      ...owner,
      providerScope: {
        provider: 'walletconnect',
        fingerprint: '123',
        chainId: 'chia:testnet11',
      },
    };
    const begin = jest.fn().mockResolvedValue({ kind: 'unavailable', reason: 'still offline' });
    const provider: WalletOfferProvider = {
      capability: 'best-effort',
      scope: scopedOwner.providerScope,
      beginCreation: begin,
      cancel: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    };
    const restored = new WalletOperationRuntime();
    restored.restore([
      {
        owner: scopedOwner,
        purpose: fundingPurpose,
        stage: 'best-effort-uncertain',
        disposition: 'active',
        request: { kind: 'funding', canonical: fundingRequest },
        generation: 9n,
        lastAttemptEpoch: 99n,
        reason: 'walletconnect-response-unavailable',
        orphanRisk: 'pre-id-response-lost',
      },
    ]);

    restored.attachProvider(provider);
    await restored.awaitOwner(scopedOwner);
    expect(begin).toHaveBeenCalledTimes(1);
    expect(restored.snapshot()).toEqual([
      expect.objectContaining({ generation: 10n, lastAttemptEpoch: 1n }),
    ]);

    restored.providerReady(provider);
    await restored.awaitOwner(scopedOwner);
    expect(begin).toHaveBeenCalledTimes(1);

    restored.providerReconnectReady(provider);
    await restored.awaitOwner(scopedOwner);
    expect(begin).toHaveBeenCalledTimes(2);
  });

  it('coalesces readiness edges during an in-flight uncertain creation retry', async () => {
    let finishFirst!: (value: { kind: 'unavailable'; reason: string }) => void;
    const first = new Promise<{ kind: 'unavailable'; reason: string }>((resolve) => {
      finishFirst = resolve;
    });
    const begin = jest
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue({ kind: 'unavailable', reason: 'still unavailable' });
    const provider = recoverableAfterBeginProvider({ beginCreation: begin });
    const service = new WalletOperationRuntime();
    service.restore([
      {
        owner,
        purpose: fundingPurpose,
        stage: 'best-effort-uncertain',
        disposition: 'active',
        request: { kind: 'funding', canonical: fundingRequest },
        generation: 9n,
        lastAttemptEpoch: 99n,
        reason: 'cloud-response-unavailable',
        orphanRisk: 'pre-id-response-lost',
      },
    ]);

    service.attachProvider(provider);
    for (let turn = 0; turn < 10 && begin.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(begin).toHaveBeenCalledTimes(1);

    service.providerReconnectReady(provider);
    service.providerReconnectReady(provider);
    expect(begin).toHaveBeenCalledTimes(1);
    finishFirst({ kind: 'unavailable', reason: 'first retry unavailable' });
    await service.awaitOwner(owner);

    expect(begin).toHaveBeenCalledTimes(2);
    expect(service.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'best-effort-uncertain',
        generation: 11n,
        lastAttemptEpoch: 3n,
      }),
    ]);
    service.providerReady(provider);
    await service.awaitOwner(owner);
    expect(begin).toHaveBeenCalledTimes(2);
  });

  it('treats Cloud loss before a recovery id as uncertainty, then resumes exact recovery', async () => {
    const begin = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'accepted response lost' })
      .mockResolvedValueOnce({ kind: 'pending', recoveryId: 'SR_after_loss' });
    const reconcile = jest.fn().mockResolvedValue({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1afterloss' },
      tradeId: 'Offer_after_loss',
    });
    const provider = recoverableAfterBeginProvider({
      beginCreation: begin,
      reconcileCreation: reconcile,
    });
    const first = new WalletOperationRuntime();
    first.attachProvider(provider);

    await expect(
      fundingTestPort(first, owner, fundingPurpose).createFunding(fundingRequest),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: 'accepted response lost',
    });
    expect(first.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'best-effort-uncertain',
        reason: 'cloud-response-unavailable',
        orphanRisk: 'pre-id-response-lost',
      }),
    ]);

    const restored = new WalletOperationRuntime();
    restored.restore(first.snapshot());
    restored.attachProvider(provider);
    await restored.awaitOwner(owner);

    expect(begin).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledWith(
      { owner, purpose: fundingPurpose },
      expect.any(Object),
      'SR_after_loss',
    );
    expect(restored.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'reserved',
        tradeId: 'Offer_after_loss',
        orphanRisk: 'pre-id-response-lost',
      }),
    ]);
    await expect(
      fundingTestPort(restored, owner, fundingPurpose).createFunding(fundingRequest),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: 'created-reserved',
        warning: expect.stringMatching(/prior external reservation may still exist/i),
      }),
    );
  });

  it('persists Cloud cancellation uncertainty before retrying on a later readiness edge', async () => {
    const beginCancellation = jest
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable', detail: 'accepted response lost' })
      .mockResolvedValueOnce({ status: 'pending', recoveryId: 'SR_cancel_after_loss' });
    const reconcileCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'cancelled', detail: 'SUBMITTED' });
    const provider = recoverableAfterBeginProvider({
      beginCancellation,
      reconcileCancellation,
    });
    const service = new WalletOperationRuntime();
    service.attachProvider(provider);
    service.registerReserved('Offer_cancel_after_loss', owner, fundingPurpose);
    service.settleOperation(owner, fundingPurpose, 'cancel-required', 'retired');
    await service.awaitOwner(owner);

    expect(service.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'best-effort-cancellation-uncertain',
        lastAttemptEpoch: 1n,
        reason: 'cloud-cancellation-response-lost-orphan-risk',
      }),
    ]);
    service.providerReady(provider);
    await service.awaitOwner(owner);
    expect(beginCancellation).toHaveBeenCalledTimes(1);

    service.providerReconnectReady(provider);
    await service.awaitOwner(owner);
    expect(beginCancellation).toHaveBeenCalledTimes(2);
    expect(reconcileCancellation).toHaveBeenCalledWith(
      'Offer_cancel_after_loss',
      'SR_cancel_after_loss',
    );
    expect(service.snapshot()).toEqual([]);
  });

  it('retries every restored uncertain cancellation trade once per new readiness edge', async () => {
    const beginCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'unavailable', detail: 'still unavailable' });
    const provider = recoverableAfterBeginProvider({ beginCancellation });
    const service = new WalletOperationRuntime();
    service.restore(
      ['Offer_uncertain_a', 'Offer_uncertain_b'].map((tradeId) => ({
        tradeId,
        owner,
        purpose: fundingPurpose,
        stage: 'best-effort-cancellation-uncertain' as const,
        generation: 7n,
        lastAttemptEpoch: 99n,
        reason: 'cloud-cancellation-response-lost-orphan-risk',
      })),
    );

    service.attachProvider(provider);
    await service.awaitOwner(owner);
    expect(beginCancellation.mock.calls.map(([tradeId]) => tradeId).sort()).toEqual([
      'Offer_uncertain_a',
      'Offer_uncertain_b',
    ]);
    expect(service.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tradeId: 'Offer_uncertain_a',
          generation: 8n,
          lastAttemptEpoch: 1n,
        }),
        expect.objectContaining({
          tradeId: 'Offer_uncertain_b',
          generation: 8n,
          lastAttemptEpoch: 1n,
        }),
      ]),
    );

    service.providerReady(provider);
    await service.awaitOwner(owner);
    expect(beginCancellation).toHaveBeenCalledTimes(2);

    service.providerReconnectReady(provider);
    await service.awaitOwner(owner);
    expect(beginCancellation).toHaveBeenCalledTimes(4);
  });

  it('coalesces readiness edges during an in-flight uncertain cancellation retry', async () => {
    let finishFirst!: (value: { status: 'unavailable'; detail: string }) => void;
    const first = new Promise<{ status: 'unavailable'; detail: string }>((resolve) => {
      finishFirst = resolve;
    });
    const beginCancellation = jest
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue({ status: 'unavailable', detail: 'still unavailable' });
    const provider = recoverableAfterBeginProvider({ beginCancellation });
    const service = new WalletOperationRuntime();
    service.restore([
      {
        tradeId: 'Offer_deferred_cancel',
        owner,
        purpose: fundingPurpose,
        stage: 'best-effort-cancellation-uncertain',
        generation: 7n,
        lastAttemptEpoch: 99n,
        reason: 'cloud-cancellation-response-lost-orphan-risk',
      },
    ]);

    service.attachProvider(provider);
    for (let turn = 0; turn < 10 && beginCancellation.mock.calls.length === 0; turn += 1) {
      await Promise.resolve();
    }
    expect(beginCancellation).toHaveBeenCalledTimes(1);

    service.providerReconnectReady(provider);
    service.providerReconnectReady(provider);
    expect(beginCancellation).toHaveBeenCalledTimes(1);
    finishFirst({ status: 'unavailable', detail: 'first retry unavailable' });
    await service.awaitOwner(owner);

    expect(beginCancellation).toHaveBeenCalledTimes(2);
    expect(service.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'best-effort-cancellation-uncertain',
        generation: 9n,
        lastAttemptEpoch: 3n,
      }),
    ]);
    service.providerReady(provider);
    await service.awaitOwner(owner);
    expect(beginCancellation).toHaveBeenCalledTimes(2);
  });

  it('preserves Cloud orphan provenance through post-id unavailability and reload', async () => {
    const begin = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'accepted response lost' })
      .mockResolvedValueOnce({ kind: 'pending', recoveryId: 'SR_persisted_after_loss' });
    const reconcile = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'approval still pending' })
      .mockResolvedValueOnce({
        kind: 'created-reserved',
        material: { kind: 'offer', offer: 'offer1eventual' },
        tradeId: 'Offer_eventual',
      });
    const provider = recoverableAfterBeginProvider({
      beginCreation: begin,
      reconcileCreation: reconcile,
    });
    const first = new WalletOperationRuntime();
    first.attachProvider(provider);
    await fundingTestPort(first, owner, fundingPurpose).createFunding(fundingRequest);
    first.providerReconnectReady(provider);
    await first.awaitOwner(owner);
    expect(first.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'creating',
        recoveryId: 'SR_persisted_after_loss',
        orphanRisk: 'pre-id-response-lost',
      }),
    ]);

    const restored = new WalletOperationRuntime();
    restored.restore(first.snapshot());
    restored.attachProvider(provider);
    await expect(
      fundingTestPort(restored, owner, fundingPurpose).createFunding(fundingRequest),
    ).resolves.toEqual(
      expect.objectContaining({
        kind: 'created-reserved',
        tradeId: 'Offer_eventual',
        warning: expect.stringMatching(/prior external reservation may still exist/i),
      }),
    );
    expect(begin).toHaveBeenCalledTimes(2);
    expect(reconcile).toHaveBeenCalledTimes(2);
    expect(restored.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'reserved',
        tradeId: 'Offer_eventual',
        orphanRisk: 'pre-id-response-lost',
      }),
    ]);
  });

  it('reconciles a retired creation and cancels its late exact trade', async () => {
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const provider = recoverableProvider({
      reconcileCreation: jest
        .fn()
        .mockResolvedValueOnce({ kind: 'unavailable', reason: 'pending' })
        .mockResolvedValueOnce({
          kind: 'created-reserved',
          material: { kind: 'offer', offer: 'offer1late' },
          tradeId: 'Offer_late',
        }),
      beginCancellation: cancel,
    });
    const coordinator = new WalletOperationRuntime();
    coordinator.attachProvider(provider);
    const operation = fundingTestPort(coordinator, owner, fundingPurpose);
    await operation.createFunding(fundingRequest);
    coordinator.retireSession(
      owner.installationPlayerId,
      owner.peerSessionId,
      'controller-retired',
    );
    expect(coordinator.snapshot()).toEqual([
      expect.objectContaining({ stage: 'creating', disposition: 'cancel-on-create' }),
    ]);

    coordinator.detachProvider(provider);
    coordinator.attachProvider(provider);
    await coordinator.awaitOwner(owner);

    expect(cancel).toHaveBeenCalledWith('Offer_late');
    expect(coordinator.snapshot()).toEqual([]);
  });

  it('warns when restored retired exact recovery consumes orphan-risk provenance', async () => {
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const provider = recoverableAfterBeginProvider({
      reconcileCreation: jest.fn().mockResolvedValue({
        kind: 'created-reserved',
        material: { kind: 'offer', offer: 'offer1retiredorphan' },
        tradeId: 'Offer_retired_orphan',
      }),
      beginCancellation: cancel,
    });
    const service = new WalletOperationRuntime();
    service.restore([
      {
        owner,
        purpose: fundingPurpose,
        stage: 'creating',
        disposition: 'cancel-on-create',
        recoveryId: 'SR_retired_orphan',
        request: { kind: 'funding', canonical: fundingRequest },
        reason: 'approval-pending',
        orphanRisk: 'pre-id-response-lost',
      },
    ]);
    jest.mocked(log).mockClear();

    service.attachProvider(provider);
    await service.awaitOwner(owner);

    expect(log).toHaveBeenCalledWith(
      expect.stringMatching(/prior external reservation may still exist/i),
    );
    expect(cancel).toHaveBeenCalledWith('Offer_retired_orphan');
    expect(service.snapshot()).toEqual([]);
  });

  it('marks a recovery id cancel-on-create when retirement wins before begin returns', async () => {
    let finishBegin!: (value: { kind: 'pending'; recoveryId: string }) => void;
    const begin = new Promise<{ kind: 'pending'; recoveryId: string }>((resolve) => {
      finishBegin = resolve;
    });
    const provider = recoverableProvider({
      beginCreation: jest.fn(() => begin),
      reconcileCreation: jest.fn().mockResolvedValue({ kind: 'unavailable', reason: 'pending' }),
    });
    const coordinator = new WalletOperationRuntime();
    coordinator.attachProvider(provider);
    const operation = fundingTestPort(coordinator, owner, fundingPurpose);

    const creation = operation.createFunding(fundingRequest);
    operation.retire('controller-retired-before-recovery-id');
    finishBegin({ kind: 'pending', recoveryId: 'SR_late_begin' });
    await creation;

    expect(coordinator.snapshot()).toEqual([
      expect.objectContaining({
        stage: 'creating',
        disposition: 'cancel-on-create',
        recoveryId: 'SR_late_begin',
      }),
    ]);
  });

  it('retires only reserved funding and fee entries while preserving replay retention', () => {
    const ledger = new WalletOperationRuntime();
    ledger.registerReserved('funding', owner, fundingPurpose);
    ledger.registerReserved('fee-cancel', owner, { kind: 'fee', operationId: 'fee-a' });
    ledger.registerReserved('fee-replay', owner, { kind: 'fee', operationId: 'fee-b' });
    ledger.settleOperation(
      owner,
      { kind: 'fee', operationId: 'fee-b' },
      'retained-for-replay',
      'fee-source-attached',
    );

    ledger.retireSession(owner.installationPlayerId, owner.peerSessionId, 'controller-retired');

    expect(entriesForOwner(ledger.snapshot(), owner)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tradeId: 'funding', stage: 'cancel-required' }),
        expect.objectContaining({ tradeId: 'fee-cancel', stage: 'cancel-required' }),
        expect.objectContaining({ tradeId: 'fee-replay', stage: 'retained-for-replay' }),
      ]),
    );
  });

  it('retires the whole session before terminal checks and preserves Rust replay ownership', async () => {
    const reconcile = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'offline' })
      .mockResolvedValueOnce({
        kind: 'created-reserved',
        material: { kind: 'offer', offer: 'offer1terminal' },
        tradeId: 'terminal-late-trade',
      });
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const provider = recoverableProvider({
      reconcileCreation: reconcile,
      beginCancellation: cancel,
    });
    const service = new WalletOperationRuntime();
    service.attachProvider(provider);
    await fundingTestPort(service, owner, fundingPurpose).createFunding(fundingRequest);
    service.registerReserved('fee-replay', owner, {
      kind: 'fee',
      operationId: 'submission-retained',
    });
    service.settleOperation(
      owner,
      { kind: 'fee', operationId: 'submission-retained' },
      'retained-for-replay',
      'fee-source-attached',
    );

    service.retireSession('player', 'session', 'session-terminal');
    expect(service.snapshot()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ stage: 'creating', disposition: 'cancel-on-create' }),
        expect.objectContaining({ stage: 'retained-for-replay', tradeId: 'fee-replay' }),
      ]),
    );

    service.detachProvider(provider);
    service.attachProvider(provider);
    await service.awaitOwner(owner);
    expect(cancel).toHaveBeenCalledWith('terminal-late-trade');
    expect(service.snapshot()).toEqual([
      expect.objectContaining({ stage: 'retained-for-replay', tradeId: 'fee-replay' }),
    ]);
  });
});
