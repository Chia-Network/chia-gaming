import { DEFAULT_CATALOG_GAME_TYPE } from '../gameRegistry';
import type { ChannelStatus } from '../../types/ChiaGaming';
import {
  INITIAL_GAME_TERMINAL_MODEL,
  nextGameInstanceAfterLocalTurn,
  projectGameStatus,
} from './presentation';
import type {
  GameModel,
  GameInstanceModel,
  ProposalOrigin,
  GameTerminalModel,
  GameTurnState,
  RegisteredGameType,
} from './types';
import type { NonTerminalGameStatusPayload } from './presentation';

export type { GameProtocolPresentation } from './types';

export type GameSliceAction =
  | { type: 'channel-active' }
  | {
      type: 'accepted-group';
      groupIds: string[];
      members: readonly { amount: string; startTurn: GameTurnState }[];
      origin: ProposalOrigin;
      gameType: RegisteredGameType;
    }
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

function requireInstance(slice: GameModel, id: string): GameInstanceModel {
  const instance = slice.instances[id];
  if (!instance) throw new Error(`Game slice invariant broken: missing instance ${id}`);
  return instance;
}

function newInstance(id: string, amount: string, turnState: GameTurnState): GameInstanceModel {
  return {
    id,
    amount,
    coinHex: null,
    presentation: turnState === 'my-turn' ? 'off-chain-my-turn' : 'off-chain-their-turn',
    terminal: INITIAL_GAME_TERMINAL_MODEL,
  };
}

export function assertCompleteGameSlice(slice: GameModel): void {
  for (const id of new Set([
    ...slice.activeIds,
    ...slice.currentHandIds,
    ...(slice.lastDisplayedId === null ? [] : [slice.lastDisplayedId]),
  ])) {
    requireInstance(slice, id);
  }
}

export function gameSliceReducer(slice: GameModel, action: GameSliceAction): GameModel {
  let next: GameModel;
  switch (action.type) {
    case 'channel-active':
      next = slice.handKey === 0 ? { ...slice, handKey: 1 } : slice;
      break;
    case 'accepted-group': {
      if (action.groupIds.length === 0) {
        throw new Error('Game slice invariant broken: accepted group is empty');
      }
      if (action.members.length !== action.groupIds.length) {
        throw new Error('Game slice invariant broken: accepted member facts do not match group');
      }
      const sameHand =
        slice.currentHandIds.length === action.groupIds.length &&
        slice.currentHandIds.every((id, index) => id === action.groupIds[index]);
      const newHand = !sameHand;
      const instances = newHand ? {} : { ...slice.instances };
      for (const [index, id] of action.groupIds.entries()) {
        const member = action.members[index]!;
        instances[id] = newInstance(id, member.amount, member.startTurn);
      }
      next = {
        ...slice,
        handKey: newHand ? slice.handKey + 1 : slice.handKey,
        activeIds: newHand ? [...action.groupIds] : slice.activeIds,
        currentHandIds: newHand ? [...action.groupIds] : slice.currentHandIds,
        currentHandOrigin: newHand ? action.origin : slice.currentHandOrigin,
        instances,
        lastDisplayedId: newHand ? action.groupIds[0]! : slice.lastDisplayedId,
        activeGameType: newHand ? action.gameType : slice.activeGameType,
      };
      break;
    }
    case 'status': {
      const instance = requireInstance(slice, action.id);
      next = {
        ...slice,
        instances: {
          ...slice.instances,
          [action.id]: projectGameStatus({
            previous: instance,
            payload: action.payload,
            channelState: action.channelState,
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
          [action.id]: nextGameInstanceAfterLocalTurn(
            instance,
            action.isMyTurn,
            action.channelState,
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
      next = {
        ...slice,
        handKey: 0,
        activeIds: [],
        currentHandIds: [],
        currentHandOrigin: null,
        instances: {},
        lastDisplayedId: null,
        activeGameType: DEFAULT_CATALOG_GAME_TYPE,
        handState: null,
      };
      break;
  }
  assertCompleteGameSlice(next);
  return next;
}
