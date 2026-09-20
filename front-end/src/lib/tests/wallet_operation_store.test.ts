import {
  WALLET_OPERATION_RECORD_VERSION,
  decodeWalletOperationRecord,
  encodeWalletOperationRecord,
  reduceWalletOperation,
  type WalletOperationOwner,
  type WalletOperationPurpose,
} from '../session/walletOperationStore';

const owner: WalletOperationOwner = {
  installationPlayerId: 'player',
  peerSessionId: 'session',
  providerScope: {
    provider: 'walletconnect',
    fingerprint: '123',
    chainId: 'chia:testnet11',
  },
};
const purpose: WalletOperationPurpose = { kind: 'funding', operationId: 'funding-key' };
const request = {
  kind: 'funding' as const,
  canonical: { amount: '10', fee: '0', conditions: [] },
};

describe('WalletOperationStore reducer', () => {
  it('routes every durable creation and cancellation stage through pure transitions', () => {
    const uncertain = reduceWalletOperation(null, owner, purpose, {
      kind: 'creation-uncertain',
      request,
      generation: 0n,
      readinessEpoch: 4n,
      reason: 'response-lost',
      retired: false,
      orphanRisk: 'pre-id-response-lost',
    });
    expect(uncertain).toMatchObject({
      stage: 'best-effort-uncertain',
      generation: 0n,
      lastAttemptEpoch: 4n,
      orphanRisk: 'pre-id-response-lost',
    });

    const duplicateEpoch = reduceWalletOperation(uncertain, owner, purpose, {
      kind: 'uncertain-attempt-launched',
      readinessEpoch: 4n,
      reason: 'duplicate',
    });
    expect(duplicateEpoch).toBe(uncertain);

    const replacement = reduceWalletOperation(uncertain, owner, purpose, {
      kind: 'uncertain-attempt-launched',
      readinessEpoch: 5n,
      reason: 'reconnected',
    });
    expect(replacement).toMatchObject({ generation: 1n, lastAttemptEpoch: 5n });

    const retired = reduceWalletOperation(replacement, owner, purpose, {
      kind: 'retire',
      reason: 'terminal-session',
    });
    expect(retired).toMatchObject({ disposition: 'cancel-on-create' });

    const cancelRequired = reduceWalletOperation(retired, owner, purpose, {
      kind: 'creation-completed',
      tradeId: 'trade-late',
      reason: 'late-result',
    });
    expect(cancelRequired).toMatchObject({ stage: 'cancel-required', tradeId: 'trade-late' });
    expect(cancelRequired).toMatchObject({ orphanRisk: 'pre-id-response-lost' });

    const cancellationUncertain = reduceWalletOperation(cancelRequired, owner, purpose, {
      kind: 'cancellation-uncertain',
      readinessEpoch: 8n,
      reason: 'response-lost',
    });
    expect(cancellationUncertain).toMatchObject({
      stage: 'best-effort-cancellation-uncertain',
      lastAttemptEpoch: 8n,
    });

    const rebasedCancellation = reduceWalletOperation(cancellationUncertain, owner, purpose, {
      kind: 'uncertain-cancellation-attempt-launched',
      readinessEpoch: 1n,
      reason: 'new-registry-generation',
      newRegistryGeneration: true,
    });
    expect(rebasedCancellation).toMatchObject({ generation: 1n, lastAttemptEpoch: 1n });

    const cancelling = reduceWalletOperation(rebasedCancellation, owner, purpose, {
      kind: 'cancellation-recovery-identified',
      recoveryId: 'cancel-exact',
    });
    expect(cancelling).toMatchObject({ stage: 'cancelling', recoveryId: 'cancel-exact' });

    expect(
      reduceWalletOperation(cancelling, owner, purpose, {
        kind: 'cancellation-completed',
      }),
    ).toBeNull();
  });

  it('accepts only strict current v7 records', () => {
    const entry = reduceWalletOperation(null, owner, purpose, {
      kind: 'creation-uncertain',
      request,
      generation: 2n,
      readinessEpoch: 8n,
      reason: 'response-lost',
      retired: false,
    });
    const encoded = encodeWalletOperationRecord(entry ? [entry] : []);
    expect(encoded.version).toBe(WALLET_OPERATION_RECORD_VERSION);
    expect(decodeWalletOperationRecord(encoded)).toEqual(encoded);
    expect(() => decodeWalletOperationRecord({ ...encoded, version: 6n })).toThrow(/version/);
    expect(() =>
      decodeWalletOperationRecord({
        ...encoded,
        entries: [{ ...encoded.entries[0], unknown: true }],
      }),
    ).toThrow(/fields/);
  });
});
