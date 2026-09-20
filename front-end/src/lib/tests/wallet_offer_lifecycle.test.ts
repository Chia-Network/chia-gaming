import type { WalletOfferProvider } from '../../types/ChiaGaming';
import {
  WalletReservationCoordinator,
  walletReservationOperation,
} from '../session/walletReservationLedger';
import {
  encodeWalletReservationRecord,
  walletProviderScopeKey,
  walletReservationOperationKey,
  walletReservationOwnerKey,
  type WalletReservationOwner,
} from '../session/walletReservationLedgerSchema';

const owner: WalletReservationOwner = {
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

describe('provider-neutral wallet offer lifecycle', () => {
  it('persists a Cloud recovery id before reconcile and resumes it without recreating', async () => {
    const ledger = new WalletReservationCoordinator();
    const writes: unknown[][] = [];
    ledger.configurePersistence(async (entries) => {
      writes.push(structuredClone(entries));
    });
    const begin = jest.fn().mockResolvedValue({ kind: 'pending', recoveryId: 'SR_exact' });
    const reconcile = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'disconnected' })
      .mockResolvedValueOnce({
        kind: 'created',
        material: { kind: 'offer', offer: 'offer1canonical' },
        tradeId: 'Offer_exact',
      });
    const provider = recoverableProvider({
      beginCreation: begin,
      reconcileCreation: reconcile,
    });
    ledger.attachProvider(provider);
    const operation = walletReservationOperation(ledger, owner, fundingPurpose);

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

    const restored = new WalletReservationCoordinator();
    restored.restore(ledger.snapshot());
    restored.attachProvider(provider);
    await expect(
      walletReservationOperation(restored, owner, fundingPurpose).createFunding(fundingRequest),
    ).resolves.toEqual({
      kind: 'created',
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
    expect(restored.entriesFor(owner)).toEqual([
      expect.objectContaining({ stage: 'reserved', tradeId: 'Offer_exact' }),
    ]);
  });

  it('quarantines a recovery owned by another provider account', async () => {
    const ledger = new WalletReservationCoordinator();
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
      walletReservationOperation(ledger, owner, fundingPurpose).createFunding(fundingRequest),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: expect.stringMatching(/original wallet account/i),
    });
    expect(begin).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(ledger.getScopeStatus('player', 'session')).toEqual({ kind: 'mismatch' });
  });

  it('matches equivalent provider scopes independently of object property order', async () => {
    const scopedOwner: WalletReservationOwner = {
      installationPlayerId: 'player',
      peerSessionId: 'session',
      providerScope: {
        provider: 'walletconnect',
        fingerprint: '123456',
        chainId: 'chia:testnet11',
      },
    };
    const ledger = new WalletReservationCoordinator();
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
      kind: 'created',
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

    expect(ledger.getScopeStatus('player', 'session')).toEqual({ kind: 'ready' });
    await expect(
      walletReservationOperation(ledger, scopedOwner, fundingPurpose).createFunding(fundingRequest),
    ).resolves.toMatchObject({ kind: 'created', tradeId: 'trade-ordered' });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it('does not match an unavailable provider scope', async () => {
    const ledger = new WalletReservationCoordinator();
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

    expect(ledger.getScopeStatus('player', 'session')).toEqual({ kind: 'unavailable' });
  });

  it('returns a terminally failed cancellation to cancel-required without looping', async () => {
    const beginCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'pending', recoveryId: 'SR_cancel_exact' });
    const reconcileCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'rejected', detail: 'terminal cancellation failure' });
    const provider = recoverableProvider({ beginCancellation, reconcileCancellation });
    const coordinator = new WalletReservationCoordinator();
    coordinator.attachProvider(provider);
    coordinator.registerReserved('Offer_cancel', owner, fundingPurpose);
    coordinator.requireCancellation('Offer_cancel', 'retired');
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
    const coordinator = new WalletReservationCoordinator();
    coordinator.attachProvider(provider);
    coordinator.registerReserved('Offer_cancel', owner, fundingPurpose);
    coordinator.requireCancellation('Offer_cancel', 'retired');
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
    const coordinator = new WalletReservationCoordinator();
    coordinator.attachProvider(provider);
    coordinator.registerReserved('Offer_cancel', owner, fundingPurpose);
    coordinator.requireCancellation('Offer_cancel', 'retired');
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
    const coordinator = new WalletReservationCoordinator();
    coordinator.attachProvider(provider);
    coordinator.registerReserved('Offer_cancel', owner, fundingPurpose);
    coordinator.requireCancellation('Offer_cancel', 'first-retirement');
    await Promise.resolve();
    await Promise.resolve();

    coordinator.requireCancellation('Offer_cancel', 'second-retirement');
    const snapshot = coordinator.snapshot();
    expect(snapshot).toEqual([
      expect.objectContaining({
        tradeId: 'Offer_cancel',
        stage: 'cancel-required',
        reason: 'second-retirement',
      }),
    ]);
    expect(snapshot[0]).not.toHaveProperty('recoveryId');
    expect(() => encodeWalletReservationRecord(snapshot)).not.toThrow();
    finishReconcile();
    await coordinator.awaitOwner(owner);
  });

  it('uses collision-free keys for external scope and operation strings', () => {
    const firstOwner: WalletReservationOwner = {
      installationPlayerId: 'player\0peer',
      peerSessionId: 'session',
      providerScope: {
        provider: 'walletconnect',
        fingerprint: 'fingerprint\0chain',
        chainId: 'id',
      },
    };
    const secondOwner: WalletReservationOwner = {
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
    expect(walletReservationOwnerKey(firstOwner)).not.toBe(walletReservationOwnerKey(secondOwner));
    expect(
      walletReservationOperationKey(firstOwner, {
        kind: 'fee',
        operationId: 'operation\0suffix',
      }),
    ).not.toBe(
      walletReservationOperationKey(secondOwner, {
        kind: 'fee',
        operationId: 'peer\0operation\0suffix',
      }),
    );
  });

  it('uses best-effort replacement when a provider has no reconcile capability', async () => {
    const ledger = new WalletReservationCoordinator();
    const begin = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'transport lost' })
      .mockResolvedValueOnce({
        kind: 'created',
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
    const operation = walletReservationOperation(ledger, owner, fundingPurpose);

    await operation.createFunding(fundingRequest);
    await operation.createFunding(fundingRequest);

    expect(begin).toHaveBeenCalledTimes(2);
  });

  it('reconciles a retired creation and cancels its late exact trade', async () => {
    const cancel = jest.fn().mockResolvedValue({ status: 'cancelled' });
    const provider = recoverableProvider({
      reconcileCreation: jest
        .fn()
        .mockResolvedValueOnce({ kind: 'unavailable', reason: 'pending' })
        .mockResolvedValueOnce({
          kind: 'created',
          material: { kind: 'offer', offer: 'offer1late' },
          tradeId: 'Offer_late',
        }),
      beginCancellation: cancel,
    });
    const coordinator = new WalletReservationCoordinator();
    coordinator.attachProvider(provider);
    const operation = walletReservationOperation(coordinator, owner, fundingPurpose);
    await operation.createFunding(fundingRequest);
    coordinator.promoteReservedForOwner(owner, 'controller-retired');
    expect(coordinator.snapshot()).toEqual([
      expect.objectContaining({ stage: 'creating', disposition: 'cancel-on-create' }),
    ]);

    coordinator.detachProvider(provider);
    coordinator.attachProvider(provider);
    await coordinator.awaitOwner(owner);

    expect(cancel).toHaveBeenCalledWith('Offer_late');
    expect(coordinator.snapshot()).toEqual([]);
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
    const coordinator = new WalletReservationCoordinator();
    coordinator.attachProvider(provider);
    const operation = walletReservationOperation(coordinator, owner, fundingPurpose);

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
    const ledger = new WalletReservationCoordinator();
    ledger.registerReserved('funding', owner, fundingPurpose);
    ledger.registerReserved('fee-cancel', owner, { kind: 'fee', operationId: 'fee-a' });
    ledger.registerReserved('fee-replay', owner, { kind: 'fee', operationId: 'fee-b' });
    ledger.retainForReplay('fee-replay');

    ledger.promoteReservedForOwner(owner, 'controller-retired');

    expect(ledger.entriesFor(owner)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ tradeId: 'funding', stage: 'cancel-required' }),
        expect.objectContaining({ tradeId: 'fee-cancel', stage: 'cancel-required' }),
        expect.objectContaining({ tradeId: 'fee-replay', stage: 'retained-for-replay' }),
      ]),
    );
  });
});
