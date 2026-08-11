import type { ChannelStatus } from '../../types/ChiaGaming';
import {
  INITIAL_GAME_TERMINAL_MODEL,
  gameInstanceFromView,
  gameInstanceView,
  nextGameInstanceAfterLocalTurn,
  projectGameStatus,
} from './presentation';
import type {
  GameInstanceModel,
  GameInstanceViewModel,
  ProposalGroupOrigin,
  GameTerminalModel,
  GameTurnState,
  RegisteredGameType,
} from './types';
import type { NonTerminalGameStatusPayload } from './presentation';

export interface GameSlice {
  handKey: number;
  activeIds: string[];
  currentHandIds: string[];
  currentHandOrigin: ProposalGroupOrigin | null;
  instances: Record<string, GameInstanceModel>;
  lastDisplayedId: string | null;
  activeGameType: RegisteredGameType;
}

export type GameSliceInstance = GameInstanceModel;
export type { GameProtocolPresentation } from './types';

export const INITIAL_GAME_SLICE: GameSlice = {
  handKey: 0,
  activeIds: [],
  currentHandIds: [],
  currentHandOrigin: null,
  instances: {},
  lastDisplayedId: null,
  activeGameType: 'calpoker',
};

export type GameSliceAction =
  | { type: 'channel-active' }
  | {
      type: 'accepted-group';
      groupIds: string[];
      acceptedId: string;
      amount: string;
      startTurn: GameTurnState;
      origin: ProposalGroupOrigin;
      gameType?: RegisteredGameType;
    }
  | { type: 'remove-group'; groupIds: readonly string[] }
  | {
      type: 'status';
      id: string;
      payload: NonTerminalGameStatusPayload;
      channelState: ChannelStatus;
    }
  | { type: 'local-turn'; id: string; isMyTurn: boolean; channelState: ChannelStatus }
  | { type: 'coin-enriched'; id: string; coinHex: string }
  | { type: 'settled'; id: string; terminal: GameTerminalModel }
  | { type: 'abandoned' };

function requireInstance(slice: GameSlice, id: string): GameSliceInstance {
  const instance = slice.instances[id];
  if (!instance) throw new Error(`Game slice invariant broken: missing instance ${id}`);
  return instance;
}

function newInstance(id: string, amount: string, turnState: GameTurnState): GameSliceInstance {
  return {
    id,
    amount,
    coinHex: null,
    presentation: turnState === 'my-turn' ? 'off-chain-my-turn' : 'off-chain-their-turn',
    terminal: INITIAL_GAME_TERMINAL_MODEL,
  };
}

export function gameSliceInstanceFromModel(instance: GameInstanceModel): GameSliceInstance {
  return instance;
}

export function gameInstanceModelFromSlice(instance: GameSliceInstance): GameInstanceViewModel {
  return gameInstanceView(instance);
}

export function assertCompleteGameSlice(slice: GameSlice): void {
  for (const id of new Set([
    ...slice.activeIds,
    ...slice.currentHandIds,
    ...(slice.lastDisplayedId === null ? [] : [slice.lastDisplayedId]),
  ])) {
    requireInstance(slice, id);
  }
}

export function gameSliceReducer(slice: GameSlice, action: GameSliceAction): GameSlice {
  let next: GameSlice;
  switch (action.type) {
    case 'channel-active':
      next = slice.handKey === 0 ? { ...slice, handKey: 1 } : slice;
      break;
    case 'accepted-group': {
      if (action.groupIds.length === 0) {
        throw new Error('Game slice invariant broken: accepted group is empty');
      }
      const sameHand =
        slice.currentHandIds.length === action.groupIds.length &&
        slice.currentHandIds.every((id, index) => id === action.groupIds[index]);
      const newHand = !sameHand;
      const instances = newHand ? {} : { ...slice.instances };
      for (const id of action.groupIds) {
        instances[id] = instances[id] ?? newInstance(id, action.amount, action.startTurn);
      }
      instances[action.acceptedId] = {
        ...requireInstance({ ...slice, instances }, action.acceptedId),
        amount: action.amount,
      };
      next = {
        handKey: newHand ? slice.handKey + 1 : slice.handKey,
        activeIds: newHand ? [...action.groupIds] : slice.activeIds,
        currentHandIds: newHand ? [...action.groupIds] : slice.currentHandIds,
        currentHandOrigin: newHand ? action.origin : slice.currentHandOrigin,
        instances,
        lastDisplayedId: newHand ? action.acceptedId : slice.lastDisplayedId,
        activeGameType: newHand ? (action.gameType ?? slice.activeGameType) : slice.activeGameType,
      };
      break;
    }
    case 'remove-group': {
      const removed = new Set(action.groupIds);
      const currentHandIds = slice.currentHandIds.filter((id) => !removed.has(id));
      next = {
        ...slice,
        activeIds: slice.activeIds.filter((id) => !removed.has(id)),
        currentHandIds,
        currentHandOrigin: currentHandIds.length === 0 ? null : slice.currentHandOrigin,
        instances: Object.fromEntries(
          Object.entries(slice.instances).filter(([id]) => !removed.has(id)),
        ),
        lastDisplayedId:
          slice.lastDisplayedId !== null && removed.has(slice.lastDisplayedId)
            ? null
            : slice.lastDisplayedId,
      };
      break;
    }
    case 'status': {
      const instance = requireInstance(slice, action.id);
      const projected = projectGameStatus({
        previous: gameInstanceModelFromSlice(instance),
        payload: action.payload,
        channelState: action.channelState,
      });
      next = {
        ...slice,
        instances: {
          ...slice.instances,
          [action.id]: gameInstanceFromView({
            ...gameInstanceModelFromSlice(instance),
            ...projected,
          }),
        },
      };
      break;
    }
    case 'local-turn': {
      const instance = requireInstance(slice, action.id);
      next = {
        ...slice,
        instances: {
          ...slice.instances,
          [action.id]: gameInstanceFromView(
            nextGameInstanceAfterLocalTurn(
              gameInstanceModelFromSlice(instance),
              action.isMyTurn,
              action.channelState,
            ),
          ),
        },
      };
      break;
    }
    case 'coin-enriched': {
      const instance = requireInstance(slice, action.id);
      next = {
        ...slice,
        instances: {
          ...slice.instances,
          [action.id]: {
            ...instance,
            coinHex: action.coinHex,
          },
        },
      };
      break;
    }
    case 'settled': {
      const instance = requireInstance(slice, action.id);
      const remaining = slice.activeIds.filter((id) => id !== action.id);
      next = {
        ...slice,
        activeIds: remaining,
        instances: {
          ...slice.instances,
          [action.id]: {
            ...instance,
            coinHex: null,
            presentation: 'ended',
            terminal: action.terminal,
          },
        },
        lastDisplayedId: remaining.length === 0 ? action.id : slice.lastDisplayedId,
      };
      break;
    }
    case 'abandoned':
      next = INITIAL_GAME_SLICE;
      break;
  }
  assertCompleteGameSlice(next);
  return next;
}
