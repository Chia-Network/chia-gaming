import { applyTermsToComposeDraft } from './composeDraft';
import { gameTermsEqual, validateGameTerms } from '../gameRegistry';
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
  | { type: 'rejection-fallback-fired' }
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
      const cached = betweenHand.cachedPeerProposal;
      if (cached) {
        if (gameTermsEqual(cached.terms, betweenHand.lastTerms)) {
          return {
            state: {
              ...state,
              model: {
                ...state.model,
                betweenHand: {
                  ...betweenHand,
                  newHandRequested: false,
                },
              },
              coordination: { ...state.coordination, sameTermsRequested: false },
            },
            effects: [
              { type: 'controller-accept-proposal', id: cached.id },
              { type: 'persist-session' },
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
                cachedPeerProposal: null,
                reviewPeerProposal: cached,
                mode: 'review-incoming-proposal',
              },
            },
          },
          effects: [{ type: 'persist-session' }],
        };
      }
      const terms = betweenHand.lastTerms;
      const enough =
        canCover(state.model.channel.status.ourBalance, terms.myContribution) &&
        canCover(state.model.channel.status.theirBalance, terms.theirContribution);
      if (!enough) {
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                compose: applyTermsToComposeDraft(betweenHand.compose, terms),
                mode: 'compose-proposal',
                newHandRequested: false,
              },
            },
            coordination: { ...state.coordination, sameTermsRequested: false },
          },
          effects: [{ type: 'persist-session' }],
        };
      }
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            betweenHand: { ...betweenHand, newHandRequested: true },
          },
          coordination: { ...state.coordination, sameTermsRequested: true },
        },
        effects: [{ type: 'persist-session' }, { type: 'controller-propose-game', terms }],
      };
    }
    case 'reject-current-proposal': {
      const cached = betweenHand.cachedPeerProposal;
      if (cached && !gameTermsEqual(cached.terms, betweenHand.lastTerms)) {
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                cachedPeerProposal: null,
                reviewPeerProposal: cached,
                mode: 'review-incoming-proposal',
              },
            },
          },
          effects: [{ type: 'persist-session' }],
        };
      }
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            betweenHand: {
              ...betweenHand,
              cachedPeerProposal: null,
              rejectedOnceTerms: betweenHand.lastTerms,
              compose: applyTermsToComposeDraft(betweenHand.compose, betweenHand.lastTerms),
              mode: 'compose-proposal',
            },
          },
        },
        effects: [
          ...(cached ? [{ type: 'controller-cancel-proposal' as const, id: cached.id }] : []),
          { type: 'persist-session' },
        ],
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
              compose: applyTermsToComposeDraft(betweenHand.compose, betweenHand.lastTerms),
              mode: 'compose-proposal',
            },
          },
        },
        effects: [{ type: 'persist-session' }],
      };
    case 'submit-compose':
      if (!validateGameTerms(event.terms)) return { state, effects: [] };
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            betweenHand: {
              ...betweenHand,
              compose: { ...betweenHand.compose, proposalSent: true },
            },
          },
        },
        effects: [
          { type: 'persist-session' },
          { type: 'controller-propose-game', terms: event.terms },
        ],
      };
    case 'accept-review': {
      const review = betweenHand.reviewPeerProposal;
      if (!review) return { state, effects: [] };
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            betweenHand: { ...betweenHand, mode: 'decision' },
          },
        },
        effects: [
          { type: 'controller-accept-proposal', id: review.id },
          { type: 'persist-session' },
        ],
      };
    }
    case 'reject-review': {
      const review = betweenHand.reviewPeerProposal;
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            betweenHand: {
              ...betweenHand,
              reviewPeerProposal: null,
              compose: { ...betweenHand.compose, proposalSent: false },
              mode: 'compose-proposal',
            },
          },
        },
        effects: [
          ...(review ? [{ type: 'controller-cancel-proposal' as const, id: review.id }] : []),
          { type: 'persist-session' },
        ],
      };
    }
    case 'rejection-fallback-fired':
      if (
        event.generation !== state.coordination.rejectionTimerGeneration ||
        !state.coordination.expectingCounterProposal
      ) {
        return { state, effects: [] };
      }
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            betweenHand: {
              ...betweenHand,
              compose: applyTermsToComposeDraft(betweenHand.compose, betweenHand.lastTerms),
              mode: 'compose-proposal',
            },
          },
          coordination: { ...state.coordination, expectingCounterProposal: false },
        },
        effects: [{ type: 'persist-session' }],
      };
  }
}
