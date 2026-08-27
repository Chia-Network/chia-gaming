import { applyHandProposalToComposeDraft } from './composeDraft';
import type {
  SessionMachineEvent,
  SessionMachineState,
  SessionMachineTransition,
} from './sessionMachineTypes';

export type ProposalEvent = Extract<
  SessionMachineEvent,
  | { type: 'upsert-proposal-group' }
  | { type: 'set-proposal-disposition' }
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
        proposalGroups: tracked
          ? betweenHand.proposalGroups.filter(
              (group) => !group.memberIds.some((id) => tracked.has(id)),
            )
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
    case 'upsert-proposal-group': {
      const groups = state.model.betweenHand.proposalGroups;
      const existing = groups.findIndex((group) =>
        group.memberIds.some((id) => event.group.memberIds.includes(id)),
      );
      const proposalGroups =
        existing < 0
          ? [...groups, event.group]
          : groups.map((group, index) => (index === existing ? event.group : group));
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            betweenHand: { ...state.model.betweenHand, proposalGroups },
          },
        },
        effects: [],
      };
    }
    case 'set-proposal-disposition':
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            betweenHand: {
              ...state.model.betweenHand,
              proposalGroups: state.model.betweenHand.proposalGroups.map((group) =>
                group.primaryId === event.primaryId
                  ? { ...group, disposition: event.disposition }
                  : group,
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
      const group = {
        primaryId: event.ids[0],
        memberIds: [...event.ids],
        handProposal: event.handProposal,
        origin: 'local' as const,
        disposition: 'outgoing' as const,
      };
      const tracked = reduceProposalEvent(state, { type: 'upsert-proposal-group', group });
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
                  mode: 'decision',
                  proposalGroups: betweenHand.proposalGroups.map((group) =>
                    group.primaryId === event.id
                      ? { ...group, disposition: 'incoming-cached' as const }
                      : group,
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
                betweenHand: { ...betweenHand, newHandRequested: false },
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
                proposalGroups: betweenHand.proposalGroups.filter(
                  (group) => group.primaryId !== event.id,
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
                proposalGroups: betweenHand.proposalGroups.filter(
                  (group) => group.primaryId !== event.id,
                ),
                compose: { ...betweenHand.compose, proposalSent: false },
                mode: 'compose-proposal',
              },
            },
          },
          effects: [{ type: 'persist-session' }],
        };
      }
      return { state, effects: [] };
    }
    default:
      return assertNever(event);
  }
}
