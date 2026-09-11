import { reduceDurableGameEvent } from './sessionMachineGame';
import type {
  SessionMachineEvent,
  SessionMachineState,
  SessionMachineTransition,
} from './sessionMachineTypes';

export type ChannelEvent = Extract<
  SessionMachineEvent,
  | { type: 'channel-status' }
  | { type: 'channel-coin-enriched' }
  | { type: 'connection' }
  | { type: 'host-projection' }
  | { type: 'clean-shutdown-started' }
  | { type: 'dismissed-channel-status' }
  | { type: 'push-channel-notification' }
  | { type: 'push-game-notification' }
  | { type: 'remove-game-notifications' }
  | { type: 'dismiss-channel-notification' }
  | { type: 'dismiss-channel' }
  | { type: 'dismiss-game-notification' }
  | { type: 'controller-command-failed' }
  | { type: 'clean-shutdown-command-succeeded' }
  | { type: 'start-clean-shutdown' }
  | { type: 'go-on-chain' }
  | { type: 'go-on-chain-result' }
  | { type: 'enqueue-error' }
  | { type: 'coin-enrichment-completed' }
>;

function withSessionPersistence(transition: SessionMachineTransition): SessionMachineTransition {
  return transition.effects.some((effect) => effect.type === 'persist-session')
    ? transition
    : { ...transition, effects: [...transition.effects, { type: 'persist-session' }] };
}

function assertNever(event: never): never {
  throw new Error(`Unhandled channel event: ${JSON.stringify(event)}`);
}

