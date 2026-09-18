import { applyHandProposalToComposeDraft } from './composeDraft';
import { handProposalsEqual } from '../gameRegistry';
import { selectProposalByLifecycle } from './selectors';
import { isUncancelledProposal, proposalOrigin } from './sessionMachineProposals';
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

export function reduceSessionCommand(
  state: SessionMachineState,
  event: CommandEvent,
): SessionMachineTransition {
  const betweenHand = state.model.betweenHand;
  switch (event.type) {
    case 'choose-same-terms': {
      if (selectProposalByLifecycle(state.model, 'peer-accept-queued')) {
        return { state, effects: [] };
      }
      const cached = selectProposalByLifecycle(state.model, 'peer-cached');
      if (cached) {
        if (
          handProposalsEqual(
            cached.handProposal,
            proposalOrigin(cached),
            betweenHand.lastHandProposal,
            state.model.game.currentHandOrigin,
          )
        ) {
          return {
            state,
            effects: [{ type: 'controller-accept-proposal', id: cached.id }],
          };
        }
        return {
          state: {
            ...state,
            model: {
              ...state.model,
              betweenHand: {
                ...betweenHand,
                pendingProposals: betweenHand.pendingProposals.map((proposal) =>
                  proposal.id === cached.id
                    ? { ...proposal, lifecycle: 'peer-review' as const }
                    : proposal,
                ),
                mode: 'review-incoming-proposal',
              },
            },
          },
          effects: [],
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
          effects: [],
        };
      }
      if (betweenHand.pendingProposals.some(isUncancelledProposal)) {
        return { state, effects: [] };
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
      const cached = selectProposalByLifecycle(state.model, 'peer-cached');
      if (
        cached &&
        !handProposalsEqual(
          cached.handProposal,
          proposalOrigin(cached),
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
                pendingProposals: betweenHand.pendingProposals.map((proposal) =>
                  proposal.id === cached.id
                    ? { ...proposal, lifecycle: 'peer-review' as const }
                    : proposal,
                ),
                mode: 'review-incoming-proposal',
              },
            },
          },
          effects: [],
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
        effects: cached ? [{ type: 'controller-cancel-proposal', id: cached.id }] : [],
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
        effects: [],
      };
    case 'submit-compose':
      if (betweenHand.pendingProposals.some(isUncancelledProposal)) {
        return { state, effects: [] };
      }
      return {
        state,
        effects: [{ type: 'controller-propose-game', handProposal: event.handProposal }],
      };
    case 'accept-review': {
      const review = selectProposalByLifecycle(state.model, 'peer-review');
      if (!review || review.id !== event.id) return { state, effects: [] };
      return {
        state,
        effects: [{ type: 'controller-accept-proposal', id: review.id }],
      };
    }
    case 'reject-review': {
      const review = selectProposalByLifecycle(state.model, 'peer-review');
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
          effects: [],
        };
      }
      return {
        state,
        effects: [{ type: 'controller-cancel-proposal', id: review.id }],
      };
    }
  }
}
