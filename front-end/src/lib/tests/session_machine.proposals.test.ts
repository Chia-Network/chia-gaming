import { Program } from 'clvm-lib';
import { createSessionModel } from '../session/model';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { reduceSessionNotification } from '../session/sessionMachineNotifications';
import { parsePendingProposals } from '../session/persistenceBetweenHands';
import { snapshotFromSessionModel } from '../session/sessionSnapshot';
import type { PendingProposalModel } from '../session/types';
import { selectIncomingProposal } from '../session/selectors';
import { isUncancelledProposal } from '../session/sessionMachineProposals';
import { resetProtocolIds, setProtocolIds } from '../gameIdentities';
import { TEST_PROTOCOL_IDS, testProtocolId } from './protocolIdentities';

const TERMS = {
  gameType: 'calpoker' as const,
  senderIsPlayerA: false,
  gameTimeout: 15n,
  parameters: 10n,
};

function pending(id: string, lifecycle: PendingProposalModel['lifecycle']): PendingProposalModel {
  return { id, handProposal: TERMS, lifecycle };
}

function withProposal(proposal: PendingProposalModel) {
  return createSessionMachineState(
    createSessionModel({ betweenHand: { pendingProposals: [proposal] } }),
  );
}

function incomingProposal(id: string, parameters: bigint = 10n, senderIsPlayerA = false) {
  return {
    ProposalMade: {
      id,
      game_type: testProtocolId('calpoker'),
      timeout: 15n,
      sender_is_player_a: senderIsPlayerA,
      parameters,
    },
  };
}

