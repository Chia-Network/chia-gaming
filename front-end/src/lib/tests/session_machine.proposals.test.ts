import { Program } from 'clvm-lib';
import { createSessionModel } from '../session/model';
import { createSessionMachineState, reduceSessionMachine } from '../session/sessionMachine';
import { reduceSessionNotification } from '../session/sessionMachineNotifications';
import { parsePendingProposals } from '../session/persistenceBetweenHands';
import { snapshotFromSessionModel } from '../session/sessionSnapshot';
import type { PendingProposalModel } from '../session/types';

const TERMS = {
  gameType: 'calpoker' as const,
  senderIsPlayerA: false,
  gameTimeout: 15n,
  parameters: 10n,
};

function pending(
  id: string,
  origin: 'local' | 'peer',
  status: PendingProposalModel['status'],
): PendingProposalModel {
  return { id, handProposal: TERMS, origin, status };
}

function withProposal(proposal: PendingProposalModel) {
  return createSessionMachineState(
    createSessionModel({ betweenHand: { pendingProposals: [proposal] } }),
  );
}

describe('scalar advisory proposal lifecycle', () => {
  it('marks a queued acceptance and advisory outgoing cancellation without creating games', () => {
    let accepting = withProposal(pending('7', 'peer', 'incoming-review'));
    accepting = reduceSessionMachine(accepting, {
      type: 'proposal-command-succeeded',
      command: 'accept-proposal',
      id: '7',
      context: 'accept-review',
    }).state;
    expect(accepting.model.betweenHand.pendingProposals[0]?.status).toBe('accepting');
    expect(accepting.model.game.activeIds).toEqual([]);

    let cancelling = withProposal(pending('9', 'local', 'outgoing'));
    cancelling = reduceSessionMachine(cancelling, {
      type: 'proposal-command-succeeded',
      command: 'cancel-proposal',
      id: '9',
    }).state;
    expect(cancelling.model.betweenHand.pendingProposals[0]?.status).toBe('advisory-cancelling');
  });

  it.each([
    [
      'cancelled',
      { ProposalCancelled: { id: 7n, reason: 'CancelledByUs' as const } },
      'advisory-cancelling' as const,
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
      'accepting' as const,
    ],
  ])('resolves queued proposal through %s notification', (_label, notification, status) => {
    const transition = reduceSessionNotification(
      withProposal(pending('7', status === 'advisory-cancelling' ? 'local' : 'peer', status)),
      notification,
      false,
      reduceSessionMachine,
    );
    expect(transition.state.model.betweenHand.pendingProposals).toEqual([]);
    expect(transition.state.model.game.activeIds).toEqual([]);
  });

  it('creates generated games only from ProposalAcceptedGroup', () => {
    const state = reduceSessionNotification(
      withProposal(pending('7', 'peer', 'accepting')),
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
      withProposal(pending('7', 'local', 'advisory-cancelling')),
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
    const state = reduceSessionMachine(withProposal(pending('7', 'peer', 'incoming-review')), {
      type: 'proposal-command-succeeded',
      command: 'cancel-proposal',
      id: '7',
      context: 'reject-review',
    }).state;
    expect(state.model.betweenHand.pendingProposals).toEqual([]);
    expect(state.model.betweenHand.mode).toBe('compose-proposal');
  });

  it.each(['accepting', 'advisory-cancelling'] as const)(
    'restores a pending %s proposal',
    (status) => {
      const proposal = pending('7', status === 'accepting' ? 'peer' : 'local', status);
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
      withProposal(pending('1', 'local', 'outgoing')),
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
      proposal: pending('7', 'local', 'outgoing'),
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
});
