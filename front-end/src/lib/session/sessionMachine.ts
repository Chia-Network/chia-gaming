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

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index]);
}

function classifyTransition(
  previous: SessionMachineState,
  event: SessionMachineEvent,
  transition: SessionMachineTransition,
): ClassifiedSessionMachineTransition {
  if (
    event.type === 'host-projection' &&
    sameEntries(
      previous.model.history.wasmNotificationHistory,
      transition.state.model.history.wasmNotificationHistory,
    ) &&
    sameEntries(previous.model.history.diagnosticLog, transition.state.model.history.diagnosticLog)
  ) {
    return { ...transition, durability: 'projection-only' };
  }
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
  if (
    event.type === 'clear-durability-error' ||
    (event.type === 'enqueue-error' && event.kind === 'durability-error') ||
    ((event.type === 'dismiss-channel' || event.type === 'dismiss-channel-notification') &&
      state.model.channel.queue[0]?.kind === 'durability-error')
  ) {
    return {
      ...reduceChannelEvent(state, event),
      durability: 'projection-only',
    };
  }
  switch (event.type) {
    case 'choose-same-terms':
    case 'reject-current-proposal':
    case 'open-compose':
    case 'submit-compose':
    case 'accept-review':
    case 'reject-review':
      return classifyTransition(state, event, reduceSessionCommand(state, event));

    case 'wasm-notification':
      return classifyTransition(
        state,
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
      return classifyTransition(state, event, reduceChannelEvent(state, event));

    case 'set-between-hand-mode':
    case 'set-rejected-terms':
    case 'set-last-terms':
    case 'set-pending-retry-terms':
    case 'set-new-hand-requested':
    case 'select-compose-game':
    case 'set-compose-timeout':
    case 'set-compose-proposal-sent':
    case 'set-first-game-accepted':
      return classifyTransition(state, event, reduceBetweenHandEvent(state, event));

    case 'upsert-pending-proposal':
    case 'set-proposal-lifecycle':
    case 'clear-proposals':
    case 'request-accept-proposal':
    case 'request-cancel-proposal':
    case 'request-propose-game':
    case 'proposal-sent':
    case 'proposal-command-succeeded':
      return classifyTransition(state, event, reduceProposalEvent(state, event));

    case 'game':
    case 'notification-accepted-group':
    case 'notification-game-status':
    case 'notification-game-terminal':
    case 'notification-abandoned':
    case 'hand-state-changed':
    case 'local-game-action-committed':
    case 'local-action-applied':
      return classifyTransition(state, event, reduceDurableGameEvent(state, event, activeHand));

    default:
      return assertNever(event);
  }
}