export function reduceChannelEvent(
  state: SessionMachineState,
  event: ChannelEvent,
): SessionMachineTransition {
  let next: SessionMachineState;
  switch (event.type) {
    case 'channel-status': {
      const channelState = {
        ...state,
        model: { ...state.model, channel: { ...state.model.channel, status: event.status } },
      };
      if (event.status.sessionDisposition === 'Abandoned') {
        return reduceDurableGameEvent(channelState, { type: 'notification-abandoned' });
      }
      return { state: channelState, effects: [] };
    }
    case 'channel-coin-enriched':
      next =
        state.model.channel.status.state === event.state
          ? {
              ...state,
              model: {
                ...state.model,
                channel: {
                  ...state.model.channel,
                  status: { ...state.model.channel.status, coinHex: event.coinHex },
                },
              },
            }
          : state;
      break;
    case 'connection':
      next = {
        ...state,
        model: {
          ...state.model,
          channel: { ...state.model.channel, connection: event.connection },
        },
      };
      break;
    case 'host-projection':
      next = {
        ...state,
        model: {
          ...state.model,
          restore: event.restore,
          history: {
            ...state.model.history,
            wasmNotificationHistory: event.wasmNotificationHistory,
            diagnosticLog: event.diagnosticLog,
          },
        },
      };
      break;
    case 'clean-shutdown-started':
      next = {
        ...state,
        model: {
          ...state.model,
          channel: { ...state.model.channel, cleanShutdownStarted: event.started },
        },
      };
      break;
    case 'dismissed-channel-status':
      next = {
        ...state,
        model: {
          ...state.model,
          channel: { ...state.model.channel, dismissedChannelStatus: event.status },
        },
      };
      break;
    case 'push-channel-notification': {
      const queue =
        event.notification.kind === 'channel-state'
          ? [
              ...state.model.channel.queue.filter((item) => item.kind !== 'channel-state'),
              event.notification,
            ]
          : [...state.model.channel.queue, event.notification];
      return {
        state: { ...state, model: { ...state.model, channel: { ...state.model.channel, queue } } },
        effects: [],
      };
    }
    case 'push-game-notification':
      next = {
        ...state,
        model: {
          ...state.model,
          game: { ...state.model.game, queue: [...state.model.game.queue, event.notification] },
        },
      };
      break;
    case 'remove-game-notifications':
      next = {
        ...state,
        model: {
          ...state.model,
          game: {
            ...state.model.game,
            queue: state.model.game.queue.filter((item) => item.kind !== event.kind),
          },
        },
      };
      break;
    case 'dismiss-channel-notification':
      next = {
        ...state,
        model: {
          ...state.model,
          channel: { ...state.model.channel, queue: state.model.channel.queue.slice(1) },
        },
      };
      break;
    case 'dismiss-channel': {
      const dismissed = state.model.channel.queue[0];
      next = {
        ...state,
        model: {
          ...state.model,
          channel: {
            ...state.model.channel,
            dismissedChannelStatus:
              dismissed?.kind === 'channel-state'
                ? state.model.channel.status.state
                : state.model.channel.dismissedChannelStatus,
            queue: state.model.channel.queue.slice(1),
          },
        },
      };
      break;
    }
    case 'dismiss-game-notification':
      next = {
        ...state,
        model: {
          ...state.model,
          game: { ...state.model.game, queue: state.model.game.queue.slice(1) },
        },
      };
      break;
    case 'controller-command-failed': {
      const retryable =
        event.command === 'propose-game'
          ? {
              ...state,
              model: {
                ...state.model,
                betweenHand: {
                  ...state.model.betweenHand,
                  newHandRequested: false,
                  compose: { ...state.model.betweenHand.compose, proposalSent: false },
                },
              },
              coordination: { ...state.coordination, sameTermsRequested: false },
            }
          : state;
      return reduceChannelEvent(retryable, {
        type: 'enqueue-error',
        kind: 'action-failed',
        message: `${event.command} failed: ${event.message}`,
      });
    }
    case 'clean-shutdown-command-succeeded':
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            channel: { ...state.model.channel, cleanShutdownStarted: true },
          },
        },
        effects: [{ type: 'persist-session' }],
      };
    case 'start-clean-shutdown':
      return { state, effects: [{ type: 'controller-clean-shutdown' }] };
    case 'go-on-chain':
      return { state, effects: [{ type: 'controller-go-on-chain' }] };
    case 'go-on-chain-result':
      return {
        state: {
          ...state,
          coordination: { ...state.coordination, hostOnChain: event.started },
        },
        effects: [],
      };
    case 'enqueue-error': {
      const notification = {
        id: state.coordination.nextNotificationId + 1n,
        kind: event.kind,
        title: event.kind === 'durability-error' ? 'Session Storage Error' : 'Error',
        message: event.message,
      };
      return {
        state: {
          ...state,
          model: {
            ...state.model,
            channel: {
              ...state.model.channel,
              queue: [...state.model.channel.queue, notification],
            },
          },
          coordination: {
            ...state.coordination,
            nextNotificationId: notification.id,
          },
        },
        effects: [{ type: 'persist-session' }],
      };
    }
    case 'coin-enrichment-completed': {
      const expected =
        event.target === 'channel'
          ? state.coordination.channelEnrichmentGeneration
          : state.coordination.gameEnrichmentGeneration[event.id];
      if (event.generation !== expected || !event.coinHex) return { state, effects: [] };
      if (event.target === 'channel') {
        if (
          event.channelState === undefined ||
          event.channelState !== state.model.channel.status.state ||
          event.id !== state.model.channel.status.state
        ) {
          return { state, effects: [] };
        }
        return withSessionPersistence(
          reduceChannelEvent(state, {
            type: 'channel-coin-enriched',
            state: event.channelState,
            coinHex: event.coinHex,
          }),
        );
      }
      const instance = state.model.game.instances[event.id];
      if (!instance) return { state, effects: [] };
      if (event.target === 'settlement') {
        if (instance.terminal.type === 'none') return { state, effects: [] };
        return withSessionPersistence(
          reduceDurableGameEvent(state, {
            type: 'game',
            action: {
              type: 'settled',
              id: event.id,
              terminal: { ...instance.terminal, rewardCoinHex: event.coinHex },
            },
          }),
        );
      }
      return withSessionPersistence(
        reduceDurableGameEvent(state, {
          type: 'game',
          action: { type: 'coin-enriched', id: event.id, coinHex: event.coinHex },
        }),
      );
    }
    default:
      return assertNever(event);
  }

  const shouldPersist =
    event.type === 'dismiss-channel-notification' ||
    event.type === 'dismiss-channel' ||
    event.type === 'dismiss-game-notification';
  return {
    state: next,
    effects: shouldPersist && next !== state ? [{ type: 'persist-session' }] : [],
  };
}
