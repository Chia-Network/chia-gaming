import {
  WALLET_OPERATION_RECORD_VERSION,
  decodeWalletOperationRecord,
  encodeWalletOperationRecord,
} from '../session/walletOperationCodec';
import {
  reduceWalletOperation,
  walletOperationEntryKey,
  walletOperationRecoveryKey,
  type WalletOperationEntry,
  type WalletOperationOwner,
  type WalletOperationPurpose,
  type WalletOperationTransition,
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

function transition(
  current: WalletOperationEntry | null,
  command: WalletOperationTransition,
): WalletOperationEntry | null {
  const reduced = reduceWalletOperation(current ? [current] : [], {
    ...command,
    key: current ? walletOperationEntryKey(current) : walletOperationRecoveryKey(owner, purpose),
    owner,
    purpose,
  });
  return reduced.nextState[0] ?? null;
}

describe('WalletOperationStore reducer', () => {
  it('routes every durable creation and cancellation stage through pure transitions', () => {
    const uncertain = transition(null, {
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

    const duplicateEpoch = transition(uncertain, {
      kind: 'uncertain-attempt-launched',
      readinessEpoch: 4n,
      reason: 'duplicate',
    });
    expect(duplicateEpoch).toBe(uncertain);

    const replacement = transition(uncertain, {
      kind: 'uncertain-attempt-launched',
      readinessEpoch: 5n,
      reason: 'reconnected',
    });
    expect(replacement).toMatchObject({ generation: 1n, lastAttemptEpoch: 5n });

    const retired = transition(replacement, {
      kind: 'cleanup-required',
      reason: 'terminal-session',
      preserveReplay: true,
    });
    expect(retired).toMatchObject({ disposition: 'cancel-on-create' });

    const cancelRequired = transition(retired, {
      kind: 'creation-completed',
      tradeId: 'trade-late',
      reason: 'late-result',
    });
    expect(cancelRequired).toMatchObject({ stage: 'cancel-required', tradeId: 'trade-late' });
    expect(cancelRequired).toMatchObject({ orphanRisk: 'pre-id-response-lost' });

    const cancellationUncertain = transition(cancelRequired, {
      kind: 'cancellation-uncertain',
      readinessEpoch: 8n,
      reason: 'response-lost',
    });
    expect(cancellationUncertain).toMatchObject({
      stage: 'best-effort-cancellation-uncertain',
      lastAttemptEpoch: 8n,
    });

    const rebasedCancellation = transition(cancellationUncertain, {
      kind: 'uncertain-cancellation-attempt-launched',
      readinessEpoch: 1n,
      reason: 'new-registry-generation',
      newRegistryGeneration: true,
    });
    expect(rebasedCancellation).toMatchObject({ generation: 1n, lastAttemptEpoch: 1n });

    const cancelling = transition(rebasedCancellation, {
      kind: 'cancellation-recovery-identified',
      recoveryId: 'cancel-exact',
    });
    expect(cancelling).toMatchObject({ stage: 'cancelling', recoveryId: 'cancel-exact' });

    expect(
      transition(cancelling, {
        kind: 'cancellation-completed',
      }),
    ).toBeNull();
  });

  it('accepts only strict current v8 records', () => {
    const entry = transition(null, {
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
    expect(() => decodeWalletOperationRecord({ ...encoded, version: 7n })).toThrow(/version/);
    expect(() =>
      decodeWalletOperationRecord({
        ...encoded,
        entries: [{ ...encoded.entries[0], unknown: true }],
      }),
    ).toThrow(/fields/);
  });

  it('allows only cancellation cleanup beside a creating recovery', () => {
    const creating = {
      owner,
      purpose,
      stage: 'creating' as const,
      disposition: 'active' as const,
      recoveryId: 'winner-recovery',
      request,
      reason: 'winner',
    };
    const cleanup = {
      owner,
      purpose,
      stage: 'cancel-required' as const,
      tradeId: 'stale-trade',
      reason: 'stale-create-result',
    };
    expect(
      decodeWalletOperationRecord(encodeWalletOperationRecord([creating, cleanup])).entries,
    ).toEqual([creating, cleanup]);
    expect(() =>
      encodeWalletOperationRecord([{ ...cleanup, stage: 'reserved' as const }, creating]),
    ).toThrow(/contradictory/);
  });

  it('rejects multiple provider scopes for one session', () => {
    const creating: WalletOperationEntry = {
      owner,
      purpose,
      stage: 'creating',
      disposition: 'active',
      recoveryId: 'winner-recovery',
      request,
      reason: 'winner',
    };
    const otherScope = {
      ...owner,
      providerScope: {
        provider: 'walletconnect' as const,
        fingerprint: '456',
        chainId: 'chia:testnet11',
      },
    };
    expect(() =>
      encodeWalletOperationRecord([
        creating,
        {
          owner: otherScope,
          purpose,
          stage: 'cancel-required',
          tradeId: 'other-scope-trade',
          reason: 'conflict',
        },
      ]),
    ).toThrow(/span provider scopes/);
  });
});
