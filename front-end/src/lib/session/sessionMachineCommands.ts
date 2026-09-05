import { applyHandProposalToComposeDraft } from './composeDraft';
import { handProposalsEqual } from '../gameRegistry';
import { proposalContributionForOrigin } from './proposalOrigin';
import { selectProposalGroupByDisposition } from './selectors';
import type {
  SessionMachineEvent,
  SessionMachineState,
  SessionMachineTransition,
} from './sessionMachineTypes';

type CommandEvent = Extract<
  SessionMachineEvent,
  | { type: 'choose-same-terms' }
  | { type: 'reject-current-proposal' }
  | { type: 'open-compose' }
  | { type: 'submit-compose' }
  | { type: 'accept-review' }
  | { type: 'reject-review' }
>;

function canCover(balance: string | null, amount: bigint): boolean {
  if (balance == null) return true;
  try {
    return BigInt(balance) >= amount;
  } catch {
    return true;
  }
}

export function reduceSessionCommand(
  state: SessionMachineState,
  event: CommandEvent,
): SessionMachineTransition {
  const betweenHand = state.model.betweenHand;
  switch (event.type) {
    case 'choose-same-terms': {
      const cached = selectProposalGroupByDisposition(state.model, 'incoming-cached');
      if (cached) {
        if (
          handProposalsEqual(
            cached.handProposal,
            cached.origin,
            betweenHand.lastHandProposal,
            state.model.game.currentHandOrigin,
          )
        ) {
          return {
            state,
            effects: [
              {
                type: 'controller-accept-proposal',
                id: cached.primaryId,
                context: 'choose-same-terms',
              },
            ],
          };
        }
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                proposalGroups: betweenHand.proposalGroups.map((group) =>
                  group.primaryId === cached.primaryId
                    ? { ...group, disposition: 'incoming-review' as const }
                    : group,
                ),
                mode: 'review-incoming-proposal',
              },
            },
          },
          effects: [{ type: 'persist-session' }],
        };
      }
      const terms = betweenHand.lastHandProposal;
      if (terms === null) {
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: { ...betweenHand, mode: 'compose-proposal' },
            },
          },
          effects: [{ type: 'persist-session' }],
        };
      }
      const enough =
        canCover(
          state.model.channel.status.ourBalance,
          proposalContributionForOrigin(terms, state.model.game.currentHandOrigin ?? 'local'),
        ) &&
        canCover(
          state.model.channel.status.theirBalance,
          proposalContributionForOrigin(
            terms,
            state.model.game.currentHandOrigin === 'local' ? 'peer' : 'local',
          ),
        );
      if (!enough) {
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                compose: applyHandProposalToComposeDraft(betweenHand.compose, terms),
                mode: 'compose-proposal',
                newHandRequested: false,
              },
            },
            coordination: { ...state.coordination, sameTermsRequested: false },
          },
          effects: [{ type: 'persist-session' }],
        };
      }
      const localTerms =
        state.model.game.currentHandOrigin === 'peer'
          ? { ...terms, senderIsPlayerA: !terms.senderIsPlayerA }
          : terms;
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            betweenHand: { ...betweenHand, newHandRequested: true },
          },
          coordination: { ...state.coordination, sameTermsRequested: true },
        },
        effects: [{ type: 'controller-propose-game', handProposal: localTerms }],
      };
    }
    case 'reject-current-proposal': {
      const cached = selectProposalGroupByDisposition(state.model, 'incoming-cached');
      if (
        cached &&
        !handProposalsEqual(
          cached.handProposal,
          cached.origin,
          betweenHand.lastHandProposal,
          state.model.game.currentHandOrigin,
        )
      ) {
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                proposalGroups: betweenHand.proposalGroups.map((group) =>
                  group.primaryId === cached.primaryId
                    ? { ...group, disposition: 'incoming-review' as const }
                    : group,
                ),
                mode: 'review-incoming-proposal',
              },
            },
          },
          effects: [{ type: 'persist-session' }],
        };
      }
      return {
        state: cached
          ? state
          : {
              ...state,
              model: {
                ...state.model,
                betweenHand: {
                  ...betweenHand,
                  rejectedOnceHandProposal: betweenHand.lastHandProposal,
                  compose: applyHandProposalToComposeDraft(
                    betweenHand.compose,
                    betweenHand.lastHandProposal,
                  ),
                  mode: 'compose-proposal',
                },
              },
            },
        effects: cached
          ? [
              {
                type: 'controller-cancel-proposal',
                id: cached.primaryId,
                context: 'reject-current-proposal',
              },
            ]
          : [{ type: 'persist-session' }],
      };
    }
    case 'open-compose':
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            betweenHand: {
              ...betweenHand,
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
    case 'submit-compose':
      return {
        state,
        effects: [{ type: 'controller-propose-game', handProposal: event.handProposal }],
      };
    case 'accept-review': {
      const review = selectProposalGroupByDisposition(state.model, 'incoming-review');
      if (!review) return { state, effects: [] };
      return {
        state,
        effects: [
          {
            type: 'controller-accept-proposal',
            id: review.primaryId,
            context: 'accept-review',
          },
        ],
      };
    }
    case 'reject-review': {
      const review = selectProposalGroupByDisposition(state.model, 'incoming-review');
      if (!review) {
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                compose: { ...betweenHand.compose, proposalSent: false },
                mode: 'compose-proposal',
              },
            },
          },
          effects: [{ type: 'persist-session' }],
        };
      }
      return {
        state,
        effects: [
          {
            type: 'controller-cancel-proposal',
            id: review.primaryId,
            context: 'reject-review',
          },
        ],
      };
    }
  }
}
