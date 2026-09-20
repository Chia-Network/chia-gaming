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
      releaseWalletOffer: jest.fn().mockResolvedValue({ status: 'cancelled' }),
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

    await expect(ledger.createOffer(rpc, owner, fundingPurpose, fundingRequest)).resolves.toEqual({
      kind: 'created',
      material: { kind: 'offer', offer: 'offer1canonical' },
      tradeId: 'Offer_exact',
    });
    expect(begin).toHaveBeenCalledTimes(1);
    expect(reconcile).toHaveBeenNthCalledWith(
      2,
      { owner, purpose: fundingPurpose },
      fundingRequest,
      'SR_exact',
    );
    expect(ledger.entriesFor(owner)).toEqual([
      expect.objectContaining({ stage: 'reserved', tradeId: 'Offer_exact' }),
    ]);
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
