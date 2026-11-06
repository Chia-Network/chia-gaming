import 'fake-indexeddb/auto';
import { activeSave } from './session_save_envelope.fixtures';
import type { WalletOfferProvider } from '../../types/ChiaGaming';
import { FeeAttachmentRuntime } from '../session/feeAttachmentRuntime';
import type { FeeAttachment, FeeAttachmentOwner } from '../session/feeAttachmentStore';
import { readApplicationState, StorageAuthorityLostError } from '../session/indexedDb';
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

  it('waits for live submission demand before replacing restored creation uncertainty', async () => {
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
    providers.ready(provider);
    await runtime.awaitIdle();
    expect(beginCreation).not.toHaveBeenCalled();

    await runtime.reserve(owner, 'restored-create', request, () => false);
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
    storageRepository._replaceApplicationStateForTests({
      ...storageRepository.loadState(),
      session: activeSave().session,
    });
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

    await runtime.reserve(owner, 'reclaimed-create', request, () => false);
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
    expect(beginCreation).toHaveBeenCalledTimes(1);
    await replacement.reserve(owner, 'reclaimed-create', request, () => false);
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
    storageRepository._replaceApplicationStateForTests({
      ...storageRepository.loadState(),
      session: activeSave().session,
    });
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

  describe('a creation whose consumer died after the recovery id', () => {
    const created = {
      kind: 'created-reserved' as const,
      material: { kind: 'offer' as const, offer: 'offer1late' },
      tradeId: 'late-trade',
    };
    const pendingBegin = { kind: 'pending' as const, recoveryId: 'fee-request' };
    const unavailable = { kind: 'unavailable' as const, reason: 'approval window closed' };
    const retiredCreation = expect.objectContaining({
      stage: 'creating',
      disposition: 'cancel-on-create',
      recoveryId: 'fee-request',
    });
    const restoredCreation: FeeAttachment = {
      owner,
      submissionId: 'fee',
      stage: 'creating',
      disposition: 'cancel-on-create',
      request,
      recoveryId: 'fee-request',
      reason: 'fee-creation-pending',
    };

    function deferred<T>() {
      let resolve!: (value: T) => void;
      const promise = new Promise<T>((settle) => {
        resolve = settle;
      });
      return { promise, resolve };
    }

    function wallet() {
      return {
        scope: owner.providerScope,
        capability: 'recoverable-after-begin' as const,
        beginCreation: jest.fn().mockResolvedValue(pendingBegin),
        reconcileCreation: jest.fn().mockResolvedValue(created),
        beginCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' }),
        reconcileCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' }),
      };
    }

    function attach(provider: ReturnType<typeof wallet>) {
      const providers = new WalletProviderRegistry();
      providers.attach(provider);
      return { providers, runtime: new FeeAttachmentRuntime(ports(), providers) };
    }

    it('persists the request before reconciling when retirement beat the begin response', async () => {
      const begin = deferred<typeof pendingBegin>();
      const reconcile = deferred<typeof created>();
      const cancellation = deferred<{ status: 'cancelled' }>();
      const provider = wallet();
      provider.beginCreation.mockReturnValue(begin.promise);
      provider.reconcileCreation.mockReturnValue(reconcile.promise);
      provider.beginCancellation.mockResolvedValue({
        status: 'pending',
        recoveryId: 'cancel-request',
      });
      provider.reconcileCancellation.mockReturnValue(cancellation.promise);
      const { runtime } = attach(provider);
      let inactive = false;
      const reservation = runtime.reserve(owner, 'fee', request, () => inactive);
      await waitFor(() => provider.beginCreation.mock.calls.length === 1);

      inactive = true;
      runtime.retire(owner, 'fee');
      expect(storageRepository.feeAttachments()).toEqual([]);
      begin.resolve(pendingBegin);
      await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);
      expect((await readApplicationState())?.feeAttachments).toEqual([retiredCreation]);

      reconcile.resolve(created);
      await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
      await waitFor(() => provider.reconcileCancellation.mock.calls.length === 1);
      expect(storageRepository.feeAttachments()).toEqual([
        expect.objectContaining({
          stage: 'cancelling',
          providerReservationId: 'late-trade',
          recoveryId: 'cancel-request',
        }),
      ]);

      cancellation.resolve({ status: 'cancelled' });
      await runtime.awaitIdle();
      expect(storageRepository.feeAttachments()).toEqual([]);
      runtime.detach();
    });

    it.each(['begin', 'reconcile'] as const)(
      'hands a delivery revoked during %s to one cleanup without waiting for readiness',
      async (phase) => {
        const begin = deferred<typeof pendingBegin>();
        const delivery = deferred<typeof unavailable>();
        const cleanup = deferred<typeof created>();
        const provider = wallet();
        if (phase === 'begin') provider.beginCreation.mockReturnValue(begin.promise);
        provider.reconcileCreation
          .mockReturnValueOnce(phase === 'begin' ? Promise.resolve(unavailable) : delivery.promise)
          .mockReturnValueOnce(cleanup.promise);
        const { providers, runtime } = attach(provider);
        let inactive = false;
        const reservation = runtime.reserve(owner, 'fee', request, () => inactive);
        await waitFor(() =>
          phase === 'begin'
            ? provider.beginCreation.mock.calls.length === 1
            : provider.reconcileCreation.mock.calls.length === 1,
        );
        inactive = true;
        runtime.retire(owner, 'fee');
        runtime.retire(owner, 'fee');
        expect(provider.reconcileCreation).toHaveBeenCalledTimes(phase === 'begin' ? 0 : 1);
        begin.resolve(pendingBegin);
        delivery.resolve(unavailable);
        await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
        await waitFor(() => provider.reconcileCreation.mock.calls.length === 2);
        expect(provider.reconcileCreation).toHaveBeenLastCalledWith(
          expect.anything(),
          request,
          'fee-request',
          { mode: 'observe-only' },
        );
        expect(storageRepository.feeAttachments()).toEqual([retiredCreation]);
        await expect(runtime.reserve(owner, 'fee', request, () => false)).resolves.toMatchObject({
          kind: 'unavailable',
        });

        runtime.retire(owner, 'fee');
        providers.ready(provider);
        providers.reconnectReady(provider);
        await readApplicationState();
        expect(provider.reconcileCreation).toHaveBeenCalledTimes(2);
        cleanup.resolve(created);
        await runtime.awaitIdle();
        expect(provider.beginCreation).toHaveBeenCalledTimes(1);
        expect(provider.beginCancellation).toHaveBeenCalledTimes(1);
        expect(storageRepository.feeAttachments()).toEqual([]);
        runtime.detach();
      },
    );

    it('retains unavailable handed-off cleanup without immediately retrying it', async () => {
      const delivery = deferred<typeof unavailable>();
      const provider = wallet();
      provider.reconcileCreation
        .mockReturnValueOnce(delivery.promise)
        .mockResolvedValueOnce(unavailable)
        .mockResolvedValue(created);
      const { providers, runtime } = attach(provider);
      let inactive = false;
      const reservation = runtime.reserve(owner, 'fee', request, () => inactive);
      await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);
      inactive = true;
      runtime.retire(owner, 'fee');
      delivery.resolve(unavailable);
      await reservation;
      await runtime.awaitIdle();
      expect(provider.reconcileCreation).toHaveBeenCalledTimes(2);
      expect(storageRepository.feeAttachments()).toEqual([retiredCreation]);
      await readApplicationState();
      expect(provider.reconcileCreation).toHaveBeenCalledTimes(2);
      expect(provider.beginCancellation).not.toHaveBeenCalled();

      providers.reconnectReady(provider);
      await runtime.awaitIdle();
      expect(provider.reconcileCreation).toHaveBeenCalledTimes(3);
      expect(provider.beginCancellation).toHaveBeenCalledTimes(1);
      expect(storageRepository.feeAttachments()).toEqual([]);
      runtime.detach();
    });

    it.each(['detach', 'clear', 'hard-reset', 'retained-replay'] as const)(
      'does not start a queued cleanup after %s changes its ownership',
      async (ending) => {
        const delivery = deferred<typeof unavailable>();
        const provider = wallet();
        provider.reconcileCreation.mockReturnValueOnce(delivery.promise);
        const { runtime } = attach(provider);
        let inactive = false;
        const reservation = runtime.reserve(owner, 'fee', request, () => inactive);
        await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);
        inactive = true;
        runtime.retire(owner, 'fee');
        if (ending === 'detach') runtime.detach();
        else if (ending === 'clear') await storageRepository.clearSession();
        else if (ending === 'hard-reset') await storageRepository.hardReset();
        else
          install([
            {
              owner,
              submissionId: 'fee',
              stage: 'retained-for-replay',
              providerReservationId: 'late-trade',
              reason: 'fee-offer-created',
            },
          ]);
        delivery.resolve(unavailable);
        await reservation;
        await runtime.awaitIdle();
        expect(provider.reconcileCreation).toHaveBeenCalledTimes(1);
        expect(provider.beginCancellation).not.toHaveBeenCalled();
        if (ending === 'clear' || ending === 'hard-reset')
          expect(storageRepository.feeAttachments()).toEqual([]);
        if (ending === 'retained-replay')
          expect(storageRepository.feeAttachments()).toEqual([
            expect.objectContaining({ stage: 'retained-for-replay' }),
          ]);
        runtime.detach();
      },
    );

    it('preserves cleanup across readiness arriving as the revoked delivery settles', async () => {
      const reconcile = deferred<typeof unavailable>();
      const provider = wallet();
      provider.reconcileCreation.mockReturnValueOnce(reconcile.promise);
      const { providers, runtime } = attach(provider);
      let inactive = false;
      const reservation = runtime.reserve(owner, 'fee', request, () => inactive);
      await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);

      inactive = true;
      runtime.retire(owner, 'fee');
      reconcile.resolve(unavailable);
      await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
      expect(storageRepository.feeAttachments()).toEqual([retiredCreation]);
      expect(provider.beginCancellation).not.toHaveBeenCalled();

      providers.reconnectReady(provider);
      await runtime.awaitIdle();
      expect(provider.reconcileCreation).toHaveBeenLastCalledWith(
        expect.anything(),
        expect.anything(),
        'fee-request',
        { mode: 'observe-only' },
      );
      expect(provider.beginCreation).toHaveBeenCalledTimes(1);
      expect(provider.beginCancellation).toHaveBeenCalledWith('late-trade');
      expect(storageRepository.feeAttachments()).toEqual([]);
      runtime.detach();
    });

    it('keeps a restored retired request through unavailable reconciliation', async () => {
      install([restoredCreation]);
      const provider = wallet();
      provider.reconcileCreation.mockResolvedValue(unavailable);
      const { runtime } = attach(provider);

      await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);
      await runtime.awaitIdle();
      expect(storageRepository.feeAttachments()).toEqual([retiredCreation]);
      runtime.detach();
    });

    it('forgets a live flight only after the wallet definitively fails the request', async () => {
      const provider = wallet();
      provider.reconcileCreation.mockResolvedValue({ kind: 'failure', reason: 'rejected' });
      const { runtime } = attach(provider);

      await runtime.reserve(owner, 'fee', request, () => true);
      expect(provider.reconcileCreation).toHaveBeenCalledTimes(1);
      expect(storageRepository.feeAttachments()).toEqual([]);
      expect(provider.beginCancellation).not.toHaveBeenCalled();
      runtime.detach();
    });

    it('forgets a restored request after the wallet definitively fails it', async () => {
      install([restoredCreation]);
      const provider = wallet();
      provider.reconcileCreation.mockResolvedValue({ kind: 'failure', reason: 'rejected' });
      const { runtime } = attach(provider);

      await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);
      await runtime.awaitIdle();
      expect(storageRepository.feeAttachments()).toEqual([]);
      expect(provider.beginCancellation).not.toHaveBeenCalled();
      runtime.detach();
    });

    it.each(['before the begin response', 'during reconciliation'])(
      'lets a successor attempt fall back without a second offer when displaced %s',
      async (when) => {
        const begin = deferred<typeof pendingBegin>();
        const reconcile = deferred<typeof unavailable>();
        const cancellation = deferred<{ status: 'cancelled' }>();
        const provider = wallet();
        provider.beginCreation
          .mockReturnValueOnce(
            when === 'before the begin response' ? begin.promise : Promise.resolve(pendingBegin),
          )
          .mockResolvedValue({ kind: 'failure', reason: 'fresh begin' });
        provider.reconcileCreation.mockReturnValueOnce(
          when === 'before the begin response' ? Promise.resolve(unavailable) : reconcile.promise,
        );
        provider.beginCancellation.mockResolvedValue({
          status: 'pending',
          recoveryId: 'cancel-request',
        });
        provider.reconcileCancellation.mockReturnValue(cancellation.promise);
        const { providers, runtime } = attach(provider);
        let displaced = false;
        const first = runtime.reserve(owner, 'fee', request, () => displaced);
        await waitFor(() =>
          when === 'before the begin response'
            ? provider.beginCreation.mock.calls.length === 1
            : provider.reconcileCreation.mock.calls.length === 1,
        );

        displaced = true;
        begin.resolve(pendingBegin);
        reconcile.resolve(unavailable);
        await expect(first).resolves.toMatchObject({ kind: 'unavailable' });
        expect(storageRepository.feeAttachments()).toEqual([retiredCreation]);

        await expect(runtime.reserve(owner, 'fee', request, () => false)).resolves.toMatchObject({
          kind: 'unavailable',
        });
        expect(provider.reconcileCreation).toHaveBeenCalledTimes(1);

        providers.reconnectReady(provider);
        await waitFor(() => provider.reconcileCancellation.mock.calls.length === 1);
        await expect(runtime.reserve(owner, 'fee', request, () => false)).resolves.toMatchObject({
          kind: 'unavailable',
        });
        expect(provider.beginCreation).toHaveBeenCalledTimes(1);

        cancellation.resolve({ status: 'cancelled' });
        await runtime.awaitIdle();
        expect(storageRepository.feeAttachments()).toEqual([]);
        await expect(runtime.reserve(owner, 'fee', request, () => false)).resolves.toEqual({
          kind: 'failure',
          reason: 'fresh begin',
        });
        runtime.detach();
      },
    );

    it('keeps a retired request gone until its offer is identified, then cleans up durably', async () => {
      install([
        {
          owner,
          submissionId: 'fee',
          stage: 'best-effort-uncertain',
          disposition: 'active',
          request,
          lastAttemptEpoch: 0n,
          reason: 'response-lost',
          orphanRisk: 'pre-id-response-lost',
        },
      ]);
      const begin = deferred<typeof pendingBegin>();
      const reconcile = deferred<typeof created>();
      const provider = wallet();
      provider.beginCreation.mockReturnValue(begin.promise);
      provider.reconcileCreation.mockReturnValue(reconcile.promise);
      const { runtime } = attach(provider);
      const reservation = runtime.reserve(owner, 'fee', request, () => false);
      await waitFor(() => provider.beginCreation.mock.calls.length === 1);

      storageRepository.retireSessionWalletReservations(owner.peerSessionId);
      begin.resolve(pendingBegin);
      await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);
      expect(storageRepository.feeAttachments()).toEqual([]);

      reconcile.resolve(created);
      await reservation;
      await runtime.awaitIdle();
      await waitFor(() => provider.beginCancellation.mock.calls.length === 1);
      expect(provider.beginCancellation).toHaveBeenCalledWith('late-trade');
      expect(storageRepository.feeAttachments()).toEqual([]);
      runtime.detach();
    });

    describe('once the offer is identified', () => {
      const refused = { status: 'unavailable' as const, detail: 'feature flag missing' };
      const cancellationRecord = [
        expect.objectContaining({
          stage: 'best-effort-cancellation-uncertain',
          providerReservationId: 'late-trade',
        }),
      ];

      function restoredRequest(): FeeAttachment {
        return { ...restoredCreation, disposition: 'active' };
      }

      it('keeps the record when the consumer dies during the installed reservation checkpoint', async () => {
        const provider = wallet();
        provider.beginCancellation.mockResolvedValue(refused);
        const providers = new WalletProviderRegistry();
        providers.attach(provider);
        let inactive = false;
        const runtime = new FeeAttachmentRuntime(
          {
            ...ports(),
            requestCommit: () => {
              if (storageRepository.feeAttachments()[0]?.stage === 'reserved') inactive = true;
            },
          },
          providers,
        );

        await expect(runtime.reserve(owner, 'fee', request, () => inactive)).resolves.toMatchObject(
          { kind: 'unavailable' },
        );
        await waitFor(() => provider.beginCancellation.mock.calls.length === 1);
        await runtime.awaitIdle();

        expect(storageRepository.feeAttachments()).toEqual(cancellationRecord);
        runtime.detach();
      });

      it('never hands a recovered offer to a successor once it is being cancelled', async () => {
        install([restoredRequest()]);
        const provider = wallet();
        provider.beginCancellation.mockResolvedValue(refused);
        const { runtime } = attach(provider);
        await runtime.reserve(owner, 'fee', request, () => false);
        await runtime.awaitIdle();

        runtime.retire(owner, 'fee');
        await runtime.awaitIdle();

        await expect(runtime.reserve(owner, 'fee', request, () => false)).resolves.toEqual({
          kind: 'unavailable',
          reason: 'An earlier fee offer is still being retired',
        });
        expect(storageRepository.feeAttachments()).toEqual(cancellationRecord);
        expect(provider.beginCreation).not.toHaveBeenCalled();
        runtime.detach();
      });

      it('records a direct offer returned to a dead consumer, and retries a refused cancel', async () => {
        const creation = deferred<typeof created>();
        const cancel = jest.fn().mockResolvedValueOnce(refused);
        const provider: WalletOfferProvider = {
          capability: 'best-effort',
          scope: owner.providerScope,
          beginCreation: jest.fn(() => creation.promise),
          cancel,
        };
        const providers = new WalletProviderRegistry();
        providers.attach(provider);
        const runtime = new FeeAttachmentRuntime(ports(), providers);
        let inactive = false;
        const reservation = runtime.reserve(owner, 'fee', request, () => inactive);
        await waitFor(() => (provider.beginCreation as jest.Mock).mock.calls.length === 1);

        inactive = true;
        creation.resolve(created);
        await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
        await runtime.awaitIdle();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(storageRepository.feeAttachments()).toEqual([
          expect.objectContaining({
            stage: 'cancel-required',
            providerReservationId: 'late-trade',
          }),
        ]);

        cancel.mockResolvedValue({ status: 'cancelled' });
        providers.reconnectReady(provider);
        await runtime.awaitIdle();
        expect(cancel).toHaveBeenCalledTimes(2);
        expect(storageRepository.feeAttachments()).toEqual([]);
        runtime.detach();
      });

      it('cancels a direct offer best effort after its live session was cleared', async () => {
        storageRepository._replaceApplicationStateForTests({
          ...storageRepository.loadState(),
          session: activeSave().session,
        });
        const creation = deferred<typeof created>();
        const provider = wallet();
        provider.beginCreation.mockReturnValue(creation.promise);
        provider.beginCancellation.mockResolvedValue(refused);
        const { runtime } = attach(provider);
        let inactive = false;
        const reservation = runtime.reserve(owner, 'fee', request, () => inactive);
        await waitFor(() => provider.beginCreation.mock.calls.length === 1);

        await storageRepository.clearSession();
        inactive = true;
        creation.resolve(created);
        await reservation;
        await runtime.awaitIdle();

        await waitFor(() => provider.beginCancellation.mock.calls.length === 1);
        expect(storageRepository.feeAttachments()).toEqual([]);
        runtime.detach();
      });

      it.each([false, true])(
        'leaves an attached offer to replay when a stale flight dies (owner missing: %s)',
        async (ownerMissing) => {
          install([restoredRequest()]);
          const staleReconcile = deferred<typeof created>();
          const provider = wallet();
          provider.reconcileCreation.mockReset();
          provider.reconcileCreation.mockReturnValue(staleReconcile.promise);
          const providers = new WalletProviderRegistry();
          providers.attach(provider);
          let retired = false;
          const runtime = new FeeAttachmentRuntime(
            {
              ...ports(),
              isRetired: () => retired,
              getOwner: () => (retired && ownerMissing ? null : owner),
            },
            providers,
          );
          const reservation = runtime.reserve(owner, 'fee', request, () => false);
          await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);
          const attached: FeeAttachment = {
            owner,
            submissionId: 'fee',
            stage: 'retained-for-replay',
            providerReservationId: 'late-trade',
            reason: 'fee-offer-created',
          };
          install([attached]);

          retired = true;
          staleReconcile.resolve(created);
          await reservation;
          await runtime.awaitIdle();

          expect(provider.beginCancellation).not.toHaveBeenCalled();
          expect(storageRepository.feeAttachments()).toEqual([attached]);
          runtime.detach();
        },
      );
    });

    it('reconciles once when wallet readiness changes during an active fee request', async () => {
      const reconcile = deferred<typeof created>();
      const provider = wallet();
      provider.reconcileCreation.mockReturnValue(reconcile.promise);
      const { providers, runtime } = attach(provider);
      let inactive = false;
      const reservation = runtime.reserve(owner, 'fee', request, () => inactive);
      await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);
      providers.reconnectReady(provider);
      providers.ready(provider);

      inactive = true;
      runtime.retire(owner, 'fee');
      reconcile.resolve(created);
      await reservation;
      await runtime.awaitIdle();
      expect(provider.reconcileCreation).toHaveBeenCalledTimes(1);
      expect(provider.beginCancellation).toHaveBeenCalledTimes(1);
      expect(storageRepository.feeAttachments()).toEqual([]);
      runtime.detach();
    });

    it('hands a recovery ID returned after detach to independent retirement observation', async () => {
      const begin = deferred<typeof pendingBegin>();
      const observed = deferred<typeof created>();
      const provider = wallet();
      provider.beginCreation.mockReturnValue(begin.promise);
      provider.reconcileCreation.mockImplementation((_operation, _request, _id, options) =>
        options?.mode === 'observe-only'
          ? observed.promise
          : Promise.resolve({ kind: 'unavailable', reason: 'delivery retired' }),
      );
      const { runtime } = attach(provider);
      const reservation = runtime.reserve(owner, 'fee', request, () => false);
      await waitFor(() => provider.beginCreation.mock.calls.length === 1);
      runtime.detach();
      begin.resolve(pendingBegin);
      await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
      await runtime.awaitIdle();
      expect(storageRepository.feeAttachments()).toEqual([]);
      expect(provider.reconcileCreation).toHaveBeenCalledWith(
        expect.anything(),
        request,
        'fee-request',
        { mode: 'observe-only' },
      );
      expect(provider.beginCancellation).not.toHaveBeenCalled();

      observed.resolve(created);
      await waitFor(() => provider.beginCancellation.mock.calls.length === 1);
      expect(provider.beginCancellation).toHaveBeenCalledWith('late-trade');
      expect(provider.beginCreation).toHaveBeenCalledTimes(1);
      expect(storageRepository.feeAttachments()).toEqual([]);
    });

    it.each(['clear', 'terminal'])(
      'does not resurrect a fee recovery after %s teardown',
      async (ending) => {
        install([{ ...restoredCreation, disposition: 'active' }]);
        const reconcile = deferred<typeof created>();
        const provider = wallet();
        provider.reconcileCreation.mockReturnValue(reconcile.promise);
        provider.beginCancellation.mockResolvedValue({ status: 'unavailable', detail: 'offline' });
        const providers = new WalletProviderRegistry();
        providers.attach(provider);
        let attached = true;
        const runtime = new FeeAttachmentRuntime(
          {
            ...ports(),
            getOwner: () => (attached ? owner : null),
          },
          providers,
        );
        runtime.retire(owner, 'fee');
        await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);
        if (ending === 'clear') await storageRepository.clearSession();
        else storageRepository.retireSessionWalletReservations(owner.peerSessionId);
        attached = false;
        runtime.detach();
        reconcile.resolve(created);
        await runtime.awaitIdle();
        expect(storageRepository.feeAttachments()).toEqual([]);
        await waitFor(() => provider.beginCancellation.mock.calls.length === 1);
        expect(provider.beginCancellation).toHaveBeenCalledWith('late-trade');
      },
    );

    it('reconciles a restored request immediately when Rust retires its submission', async () => {
      install([{ ...restoredCreation, disposition: 'active' }]);
      const provider = wallet();
      const { runtime } = attach(provider);
      runtime.retire(owner, 'fee');
      await runtime.awaitIdle();
      expect(provider.beginCreation).not.toHaveBeenCalled();
      expect(provider.reconcileCreation).toHaveBeenCalledTimes(1);
      expect(provider.beginCancellation).toHaveBeenCalledWith('late-trade');
      expect(storageRepository.feeAttachments()).toEqual([]);
      runtime.detach();
    });

    it('does not replace an unidentified retired offer on reload or wallet readiness', async () => {
      install([
        {
          owner,
          submissionId: 'fee',
          stage: 'best-effort-uncertain',
          disposition: 'cancel-on-create',
          request,
          lastAttemptEpoch: 0n,
          reason: 'response-lost',
          orphanRisk: 'pre-id-response-lost',
        },
      ]);
      const provider = wallet();
      const { providers, runtime } = attach(provider);
      await runtime.awaitIdle();
      providers.reconnectReady(provider);
      await runtime.awaitIdle();
      expect(provider.beginCreation).not.toHaveBeenCalled();
      expect(provider.reconcileCreation).not.toHaveBeenCalled();
      expect(storageRepository.feeAttachments()).toEqual([
        expect.objectContaining({
          disposition: 'cancel-on-create',
          orphanRisk: 'pre-id-response-lost',
        }),
      ]);
      runtime.detach();
    });

    it('leaves restored active creation untouched until a live submission requests it', async () => {
      install([{ ...restoredCreation, disposition: 'active' }]);
      const reconcile = deferred<typeof created>();
      const provider = wallet();
      provider.reconcileCreation.mockReturnValue(reconcile.promise);
      const { providers, runtime } = attach(provider);
      await new Promise((resolve) => setTimeout(resolve, 0));
      providers.reconnectReady(provider);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(provider.beginCreation).not.toHaveBeenCalled();
      expect(provider.reconcileCreation).not.toHaveBeenCalled();

      const reservation = runtime.reserve(owner, 'fee', request, () => false);
      await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);
      providers.reconnectReady(provider);
      reconcile.resolve(created);
      await expect(reservation).resolves.toEqual(created);
      runtime.retain(owner, 'fee');
      await runtime.awaitIdle();
      expect(provider.reconcileCreation).toHaveBeenCalledTimes(1);
      expect(storageRepository.feeAttachments()).toEqual([
        expect.objectContaining({ stage: 'retained-for-replay' }),
      ]);
      runtime.detach();
    });
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
      expect.objectContaining({ mode: 'delivery', allowApproval: expect.any(Function) }),
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
    const reservation = runtime.reserve(owner, 'dead-recovery-cache', request, () => false);
    await waitFor(() => provider.reconcileCreation.mock.calls.length === 1);

    runtime.retire(owner, 'dead-recovery-cache');
    resolveReconcile({
      kind: 'created-reserved',
      material: { kind: 'offer', offer: 'offer1recovereddead' },
      tradeId: 'dead-recovery-cache-trade',
    });
    await reservation;
    await runtime.awaitIdle();
    await waitFor(() => beginCancellation.mock.calls.length === 1);
    expect(storageRepository.feeAttachments()).toEqual([]);

    await expect(
      runtime.reserve(owner, 'dead-recovery-cache', request, () => false),
    ).resolves.toEqual({ kind: 'failure', reason: 'new attempt' });
    expect(beginCreation).toHaveBeenCalledTimes(1);
    runtime.detach();
  });

  it.each(['unavailable', 'throw'])(
    'does not recreate pre-id uncertainty after live-session clear (%s)',
    async (outcome) => {
      storageRepository._replaceApplicationStateForTests(activeSave());
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const provider: WalletOfferProvider = {
        capability: 'best-effort',
        scope: owner.providerScope,
        beginCreation: jest.fn(async () => {
          await pending;
          if (outcome === 'throw') throw new Error('response lost');
          return { kind: 'unavailable' as const, reason: 'response lost' };
        }),
        cancel: jest.fn(),
      };
      const providers = new WalletProviderRegistry();
      providers.attach(provider);
      const runtime = new FeeAttachmentRuntime(ports(), providers);
      const reservation = runtime.reserve(owner, 'cleared-pre-id', request, () => false);
      await waitFor(() => (provider.beginCreation as jest.Mock).mock.calls.length === 1);
      await storageRepository.clearSession();
      finish();
      await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
      await runtime.awaitIdle();
      expect(storageRepository.feeAttachments()).toEqual([]);
      runtime.detach();
    },
  );

  it.each(['unavailable', 'throw'])(
    'does not recreate pre-id uncertainty after detach (%s)',
    async (outcome) => {
      let finish!: () => void;
      const pending = new Promise<void>((resolve) => {
        finish = resolve;
      });
      const provider: WalletOfferProvider = {
        capability: 'best-effort',
        scope: owner.providerScope,
        beginCreation: jest.fn(async () => {
          await pending;
          if (outcome === 'throw') throw new Error('response lost');
          return { kind: 'unavailable' as const, reason: 'response lost' };
        }),
        cancel: jest.fn(),
      };
      const providers = new WalletProviderRegistry();
      providers.attach(provider);
      const runtime = new FeeAttachmentRuntime(ports(), providers);
      const reservation = runtime.reserve(owner, 'detached-pre-id', request, () => false);
      await waitFor(() => (provider.beginCreation as jest.Mock).mock.calls.length === 1);
      runtime.detach();
      finish();
      await expect(reservation).resolves.toMatchObject({ kind: 'unavailable' });
      await runtime.awaitIdle();
      expect(storageRepository.feeAttachments()).toEqual([]);
      expect(provider.cancel).not.toHaveBeenCalled();
    },
  );

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
    await expect(reservation).resolves.toEqual({
      kind: 'unavailable',
      reason: 'Fee operation retired during wallet creation',
    });
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
