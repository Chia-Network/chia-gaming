import { applyHandProposalToComposeDraft } from './composeDraft';
import type {
  SessionMachineEvent,
  SessionMachineState,
  SessionMachineTransition,
} from './sessionMachineTypes';

export type ProposalEvent = Extract<
  SessionMachineEvent,
  | { type: 'upsert-pending-proposal' }
  | { type: 'set-proposal-status' }
  | { type: 'clear-proposals' }
  | { type: 'request-accept-proposal' }
  | { type: 'request-cancel-proposal' }
  | { type: 'request-propose-game' }
  | { type: 'proposal-sent' }
  | { type: 'proposal-command-succeeded' }
>;

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
    case 'set-proposal-status':
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            betweenHand: {
              ...state.model.betweenHand,
              pendingProposals: state.model.betweenHand.pendingProposals.map((proposal) =>
                proposal.id === event.id ? { ...proposal, status: event.status } : proposal,
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
        origin: 'local' as const,
        status: 'outgoing' as const,
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
        effects: [{ type: 'persist-session' }],
      };
    }
    case 'proposal-command-succeeded': {
      const betweenHand = state.model.betweenHand;
      if (event.command === 'accept-proposal') {
        if (event.context === 'accept-review') {
          return {
            state: {
              ...state,
              model: {
                ...state.model,
                betweenHand: {
                  ...betweenHand,
                  pendingProposals: betweenHand.pendingProposals.map((proposal) =>
                    proposal.id === event.id
                      ? { ...proposal, status: 'accepting' as const }
                      : proposal,
                  ),
                },
              },
            },
            effects: [{ type: 'persist-session' }],
          };
        }
        if (event.context === 'choose-same-terms') {
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
                      ? { ...proposal, status: 'accepting' as const }
                      : proposal,
                  ),
                },
              },
              coordination: { ...state.coordination, sameTermsRequested: false },
            },
            effects: [{ type: 'persist-session' }],
          };
        }
      } else if (event.context === 'reject-current-proposal') {
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
          effects: [{ type: 'persist-session' }],
        };
      } else if (event.context === 'reject-review') {
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
          effects: [{ type: 'persist-session' }],
        };
      }
      if (event.command === 'cancel-proposal') {
        const proposal = betweenHand.pendingProposals.find(({ id }) => id === event.id);
        if (proposal?.origin === 'peer') {
          return {
            state: {
              ...state,
              model: {
                ...state.model,
                betweenHand: {
                  ...betweenHand,
                  pendingProposals: betweenHand.pendingProposals.filter(
                    (candidate) => candidate.id !== event.id,
                  ),
                },
              },
            },
            effects: [{ type: 'persist-session' }],
          };
        }
        if (proposal?.origin === 'local') {
          return {
            state: {
              ...state,
              model: {
                ...state.model,
                betweenHand: {
                  ...betweenHand,
                  pendingProposals: betweenHand.pendingProposals.map((candidate) =>
                    candidate.id === event.id
                      ? { ...candidate, status: 'advisory-cancelling' as const }
                      : candidate,
                  ),
                },
              },
            },
            effects: [{ type: 'persist-session' }],
          };
        }
      }
      return { state, effects: [] };
    }
    default:
      return assertNever(event);
  }
}
