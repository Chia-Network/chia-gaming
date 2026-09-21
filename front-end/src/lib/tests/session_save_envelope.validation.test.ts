import { decodeDurableApplicationState } from '../session/persistence';
import type { DurableApplicationState } from '../session/saveEnvelope';
import type { WalletOperationEntry } from '../session/walletOperationStore';
import { activeSave, baseSave } from './session_save_envelope.fixtures';

const scope = {
  provider: 'walletconnect' as const,
  fingerprint: '123',
  chainId: 'chia:testnet11',
};

const obligation: WalletOperationEntry = {
  owner: {
    installationPlayerId: 'player',
    peerSessionId: 'peer-session',
    providerScope: scope,
  },
  purpose: { kind: 'funding', operationId: 'funding-1' },
  stage: 'reserved',
  tradeId: 'trade-1',
  reason: '',
};

const creatingObligation: WalletOperationEntry = {
  owner: {
    installationPlayerId: 'player',
    peerSessionId: 'peer-session',
    providerScope: scope,
  },
  purpose: { kind: 'fee', operationId: 'fee-creating' },
  stage: 'creating',
  disposition: 'active',
  recoveryId: 'recovery-1',
  request: {
    kind: 'fee',
    uniqueId: 'submission-1',
    fee: 10n,
    concurrentSpendCoinId: '01'.repeat(32),
  },
  reason: '',
};

const uncertainCancellation: WalletOperationEntry = {
  owner: {
    installationPlayerId: 'player',
    peerSessionId: 'peer-session',
    providerScope: scope,
  },
  purpose: { kind: 'fee', operationId: 'fee-cancelling' },
  stage: 'best-effort-cancellation-uncertain',
  tradeId: 'trade-cancelling',
  generation: 2n,
  lastAttemptEpoch: 3n,
  reason: 'response-lost',
};

function completeAggregate(): DurableApplicationState {
  return activeSave({
    walletProviderScope: scope,
    walletObligations: [obligation, creatingObligation, uncertainCancellation],
    rejectionTransports: [
      {
        kind: 'outbound-reject',
        peerId: 'peer',
        sessionId: 'ab'.repeat(16),
        messageNumber: 2n,
        remoteNumber: 1n,
        unackedMessages: [{ msgno: 2n, msg: new Uint8Array([1, 2]) }],
        createdAt: 1,
      },
    ],
  });
}

describe('DurableApplicationState strict validation', () => {
  it('round-trips no-session state as the same aggregate root', () => {
    const state = baseSave();
    expect(decodeDurableApplicationState(state).save).toEqual(state);
  });

  it('round-trips session, wallet obligations, and rejection transports exactly', () => {
    const state = completeAggregate();
    expect(decodeDurableApplicationState(state).save).toEqual(state);
  });

  it.each([
    ['root version', (state: any) => (state.version = 0n)],
    ['common identity', (state: any) => (state.identity.playerId = 7)],
    ['session payload', (state: any) => (state.session.live.messageNumber = -1n)],
    ['wallet obligation', (state: any) => (state.walletObligations[0].stage = 'unknown')],
    ['rejection transport', (state: any) => (state.rejectionTransports[0].sessionId = 'bad')],
  ])('rejects corruption in %s as whole-root corruption', (_label, corrupt) => {
    const state: any = structuredClone(completeAggregate());
    corrupt(state);
    expect(() => decodeDurableApplicationState(state)).toThrow();
  });

  it('rejects duplicate wallet and rejection identities', () => {
    const duplicateWallet = completeAggregate();
    duplicateWallet.walletObligations.push(structuredClone(obligation));
    expect(() => decodeDurableApplicationState(duplicateWallet)).toThrow(/duplicate/);

    const duplicateRejection = completeAggregate();
    duplicateRejection.rejectionTransports.push(
      structuredClone(duplicateRejection.rejectionTransports[0]),
    );
    expect(() => decodeDurableApplicationState(duplicateRejection)).toThrow(/duplicate/);
  });

  it('permits no session with unresolved wallet obligations', () => {
    const state = completeAggregate();
    state.session = null;
    expect(decodeDurableApplicationState(state).save).toEqual(state);
  });
});
