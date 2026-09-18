import { Program } from 'clvm-lib';
import { createSessionModel } from '../session/model';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { reduceSessionNotification } from '../session/sessionMachineNotifications';
import { parsePendingProposals } from '../session/persistenceBetweenHands';
import { snapshotFromSessionModel } from '../session/sessionSnapshot';
import type { PendingProposalModel } from '../session/types';
import { selectIncomingProposal } from '../session/selectors';
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
