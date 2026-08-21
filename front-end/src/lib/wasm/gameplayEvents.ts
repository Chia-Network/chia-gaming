import type {
  ActionFailedPayload,
  GameStatusPayload,
  MoveRejectedPayload,
} from '../../types/ChiaGaming';
import type { GameplayEvent, GameTerminalModel } from '@games/host';
import { coerceToBytes } from '../../util';
import { parseAmount } from './parseAmount';

export function gameplayEventForMoveRejected(payload: MoveRejectedPayload): GameplayEvent {
  return {
    MoveRejected: {
      gameId: String(payload.id),
      tag: String(payload.tag),
      message: String(payload.message),
    },
  };
}

export function gameplayEventForGameActionError(
  gameId: string,
  action: 'make-move' | 'accept-settlement',
  reason: string,
): GameplayEvent {
  return { GameError: { gameId, action, reason, source: 'action' } };
}

export function gameplayEventForActionFailed(payload: ActionFailedPayload): GameplayEvent | null {
  if (payload.id == null) return null;
  const action =
    payload.action === 'make_move'
      ? 'make-move'
      : payload.action === 'accept_settlement'
        ? 'accept-settlement'
        : null;
  return action
    ? gameplayEventForGameActionError(String(payload.id), action, String(payload.reason))
    : null;
}

export function gameplayEventForSettlement(gameId: string, info: GameTerminalModel): GameplayEvent {
  if (info.type === 'settled' && info.outcome != null && info.myReward != null) {
    return {
      Settled: { gameId, outcome: info.outcome, ourShare: info.myReward },
    };
  }
  return {
    GameError: {
      gameId,
      reason: info.label ?? 'settlement error',
      source: 'terminal',
    },
  };
}

export function gameplayEventForEndedStatus(
  gameId: string,
  info: GameTerminalModel,
): GameplayEvent | null {
  if (info.type !== 'game-error' && info.type !== 'ended-cancelled') return null;
  return {
    GameError: { gameId, reason: info.label ?? info.type, source: 'terminal' },
  };
}

export function gameplayEventsForGameStatus(
  status: GameStatusPayload,
  activeIds: string[],
): GameplayEvent[] {
  const id = String(status.id);
  const readable = coerceToBytes(status.other_params?.readable);
  if (!readable) return [];
  const moverShare = parseAmount(status.other_params?.mover_share);
  if (moverShare != null) {
    return [{ OpponentMoved: { readable, gameId: id, moverShare } }];
  }
  if (activeIds.includes(id)) {
    return [{ GameMessage: { readable, gameId: id } }];
  }
  return [];
}
