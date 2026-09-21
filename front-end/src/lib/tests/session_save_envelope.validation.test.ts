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

const walletStageFixtures: WalletOperationEntry[] = [
  creatingObligation,
  {
    owner: obligation.owner,
    purpose: { kind: 'fee', operationId: 'fee-uncertain' },
    stage: 'best-effort-uncertain',
    disposition: 'active',
    request: creatingObligation.request,
    generation: 1n,
    lastAttemptEpoch: 2n,
    reason: 'response-lost',
  },
  obligation,
  {
    ...obligation,
    purpose: { kind: 'fee', operationId: 'fee-replay' },
    stage: 'retained-for-replay',
    tradeId: 'trade-replay',
  },
  {
    ...obligation,
    purpose: { kind: 'funding', operationId: 'funding-cancel' },
    stage: 'cancel-required',
    tradeId: 'trade-cancel',
  },
  uncertainCancellation,
  {
    ...obligation,
    purpose: { kind: 'funding', operationId: 'funding-cancelling' },
    stage: 'cancelling',
    tradeId: 'trade-cancelling-exact',
    recoveryId: 'recovery-cancelling',
  },
];

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

function expectWholeRootRejection(
  mutate: (state: any) => void,
  source: DurableApplicationState = completeAggregate(),
): void {
  const state: any = structuredClone(source);
  mutate(state);
  expect(() => decodeDurableApplicationState(state)).toThrow();
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
    expectWholeRootRejection(corrupt);
  });

  it.each([
    ['aggregate root', (state: any) => (state.unexpected = true)],
    ['identity', (state: any) => (state.identity.unexpected = true)],
    ['preferences', (state: any) => (state.preferences.unexpected = true)],
    ['history', (state: any) => (state.history.unexpected = true)],
    ['session wrapper', (state: any) => (state.session.unexpected = true)],
    ['pairing', (state: any) => (state.session.pairing.unexpected = true)],
    ['live', (state: any) => (state.session.live.unexpected = true)],
    ['presentation', (state: any) => (state.session.presentation.unexpected = true)],
    ['rejection', (state: any) => (state.rejectionTransports[0].unexpected = true)],
  ])('rejects an unknown key in %s at the whole-root boundary', (_label, mutate) => {
    expectWholeRootRejection(mutate);
  });

  it('rejects the removed myRunningBalance presentation field', () => {
    expectWholeRootRejection((state) => (state.session.presentation.myRunningBalance = '0'));
  });

  it.each(['channelNotifQueue', 'gameNotifQueue', 'dismissedChannelStatus'])(
    'rejects removed presentation field %s',
    (field) => {
      expectWholeRootRejection((state) => (state.session.presentation[field] = null));
    },
  );

  it('rejects removed betweenHandCompose.proposal_sent', () => {
    expectWholeRootRejection(
      (state) => (state.session.presentation.betweenHandCompose.proposal_sent = false),
    );
  });

  it('rejects an unknown terminal key at the whole-root boundary', () => {
    const terminal = baseSave({
      channelStatus: {
        state: 'ResolvedClean',
        advisory: null,
        coin: null,
        our_balance: null,
        their_balance: null,
        game_allocated: null,
      },
      coinsOfInterest: [],
    });
    expect(decodeDurableApplicationState(terminal).save).toEqual(terminal);
    expectWholeRootRejection((state) => (state.session.terminal.unexpected = true), terminal);
  });

  it.each(walletStageFixtures.map((entry) => [entry.stage, entry] as const))(
    'rejects an unknown %s wallet-obligation key at the whole-root boundary',
    (_stage, entry) => {
      const state = activeSave({
        walletProviderScope: scope,
        walletObligations: [entry],
      });
      expect(decodeDurableApplicationState(state).save).toEqual(state);
      expectWholeRootRejection(
        (corrupt) => (corrupt.walletObligations[0].unexpected = true),
        state,
      );
    },
  );

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
