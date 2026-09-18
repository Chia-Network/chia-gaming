import { applyHandProposalToComposeDraft } from './composeDraft';
import { handProposalsEqual } from '../gameRegistry';
import { selectProposalByStatus } from './selectors';
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
      const cached = selectProposalByStatus(state.model, 'incoming-cached');
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
                id: cached.id,
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
                pendingProposals: betweenHand.pendingProposals.map((proposal) =>
                  proposal.id === cached.id
                    ? { ...proposal, status: 'incoming-review' as const }
                    : proposal,
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
      const cached = selectProposalByStatus(state.model, 'incoming-cached');
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
                pendingProposals: betweenHand.pendingProposals.map((proposal) =>
                  proposal.id === cached.id
                    ? { ...proposal, status: 'incoming-review' as const }
                    : proposal,
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
                id: cached.id,
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
      const review = selectProposalByStatus(state.model, 'incoming-review');
      if (!review || review.id !== event.id) return { state, effects: [] };
      return {
        state,
        effects: [
          {
            type: 'controller-accept-proposal',
            id: review.id,
            context: 'accept-review',
          },
        ],
      };
    }
    case 'reject-review': {
      const review = selectProposalByStatus(state.model, 'incoming-review');
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
            id: review.id,
            context: 'reject-review',
          },
        ],
      };
    }
  }
}
