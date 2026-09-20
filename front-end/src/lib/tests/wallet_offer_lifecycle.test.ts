import type {
  InternalBlockchainInterface,
  WalletOfferBeginOutcome,
  WalletOfferOperation,
  WalletOfferRequest,
} from '../../types/ChiaGaming';
import { WalletReservationLedger } from '../session/walletReservationLedger';
import type { WalletReservationOwner } from '../session/walletReservationLedgerSchema';

const owner: WalletReservationOwner = {
  installationPlayerId: 'player',
  peerSessionId: 'session',
  providerScope: { provider: 'cloud', walletId: 'Wallet_1' },
};

const fundingPurpose = { kind: 'funding' as const, operationId: 'funding-op' };
const fundingRequest: WalletOfferRequest = {
  kind: 'funding',
  uniqueId: 'player',
  offer: { '1': -100n },
};

function rpcWith(
  beginWalletOffer: (
    operation: WalletOfferOperation,
    request: WalletOfferRequest,
  ) => Promise<WalletOfferBeginOutcome>,
  reconcileWalletOffer?: InternalBlockchainInterface['reconcileWalletOffer'],
): InternalBlockchainInterface {
  return new Proxy(
    {
      beginWalletOffer,
      reconcileWalletOffer,
      getWalletProviderScope: () => owner.providerScope,
      beginWalletOfferCancellation: jest.fn().mockResolvedValue({ status: 'cancelled' }),
    } as unknown as InternalBlockchainInterface,
    {
      get: (target, property) =>
        (target as unknown as Record<PropertyKey, unknown>)[property] ??
        (() => Promise.resolve(undefined)),
    },
  );
}

