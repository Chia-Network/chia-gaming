import { applyHandProposalToComposeDraft } from './composeDraft';
import type {
  SessionMachineEvent,
  SessionMachineState,
  SessionMachineTransition,
} from './sessionMachineTypes';
import type { PendingProposalLifecycle, PendingProposalModel, ProposalOrigin } from './types';

export type ProposalEvent = Extract<
  SessionMachineEvent,
  | { type: 'upsert-pending-proposal' }
  | { type: 'set-proposal-lifecycle' }
  | { type: 'clear-proposals' }
  | { type: 'request-accept-proposal' }
  | { type: 'request-cancel-proposal' }
  | { type: 'request-propose-game' }
  | { type: 'proposal-sent' }
  | { type: 'proposal-command-succeeded' }
>;

export function proposalOrigin(proposal: PendingProposalModel): ProposalOrigin {
  return proposal.lifecycle.startsWith('local-') ? 'local' : 'peer';
}

export function proposalHasLifecycle(
  proposal: PendingProposalModel,
  lifecycle: PendingProposalLifecycle,
): boolean {
  return proposal.lifecycle === lifecycle;
}

export function clearProposalIds(
  state: SessionMachineState,
  requestedIds?: readonly string[],
): SessionMachineState {
  const betweenHand = state.model.betweenHand;
  const tracked = requestedIds ? new Set(requestedIds) : null;
  return {
    ...state,
    model: {
      ...state.model,
      betweenHand: {
        ...betweenHand,
        pendingProposals: tracked
          ? betweenHand.pendingProposals.filter((proposal) => !tracked.has(proposal.id))
          : [],
      },
    },
  };
}

function assertNever(event: never): never {
  throw new Error(`Unhandled proposal event: ${JSON.stringify(event)}`);
}

export function reduceProposalEvent(
  state: SessionMachineState,
  event: ProposalEvent,
): SessionMachineTransition {
  switch (event.type) {
    case 'upsert-pending-proposal': {
      const proposals = state.model.betweenHand.pendingProposals;
      const existing = proposals.findIndex((proposal) => proposal.id === event.proposal.id);
      const pendingProposals =
        existing < 0
          ? [...proposals, event.proposal]
          : proposals.map((proposal, index) => (index === existing ? event.proposal : proposal));
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            betweenHand: { ...state.model.betweenHand, pendingProposals },
          },
        },
        effects: [],
      };
    }
    case 'set-proposal-lifecycle':
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            betweenHand: {
              ...state.model.betweenHand,
              pendingProposals: state.model.betweenHand.pendingProposals.map((proposal) =>
                proposal.id === event.id ? { ...proposal, lifecycle: event.lifecycle } : proposal,
              ),
            },
          },
        },
        effects: [],
      };
    case 'clear-proposals':
      return { state: clearProposalIds(state, event.ids), effects: [] };
    case 'request-accept-proposal':
      return { state, effects: [{ type: 'controller-accept-proposal', id: event.id }] };
    case 'request-cancel-proposal':
      return { state, effects: [{ type: 'controller-cancel-proposal', id: event.id }] };
    case 'request-propose-game':
      return {
        state,
        effects: [{ type: 'controller-propose-game', handProposal: event.handProposal }],
      };
    case 'proposal-sent': {
      const proposal = {
        id: event.id,
        handProposal: event.handProposal,
        lifecycle: 'local-outgoing' as const,
      };
      const tracked = reduceProposalEvent(state, { type: 'upsert-pending-proposal', proposal });
      return {
        state: {
          ...tracked.state,
          model: {
            ...tracked.state.model,
            betweenHand: {
              ...tracked.state.model.betweenHand,
              compose: { ...tracked.state.model.betweenHand.compose, proposalSent: true },
            },
          },
        },
        effects: [],
      };
    }
    case 'proposal-command-succeeded': {
      const betweenHand = state.model.betweenHand;
      const proposal = betweenHand.pendingProposals.find(({ id }) => id === event.id);
      if (!proposal) {
        throw new Error(`Proposal command succeeded for unknown proposal ${event.id}`);
      }
      if (event.command === 'accept-proposal') {
        if (proposal.lifecycle === 'peer-review') {
          return {
            state: {
              ...state,
              model: {
                ...state.model,
                betweenHand: {
                  ...betweenHand,
                  pendingProposals: betweenHand.pendingProposals.map((proposal) =>
                    proposal.id === event.id
                      ? { ...proposal, lifecycle: 'peer-accept-queued' as const }
                      : proposal,
                  ),
                },
              },
            },
            effects: [],
          };
        }
        if (proposal.lifecycle === 'peer-cached') {
          return {
            state: {
              ...state,
              model: {
                ...state.model,
                betweenHand: {
                  ...betweenHand,
                  newHandRequested: false,
                  pendingProposals: betweenHand.pendingProposals.map((proposal) =>
                    proposal.id === event.id
                      ? { ...proposal, lifecycle: 'peer-accept-queued' as const }
                      : proposal,
                  ),
                },
              },
              coordination: { ...state.coordination, sameTermsRequested: false },
            },
            effects: [],
          };
        }
        throw new Error(
          `Accept command succeeded from invalid proposal lifecycle ${proposal.lifecycle}`,
        );
      }
      if (proposal.lifecycle === 'peer-cached') {
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                pendingProposals: betweenHand.pendingProposals.filter(
                  (proposal) => proposal.id !== event.id,
                ),
                rejectedOnceHandProposal: betweenHand.lastHandProposal,
                compose: applyHandProposalToComposeDraft(
                  betweenHand.compose,
                  betweenHand.lastHandProposal,
                ),
                mode: 'compose-proposal',
              },
            },
          },
          effects: [],
        };
      }
      if (proposal.lifecycle === 'peer-review') {
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                pendingProposals: betweenHand.pendingProposals.filter(
                  (proposal) => proposal.id !== event.id,
                ),
                compose: { ...betweenHand.compose, proposalSent: false },
                mode: 'compose-proposal',
              },
            },
          },
          effects: [],
        };
      }
      if (proposal.lifecycle === 'peer-cancel-queued') {
        return { state: clearProposalIds(state, [event.id]), effects: [] };
      }
      if (proposal.lifecycle === 'local-outgoing') {
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                pendingProposals: betweenHand.pendingProposals.map((candidate) =>
                  candidate.id === event.id
                    ? { ...candidate, lifecycle: 'local-cancel-queued' as const }
                    : candidate,
                ),
              },
            },
          },
          effects: [],
        };
      }
      throw new Error(
        `Cancel command succeeded from invalid proposal lifecycle ${proposal.lifecycle}`,
      );
    }
    default:
      return assertNever(event);
  }
}
