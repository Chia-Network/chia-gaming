import { reduceBetweenHandEvent } from './sessionMachineBetweenHands';
import { reduceChannelEvent } from './sessionMachineChannel';
import { reduceSessionCommand } from './sessionMachineCommands';
import { reduceDurableGameEvent, type ActiveGameHandContext } from './sessionMachineGame';
import { reduceSessionNotification } from './sessionMachineNotifications';
import { reduceProposalEvent } from './sessionMachineProposals';
import type {
  ClassifiedSessionMachineTransition,
  SessionMachineCoordination,
  SessionMachineEvent,
  SessionMachineState,
  SessionMachineTransition,
} from './sessionMachineTypes';
import type { SessionModel } from './types';

function initialCoordination(
  model: SessionModel,
  firstGameAccepted: boolean,
): SessionMachineCoordination {
  return {
    firstGameAccepted,
    sameTermsRequested: false,
    nextNotificationId: [...model.channel.queue, ...model.game.queue].reduce(
      (maximum, notification) => (notification.id > maximum ? notification.id : maximum),
      0n,
    ),
    channelEnrichmentGeneration: 0,
    gameEnrichmentGeneration: {},
    hostOnChain: false,
  };
}

export function createSessionMachineState(
  model: SessionModel,
  options: { firstGameAccepted?: boolean } = {},
): SessionMachineState {
  return {
    model,
    coordination: initialCoordination(
      model,
      options.firstGameAccepted ?? model.channel.status.state === 'Active',
    ),
  };
}

function assertNever(event: never): never {
  throw new Error(`Unhandled session machine event: ${JSON.stringify(event)}`);
}

function classifyTransition(
  event: SessionMachineEvent,
  transition: SessionMachineTransition,
): ClassifiedSessionMachineTransition {
  if (
    event.type === 'wasm-notification' &&
    'MoveRejected' in event.notification &&
    event.notification.MoveRejected != null
  ) {
    return { ...transition, durability: 'projection-only' };
  }
  return { ...transition, durability: 'durable' };
}

export function reduceSessionMachine(
  state: SessionMachineState,
  event: SessionMachineEvent,
  activeHand?: ActiveGameHandContext,
): ClassifiedSessionMachineTransition {
  switch (event.type) {
    case 'choose-same-terms':
    case 'reject-current-proposal':
    case 'open-compose':
    case 'submit-compose':
    case 'accept-review':
    case 'reject-review':
      return classifyTransition(event, reduceSessionCommand(state, event));

    case 'wasm-notification':
      return classifyTransition(
        event,
        reduceSessionNotification(
          state,
          event.notification,
          event.iStarted,
          (nextState, nextEvent) => reduceSessionMachine(nextState, nextEvent, activeHand),
        ),
      );

    case 'channel-status':
    case 'channel-coin-enriched':
    case 'connection':
    case 'host-projection':
    case 'clean-shutdown-started':
    case 'dismissed-channel-status':
    case 'push-channel-notification':
    case 'push-game-notification':
    case 'remove-game-notifications':
    case 'dismiss-channel-notification':
    case 'dismiss-channel':
    case 'dismiss-game-notification':
    case 'controller-command-failed':
    case 'clean-shutdown-command-succeeded':
    case 'start-clean-shutdown':
    case 'go-on-chain':
    case 'go-on-chain-result':
    case 'enqueue-error':
    case 'coin-enrichment-completed':
      return classifyTransition(event, reduceChannelEvent(state, event));

    case 'set-between-hand-mode':
    case 'set-rejected-terms':
    case 'set-last-terms':
    case 'set-pending-retry-terms':
    case 'set-new-hand-requested':
    case 'select-compose-game':
    case 'set-compose-timeout':
    case 'set-compose-proposal-sent':
    case 'set-same-terms-requested':
    case 'set-first-game-accepted':
      return classifyTransition(event, reduceBetweenHandEvent(state, event));

    case 'upsert-pending-proposal':
    case 'set-proposal-lifecycle':
    case 'clear-proposals':
    case 'request-accept-proposal':
    case 'request-cancel-proposal':
    case 'request-propose-game':
    case 'proposal-sent':
    case 'proposal-command-succeeded':
      return classifyTransition(event, reduceProposalEvent(state, event));

    case 'game':
    case 'notification-accepted-group':
    case 'notification-game-status':
    case 'notification-game-terminal':
    case 'notification-abandoned':
    case 'hand-state-changed':
    case 'local-game-action-committed':
    case 'local-action-applied':
      return classifyTransition(event, reduceDurableGameEvent(state, event, activeHand));

    default:
      return assertNever(event);
  }
}
