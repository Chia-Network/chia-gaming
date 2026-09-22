import { decodeDurableApplicationState } from '../session/persistence';
import type { DurableApplicationState } from '../session/saveEnvelope';
import type { ChannelFundingEntry } from '../session/channelFundingStore';
import type { FeeAttachment } from '../session/feeAttachmentStore';
import { activeSave, baseSave } from './session_save_envelope.fixtures';

const scope = {
  provider: 'walletconnect' as const,
  fingerprint: '123',
  chainId: 'chia:testnet11',
};

const obligation: ChannelFundingEntry = {
  owner: {
    installationPlayerId: 'player',
    peerSessionId: 'peer-session',
    providerScope: scope,
  },
  purpose: { kind: 'funding', operationId: 'funding-1' },
  stage: 'awaiting-channel',
  providerReservationId: 'trade-1',
  request: {
    kind: 'funding',
    canonical: { amount: '100', fee: '0', conditions: [] },
  },
  reason: '',
};

const creatingFee: FeeAttachment = {
  owner: {
    installationPlayerId: 'player',
    peerSessionId: 'peer-session',
    providerScope: scope,
  },
  submissionId: 'fee-creating',
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

const uncertainCancellation: FeeAttachment = {
  owner: {
    installationPlayerId: 'player',
    peerSessionId: 'peer-session',
    providerScope: scope,
  },
  submissionId: 'fee-cancelling',
  stage: 'best-effort-cancellation-uncertain',
  providerReservationId: 'trade-cancelling',
  lastAttemptEpoch: 3n,
  reason: 'response-lost',
};

const fundingRequest = {
  kind: 'funding' as const,
  canonical: { amount: '100', fee: '0', conditions: [] },
};

const walletStageFixtures: Array<{
  slice: 'channelFundingOperations' | 'feeAttachments';
  entry: ChannelFundingEntry | FeeAttachment;
}> = [
  {
    slice: 'channelFundingOperations',
    entry: {
      owner: obligation.owner,
      purpose: { kind: 'funding', operationId: 'funding-creating' },
      stage: 'creating',
      disposition: 'active',
      recoveryId: 'funding-recovery',
      request: fundingRequest,
      reason: '',
    },
  },
  {
    slice: 'channelFundingOperations',
    entry: {
      owner: obligation.owner,
      purpose: { kind: 'funding', operationId: 'funding-uncertain' },
      stage: 'best-effort-uncertain',
      disposition: 'active',
      request: fundingRequest,
      lastAttemptEpoch: 2n,
      reason: '',
    },
  },
  { slice: 'feeAttachments', entry: creatingFee },
  {
    slice: 'feeAttachments',
    entry: {
      owner: obligation.owner,
      submissionId: 'fee-uncertain',
      stage: 'best-effort-uncertain',
      disposition: 'active',
      request: creatingFee.request,
      lastAttemptEpoch: 2n,
      reason: 'response-lost',
    },
  },
  { slice: 'channelFundingOperations', entry: obligation },
  {
    slice: 'feeAttachments',
    entry: {
      owner: obligation.owner,
      submissionId: 'fee-reserved',
      stage: 'reserved',
      providerReservationId: 'trade-reserved',
      reason: '',
    },
  },
  {
    slice: 'feeAttachments',
    entry: {
      owner: obligation.owner,
      submissionId: 'fee-replay',
      stage: 'retained-for-replay',
      providerReservationId: 'trade-replay',
      reason: '',
    },
  },
  {
    slice: 'channelFundingOperations',
    entry: {
      owner: obligation.owner,
      purpose: { kind: 'funding', operationId: 'funding-cancel' },
      stage: 'cancel-required',
      providerReservationId: 'trade-cancel',
      reason: obligation.reason,
    },
  },
  {
    slice: 'channelFundingOperations',
    entry: {
      owner: obligation.owner,
      purpose: { kind: 'funding', operationId: 'funding-cancellation-uncertain' },
      stage: 'best-effort-cancellation-uncertain',
      providerReservationId: 'trade-funding-cancellation-uncertain',
      lastAttemptEpoch: 3n,
      reason: '',
    },
  },
  {
    slice: 'feeAttachments',
    entry: {
      owner: obligation.owner,
      submissionId: 'fee-cancel-required',
      stage: 'cancel-required',
      providerReservationId: 'trade-fee-cancel-required',
      reason: '',
    },
  },
  { slice: 'feeAttachments', entry: uncertainCancellation },
  {
    slice: 'channelFundingOperations',
    entry: {
      owner: obligation.owner,
      purpose: { kind: 'funding', operationId: 'funding-cancelling' },
      stage: 'cancelling',
      providerReservationId: 'trade-cancelling-exact',
      recoveryId: 'recovery-cancelling',
      reason: obligation.reason,
    },
  },
  {
    slice: 'feeAttachments',
    entry: {
      owner: obligation.owner,
      submissionId: 'fee-cancelling-exact',
      stage: 'cancelling',
      providerReservationId: 'trade-fee-cancelling-exact',
      recoveryId: 'recovery-fee-cancelling',
      reason: '',
    },
  },
];

function completeAggregate(): DurableApplicationState {
  return activeSave({
    walletProviderScope: scope,
    channelFundingOperations: [obligation],
    feeAttachments: [creatingFee, uncertainCancellation],
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

  it('round-trips session, split channel funding operations, and rejection transports exactly', () => {
    const state = completeAggregate();
    expect(decodeDurableApplicationState(state).save).toEqual(state);
  });

  it.each([
    ['root version', (state: any) => (state.version = 0n)],
    ['common identity', (state: any) => (state.identity.playerId = 7)],
    ['session payload', (state: any) => (state.session.live.messageNumber = -1n)],
    ['funding operation', (state: any) => (state.channelFundingOperations[0].stage = 'unknown')],
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

  it.each(walletStageFixtures.map(({ slice, entry }) => [entry.stage, slice, entry] as const))(
    'rejects an unknown %s provider-operation key at the whole-root boundary',
    (_stage, slice, entry) => {
      const state = activeSave({
        walletProviderScope: scope,
        channelFundingOperations: slice === 'channelFundingOperations' ? [entry] : [],
        feeAttachments: slice === 'feeAttachments' ? [entry] : [],
      });
      expect(decodeDurableApplicationState(state).save).toEqual(state);
      expectWholeRootRejection((corrupt) => (corrupt[slice][0].unexpected = true), state);
    },
  );

  it('rejects duplicate rejection identities', () => {
    const duplicateRejection = completeAggregate();
    duplicateRejection.rejectionTransports.push(
      structuredClone(duplicateRejection.rejectionTransports[0]),
    );
    expect(() => decodeDurableApplicationState(duplicateRejection)).toThrow(/duplicate/);
  });

  it('rejects operations stored in the wrong durable slice', () => {
    const fundingInFees = completeAggregate();
    fundingInFees.feeAttachments.push(fundingInFees.channelFundingOperations.pop()!);
    expect(() => decodeDurableApplicationState(fundingInFees)).toThrow(/invalid/);
  });

  it.each([
    ['channel funding', 'channelFundingOperations', obligation],
    [
      'fee attachment',
      'feeAttachments',
      {
        owner: obligation.owner,
        submissionId: 'fee-duplicate',
        stage: 'reserved',
        providerReservationId: 'fee-duplicate-reservation',
        reason: '',
      } satisfies FeeAttachment,
    ],
  ] as const)('rejects duplicate provider reservation ids within %s', (_label, slice, entry) => {
    const state = activeSave({
      walletProviderScope: scope,
      channelFundingOperations: slice === 'channelFundingOperations' ? [entry, entry] : [],
      feeAttachments: slice === 'feeAttachments' ? [entry, entry] : [],
    });
    expect(() => decodeDurableApplicationState(state)).toThrow(/duplicate/);
  });

  it('rejects duplicate provider reservation ids across durable slices', () => {
    const state = completeAggregate();
    state.feeAttachments.push({
      ...uncertainCancellation,
      providerReservationId: obligation.providerReservationId,
    });
    expect(() => decodeDurableApplicationState(state)).toThrow(/duplicate/);
  });

  it('rejects an operation whose provider scope differs from the aggregate context', () => {
    const state = structuredClone(completeAggregate());
    state.channelFundingOperations[0]!.owner.providerScope = {
      provider: 'walletconnect',
      fingerprint: '999',
      chainId: 'chia:testnet11',
    };
    expect(() => decodeDurableApplicationState(state)).toThrow(/owner\/context mismatch/);
  });

  it('rejects the unreleased v3 walletObligations aggregate without migration', () => {
    const state: any = completeAggregate();
    state.version = 3n;
    state.walletObligations = [...state.channelFundingOperations, ...state.feeAttachments];
    delete state.channelFundingOperations;
    delete state.feeAttachments;
    expect(() => decodeDurableApplicationState(state)).toThrow(/walletObligations/);
  });

  it('permits no session with unresolved channel funding operations', () => {
    const state = completeAggregate();
    state.session = null;
    expect(decodeDurableApplicationState(state).save).toEqual(state);
  });
});