describe('scalar advisory proposal lifecycle', () => {
  beforeEach(() => setProtocolIds(TEST_PROTOCOL_IDS));
  afterEach(() => resetProtocolIds());

  it('marks a queued acceptance and advisory outgoing cancellation without creating games', () => {
    let accepting = withProposal(pending('7', 'peer-review'));
    accepting = reduceSessionMachine(accepting, {
      type: 'proposal-command-succeeded',
      command: 'accept-proposal',
      id: '7',
    }).state;
    expect(accepting.model.betweenHand.pendingProposals[0]?.lifecycle).toBe('peer-accept-queued');
    expect(accepting.model.game.activeIds).toEqual([]);

    let cancelling = withProposal(pending('9', 'local-outgoing'));
    cancelling = reduceSessionMachine(cancelling, {
      type: 'proposal-command-succeeded',
      command: 'cancel-proposal',
      id: '9',
    }).state;
    expect(cancelling.model.betweenHand.pendingProposals[0]?.lifecycle).toBe('local-cancel-queued');
  });

  it.each([
    [
      'cancelled',
      { ProposalCancelled: { id: 7n, reason: 'CancelledByUs' as const } },
      'local-cancel-queued' as const,
    ],
    [
      'insufficient',
      {
        InsufficientBalance: {
          id: 7n,
          our_balance_short: true,
          their_balance_short: false,
        },
      },
      'peer-accept-queued' as const,
    ],
  ])('resolves queued proposal through %s notification', (_label, notification, lifecycle) => {
    const transition = reduceSessionNotification(
      withProposal(pending('7', lifecycle)),
      notification,
      false,
      reduceSessionMachine,
    );
    expect(transition.state.model.betweenHand.pendingProposals).toEqual([]);
    expect(transition.state.model.game.activeIds).toEqual([]);
  });

  it('creates generated games only from ProposalAcceptedGroup', () => {
    const state = reduceSessionNotification(
      withProposal(pending('7', 'peer-accept-queued')),
      {
        ProposalAcceptedGroup: {
          id: 7n,
          members: [
            {
              id: 101n,
              player_a_contribution: '10',
              player_b_contribution: '10',
              our_turn: true,
              readable_parameters: Program.fromBigInt(10n).serialize(),
            },
          ],
        },
      },
      false,
      reduceSessionMachine,
    ).state;
    expect(state.model.betweenHand.pendingProposals).toEqual([]);
    expect(state.model.game.activeIds).toEqual(['101']);
  });

  it('lets authoritative acceptance win over advisory outgoing cancellation', () => {
    const state = reduceSessionNotification(
      withProposal(pending('7', 'local-cancel-queued')),
      {
        ProposalAcceptedGroup: {
          id: 7n,
          members: [
            {
              id: 101n,
              player_a_contribution: '10',
              player_b_contribution: '10',
              our_turn: false,
              readable_parameters: Program.fromBigInt(10n).serialize(),
            },
          ],
        },
      },
      false,
      reduceSessionMachine,
    ).state;
    expect(state.model.betweenHand.pendingProposals).toEqual([]);
    expect(state.model.game.activeIds).toEqual(['101']);
  });

  it('removes a receiver rejection immediately after its command queues', () => {
    const state = reduceSessionMachine(withProposal(pending('7', 'peer-review')), {
      type: 'proposal-command-succeeded',
      command: 'cancel-proposal',
      id: '7',
    }).state;
    expect(state.model.betweenHand.pendingProposals).toEqual([]);
    expect(state.model.betweenHand.mode).toBe('compose-proposal');
  });

  it('ignores a later cancellation after definitive receiver-side removal', () => {
    const removed = reduceSessionMachine(withProposal(pending('7', 'peer-review')), {
      type: 'proposal-command-succeeded',
      command: 'cancel-proposal',
      id: '7',
    }).state;
    const transition = reduceSessionNotification(
      removed,
      { ProposalCancelled: { id: 7n, reason: 'WentOnChain' } },
      false,
      reduceSessionMachine,
    );
    expect(transition.state).toBe(removed);
    expect(transition.effects).toEqual([]);
  });

  it('keeps missing insufficient-balance correlations as an invariant failure', () => {
    expect(() =>
      reduceSessionNotification(
        createSessionMachineState(createSessionModel()),
        {
          InsufficientBalance: {
            id: 7n,
            our_balance_short: true,
            their_balance_short: false,
          },
        },
        false,
        reduceSessionMachine,
      ),
    ).toThrow('InsufficientBalance 7 missing normalized pending proposal');
  });

  it('does not propose again while same-terms acceptance is pending', () => {
    const state = createSessionMachineState(
      createSessionModel({
        game: { currentHandOrigin: 'local' },
        betweenHand: {
          mode: 'decision',
          lastHandProposal: TERMS,
          pendingProposals: [pending('7', 'peer-accept-queued')],
        },
      }),
    );
    const transition = reduceSessionMachine(state, { type: 'choose-same-terms' });
    expect(transition.state).toBe(state);
    expect(transition.effects).toEqual([]);
  });

  it.each([
    ['local-outgoing', true],
    ['peer-cached', true],
    ['peer-review', true],
    ['peer-accept-queued', true],
    ['local-cancel-queued', false],
    ['peer-cancel-queued', false],
  ] as const)('classifies %s as uncancelled=%s', (lifecycle, expected) => {
    expect(isUncancelledProposal(pending('7', lifecycle))).toBe(expected);
  });

  it.each(['peer-cached', 'local-outgoing'] as const)(
    'cancels a second incoming proposal without admitting it beside %s',
    (lifecycle) => {
      const state = withProposal(pending('7', lifecycle));
      const transition = reduceSessionNotification(
        state,
        incomingProposal('9'),
        false,
        reduceSessionMachine,
      );

      expect(transition.state).toBe(state);
      expect(transition.state.model.betweenHand.pendingProposals).toEqual([
        pending('7', lifecycle),
      ]);
      expect(transition.effects).toEqual([{ type: 'controller-cancel-proposal', id: '9' }]);
    },
  );

  it.each(['peer-cached', 'local-outgoing'] as const)(
    'blocks local proposal commands while %s occupies the slot',
    (lifecycle) => {
      const state = withProposal(pending('7', lifecycle));

      expect(reduceSessionMachine(state, { type: 'submit-compose', handProposal: TERMS })).toEqual({
        state,
        effects: [],
        durability: 'durable',
      });
      expect(
        reduceSessionMachine(state, { type: 'request-propose-game', handProposal: TERMS }),
      ).toEqual({ state, effects: [], durability: 'durable' });
    },
  );

  it('blocks choose-same-terms from proposing beside an outgoing proposal', () => {
    const state = createSessionMachineState(
      createSessionModel({
        game: { currentHandOrigin: 'local' },
        betweenHand: {
          mode: 'decision',
          lastHandProposal: TERMS,
          pendingProposals: [pending('7', 'local-outgoing')],
        },
      }),
    );

    expect(reduceSessionMachine(state, { type: 'choose-same-terms' })).toEqual({
      state,
      effects: [],
      durability: 'durable',
    });
  });

  it.each(['local-cancel-queued', 'peer-cancel-queued'] as const)(
    'allows a replacement once the existing proposal is %s',
    (lifecycle) => {
      const state = withProposal(pending('7', lifecycle));
      expect(
        reduceSessionMachine(state, { type: 'submit-compose', handProposal: TERMS }).effects,
      ).toEqual([{ type: 'controller-propose-game', handProposal: TERMS }]);
      expect(
        reduceSessionMachine(state, { type: 'request-propose-game', handProposal: TERMS }).effects,
      ).toEqual([{ type: 'controller-propose-game', handProposal: TERMS }]);
    },
  );

  it('queues automatic cached-peer cancellation without explicit-rejection UX facts', () => {
    const state = createSessionMachineState(
      createSessionModel({
        game: { activeIds: ['101'] },
        betweenHand: { mode: 'decision', rejectedOnceHandProposal: null },
      }),
    );
    const queued = reduceSessionNotification(
      state,
      incomingProposal('9'),
      false,
      reduceSessionMachine,
    );

    expect(queued.state.model.betweenHand.pendingProposals).toEqual([
      pending('9', 'peer-cancel-queued'),
    ]);
    expect(queued.state.model.betweenHand.mode).toBe('decision');
    expect(queued.state.model.betweenHand.rejectedOnceHandProposal).toBeNull();
    expect(queued.effects).toEqual([{ type: 'controller-cancel-proposal', id: '9' }]);

    const succeeded = reduceSessionMachine(queued.state, {
      type: 'proposal-command-succeeded',
      command: 'cancel-proposal',
      id: '9',
    });
    expect(succeeded.state.model.betweenHand.pendingProposals).toEqual([]);
    expect(succeeded.state.model.betweenHand.mode).toBe('decision');
    expect(succeeded.state.model.betweenHand.rejectedOnceHandProposal).toBeNull();
    expect(succeeded.effects).toEqual([]);
  });

  it('accepts definitive cancellation success for an intentionally untracked proposal', () => {
    const state = createSessionMachineState(createSessionModel());
    expect(
      reduceSessionMachine(state, {
        type: 'proposal-command-succeeded',
        command: 'cancel-proposal',
        id: '9',
      }),
    ).toEqual({ state, effects: [], durability: 'durable' });
  });

  it('cancels a matching cached retry before proposing its replacement', () => {
    const state = createSessionMachineState(
      createSessionModel({
        game: { handKey: 1, currentHandOrigin: 'local' },
        betweenHand: {
          mode: 'compose-proposal',
          lastHandProposal: TERMS,
          pendingRetryHandProposal: TERMS,
        },
      }),
    );
    const transition = reduceSessionNotification(
      state,
      incomingProposal('9', 10n, true),
      false,
      reduceSessionMachine,
    );

    expect(transition.state.model.betweenHand.pendingProposals).toEqual([
      {
        ...pending('9', 'peer-cancel-queued'),
        handProposal: { ...TERMS, senderIsPlayerA: true },
      },
    ]);
    expect(transition.state.model.betweenHand.pendingRetryHandProposal).toBeNull();
    expect(transition.effects).toEqual([
      { type: 'controller-cancel-proposal', id: '9' },
      { type: 'controller-propose-game', handProposal: TERMS },
    ]);
  });

  it.each(['peer-accept-queued', 'local-cancel-queued'] as const)(
    'restores a pending %s proposal',
    (lifecycle) => {
      const proposal = pending('7', lifecycle);
      const snapshot = snapshotFromSessionModel(
        createSessionModel({ betweenHand: { pendingProposals: [proposal] } }),
      );
      expect(parsePendingProposals(snapshot.pendingProposals, 'pendingProposals')).toEqual([
        proposal,
      ]);
    },
  );

  it('never removes a live game when proposal and game numeric IDs collide', () => {
    let state = reduceSessionNotification(
      withProposal(pending('1', 'local-outgoing')),
      {
        ProposalAcceptedGroup: {
          id: 1n,
          members: [
            {
              id: 7n,
              player_a_contribution: '10',
              player_b_contribution: '10',
              our_turn: true,
              readable_parameters: Program.fromBigInt(10n).serialize(),
            },
          ],
        },
      },
      false,
      reduceSessionMachine,
    ).state;
    state = reduceSessionMachine(state, {
      type: 'upsert-pending-proposal',
      proposal: pending('7', 'local-outgoing'),
    }).state;
    state = reduceSessionNotification(
      state,
      {
        InsufficientBalance: {
          id: 7n,
          our_balance_short: true,
          their_balance_short: false,
        },
      },
      false,
      reduceSessionMachine,
    ).state;
    expect(state.model.betweenHand.pendingProposals).toEqual([]);
    expect(state.model.game.activeIds).toEqual(['7']);
    expect(state.model.game.handState).not.toBeNull();
  });

  it('persists a hidden malformed proposal until definitive cancellation is ordered', () => {
    const transition = reduceSessionNotification(
      createSessionMachineState(createSessionModel()),
      {
        ProposalMade: {
          id: 77n,
          game_type: testProtocolId('calpoker'),
          timeout: 15n,
          sender_is_player_a: false,
          parameters: [10n, 20n],
        },
      },
      false,
      reduceSessionMachine,
    );
    const hidden = transition.state.model.betweenHand.pendingProposals[0];

    expect(hidden).toMatchObject({ id: '77', lifecycle: 'peer-cancel-queued' });
    expect(selectIncomingProposal(transition.state.model)).toBeNull();
    expect(transition.effects).toContainEqual({
      type: 'controller-cancel-proposal',
      id: '77',
    });
    const snapshot = snapshotFromSessionModel(transition.state.model);
    expect(parsePendingProposals(snapshot.pendingProposals, 'pendingProposals')).toEqual([hidden]);
  });
});