describe('provider-neutral wallet offer lifecycle', () => {
  it('persists a Cloud recovery id before reconcile and resumes it without recreating', async () => {
    const ledger = new WalletReservationLedger();
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
    const rpc = rpcWith(begin, reconcile);

    await expect(ledger.createOffer(rpc, owner, fundingPurpose, fundingRequest)).resolves.toEqual({
      kind: 'unavailable',
      reason: 'disconnected',
    });
    expect(writes[0]).toEqual([
      expect.objectContaining({
        stage: 'creating',
        recoveryId: 'SR_exact',
        owner,
        purpose: fundingPurpose,
      }),
    ]);

    const restored = new WalletReservationLedger();
    restored.restore(ledger.snapshot());
    await expect(restored.createOffer(rpc, owner, fundingPurpose, fundingRequest)).resolves.toEqual(
      {
        kind: 'created',
        material: { kind: 'offer', offer: 'offer1canonical' },
        tradeId: 'Offer_exact',
      },
    );
    expect(begin).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenNthCalledWith(
      2,
      { owner, purpose: fundingPurpose },
      fundingRequest,
      'SR_exact',
    );
    expect(restored.entriesFor(owner)).toEqual([
      expect.objectContaining({ stage: 'reserved', tradeId: 'Offer_exact' }),
    ]);
  });

  it('quarantines a recovery owned by another provider account', async () => {
    const ledger = new WalletReservationLedger();
    ledger.restore([
      {
        owner,
        purpose: fundingPurpose,
        stage: 'creating',
        recoveryId: 'SR_original',
        request: fundingRequest,
        reason: 'pending',
      },
    ]);
    const begin = jest.fn();
    const reconcile = jest.fn();
    const wrongRpc = rpcWith(begin, reconcile);
    wrongRpc.getWalletProviderScope = () => ({ provider: 'cloud', walletId: 'Wallet_other' });

    await expect(
      ledger.createOffer(wrongRpc, owner, fundingPurpose, fundingRequest),
    ).resolves.toEqual({
      kind: 'unavailable',
      reason: expect.stringMatching(/original wallet account/i),
    });
    expect(begin).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
    expect(ledger.getScopeStatus('player', 'session')).toEqual({ kind: 'unavailable' });
    ledger.attachRpc(wrongRpc);
    expect(ledger.getScopeStatus('player', 'session')).toEqual({ kind: 'mismatch' });
  });

  it('matches equivalent provider scopes independently of object property order', async () => {
    const scopedOwner: WalletReservationOwner = {
      installationPlayerId: 'player',
      peerSessionId: 'session',
      providerScope: {
        provider: 'walletconnect',
        fingerprint: '123456',
        remoteWalletId: '7',
      },
    };
    const ledger = new WalletReservationLedger();
    ledger.restore([
      {
        owner: scopedOwner,
        purpose: fundingPurpose,
        stage: 'creating',
        recoveryId: 'SR_order',
        request: fundingRequest,
        reason: 'pending',
      },
    ]);
    const reconcile = jest.fn().mockResolvedValue({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer1ordered' },
      tradeId: 'trade-ordered',
    });
    const rpc = rpcWith(jest.fn(), reconcile);
    rpc.getWalletProviderScope = () =>
      ({
        provider: 'walletconnect',
        remoteWalletId: '7',
        fingerprint: '123456',
      }) as const;
    ledger.attachRpc(rpc);

    expect(ledger.getScopeStatus('player', 'session')).toEqual({ kind: 'ready' });
    await expect(
      ledger.createOffer(rpc, scopedOwner, fundingPurpose, fundingRequest),
    ).resolves.toMatchObject({ kind: 'created', tradeId: 'trade-ordered' });
    expect(reconcile).toHaveBeenCalledTimes(1);
  });

  it.each([null, undefined])('does not match a %s provider scope', async (scope) => {
    const ledger = new WalletReservationLedger();
    ledger.restore([
      {
        owner,
        purpose: fundingPurpose,
        stage: 'creating',
        recoveryId: 'SR_missing_scope',
        request: fundingRequest,
        reason: 'pending',
      },
    ]);
    const begin = jest.fn();
    const reconcile = jest.fn();
    const rpc = rpcWith(begin, reconcile);
    rpc.getWalletProviderScope = () => scope;
    ledger.attachRpc(rpc);

    expect(ledger.getScopeStatus('player', 'session')).toEqual({ kind: 'unavailable' });
    await expect(ledger.createOffer(rpc, owner, fundingPurpose, fundingRequest)).resolves.toEqual({
      kind: 'unavailable',
      reason: expect.stringMatching(/original wallet account/i),
    });
    expect(begin).not.toHaveBeenCalled();
    expect(reconcile).not.toHaveBeenCalled();
  });

  it('persists pending cancellation before exact reconciliation and resumes it', async () => {
    const writes: unknown[][] = [];
    const beginCancellation = jest
      .fn()
      .mockResolvedValue({ status: 'pending', recoveryId: 'SR_cancel_exact' });
    const reconcileCancellation = jest
      .fn()
      .mockResolvedValueOnce({ status: 'unavailable', detail: 'popup blocked' })
      .mockResolvedValueOnce({ status: 'cancelled' });
    const rpc = rpcWith(jest.fn());
    rpc.beginWalletOfferCancellation = beginCancellation;
    rpc.reconcileWalletOfferCancellation = reconcileCancellation;

    const first = new WalletReservationLedger();
    first.configurePersistence(async (entries) => writes.push(structuredClone(entries)));
    first.attachRpc(rpc);
    first.registerReserved('Offer_cancel', owner, fundingPurpose);
    first.requireCancellation('Offer_cancel', 'retired');
    await first.awaitOwner(owner);
    expect(writes).toEqual(
      expect.arrayContaining([
        [
          expect.objectContaining({
            stage: 'cancelling',
            tradeId: 'Offer_cancel',
            recoveryId: 'SR_cancel_exact',
          }),
        ],
      ]),
    );

    const restored = new WalletReservationLedger();
    restored.restore(first.snapshot());
    restored.attachRpc(rpc);
    await restored.awaitOwner(owner);
    expect(beginCancellation).toHaveBeenCalledTimes(1);
    expect(reconcileCancellation).toHaveBeenLastCalledWith('Offer_cancel', 'SR_cancel_exact');
    expect(restored.snapshot()).toEqual([]);
  });

  it('uses best-effort replacement when a provider has no reconcile capability', async () => {
    const ledger = new WalletReservationLedger();
    const begin = jest
      .fn()
      .mockResolvedValueOnce({ kind: 'unavailable', reason: 'transport lost' })
      .mockResolvedValueOnce({
        kind: 'created',
        material: { kind: 'offer', offer: 'offer1retry' },
        tradeId: 'trade-retry',
      });
    const rpc = rpcWith(begin);

    await ledger.createOffer(rpc, owner, fundingPurpose, fundingRequest);
    await ledger.createOffer(rpc, owner, fundingPurpose, fundingRequest);

    expect(begin).toHaveBeenCalledTimes(2);
  });

  it('retires only reserved funding and fee entries while preserving replay retention', () => {
    const ledger = new WalletReservationLedger();
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
