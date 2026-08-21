import { selectComposeGame, updateSelectedComposeDraft } from './composeDraft';
import type {
  SessionMachineEvent,
  SessionMachineState,
  SessionMachineTransition,
} from './sessionMachineTypes';

export type BetweenHandEvent = Extract<
  SessionMachineEvent,
  | { type: 'set-between-hand-mode' }
  | { type: 'set-rejected-terms' }
  | { type: 'set-last-terms' }
  | { type: 'set-pending-retry-terms' }
  | { type: 'set-new-hand-requested' }
  | { type: 'set-compose-draft' }
  | { type: 'select-compose-game' }
  | { type: 'set-compose-timeout' }
  | { type: 'update-selected-compose-draft' }
  | { type: 'set-compose-proposal-sent' }
  | { type: 'set-same-terms-requested' }
  | { type: 'set-expecting-counter-proposal' }
  | { type: 'set-first-game-accepted' }
  | { type: 'set-last-outcome' }
>;

function assertNever(event: never): never {
  throw new Error(`Unhandled between-hand event: ${JSON.stringify(event)}`);
}

export function reduceBetweenHandEvent(
  state: SessionMachineState,
  event: BetweenHandEvent,
): SessionMachineTransition {
  let next: SessionMachineState;
  switch (event.type) {
    case 'set-between-hand-mode':
      next = {
        ...state,
        model: { ...state.model, betweenHand: { ...state.model.betweenHand, mode: event.mode } },
      };
      break;
    case 'set-rejected-terms':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: { ...state.model.betweenHand, rejectedOnceHandProposal: event.handProposal },
        },
      };
      break;
    case 'set-last-terms':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: { ...state.model.betweenHand, lastHandProposal: event.handProposal },
        },
      };
      break;
    case 'set-pending-retry-terms':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: { ...state.model.betweenHand, pendingRetryHandProposal: event.handProposal },
        },
      };
      break;
    case 'set-new-hand-requested':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: { ...state.model.betweenHand, newHandRequested: event.requested },
        },
      };
      break;
    case 'set-compose-draft':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: { ...state.model.betweenHand, compose: event.compose },
        },
      };
      break;
    case 'select-compose-game':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: {
            ...state.model.betweenHand,
            compose: selectComposeGame(state.model.betweenHand.compose, event.gameType),
          },
        },
      };
      break;
    case 'set-compose-timeout':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: {
            ...state.model.betweenHand,
            compose: { ...state.model.betweenHand.compose, gameTimeout: event.timeout },
          },
        },
      };
      break;
    case 'update-selected-compose-draft':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: {
            ...state.model.betweenHand,
            compose: updateSelectedComposeDraft(state.model.betweenHand.compose, event.draft),
          },
        },
      };
      break;
    case 'set-compose-proposal-sent':
      next = {
        ...state,
        model: {
          ...state.model,
          betweenHand: {
            ...state.model.betweenHand,
            compose: { ...state.model.betweenHand.compose, proposalSent: event.sent },
          },
        },
      };
      break;
    case 'set-same-terms-requested':
      next = {
        ...state,
        coordination: { ...state.coordination, sameTermsRequested: event.requested },
      };
      break;
    case 'set-expecting-counter-proposal':
      next = {
        ...state,
        coordination: { ...state.coordination, expectingCounterProposal: event.expecting },
      };
      break;
    case 'set-first-game-accepted':
      next = {
        ...state,
        coordination: { ...state.coordination, firstGameAccepted: event.accepted },
      };
      break;
    case 'set-last-outcome':
      next = {
        ...state,
        coordination: { ...state.coordination, lastOutcomeWin: event.outcomeWin },
      };
      break;
    default:
      return assertNever(event);
  }

  const shouldPersist =
    event.type === 'select-compose-game' ||
    event.type === 'set-compose-timeout' ||
    event.type === 'update-selected-compose-draft' ||
    event.type === 'set-compose-draft' ||
    event.type === 'set-last-outcome';
  return {
    state: next,
    effects: shouldPersist && next !== state ? [{ type: 'persist-session' }] : [],
  };
}
