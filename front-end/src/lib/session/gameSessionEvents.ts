import type {
  GameSettledPayload,
  GameStatusPayload,
  WasmNotification,
} from '../../types/ChiaGaming';
import { coinIdFromBytes, coerceToBytes } from '../../util';
import { isSettlementOutcome, parseSettlementShare, settlementLabel } from '../settlement';
import type { GameTerminalModel, GameTurnState, QueuedNotificationModel } from './types';

export type GameTerminalInfo = GameTerminalModel;
export interface GameTerminalAttentionInfo {
  label: string;
  myReward: string | null;
  rewardCoinHex: string | null;
}
export type QueuedNotification = QueuedNotificationModel;

export function dispatchWasmNotification(
  notification: WasmNotification,
  handleNotification: (notification: WasmNotification) => void,
  onError: (error: unknown) => void,
): void {
  try {
    handleNotification(notification);
  } catch (error) {
    onError(error);
  }
}

export function terminalInfoFromGameSettled(
  payload: GameSettledPayload,
  rewardCoinHex: string | null,
): GameTerminalInfo {
  const myReward = parseSettlementShare(payload.our_share);
  if (myReward == null) {
    return {
      type: 'game-error',
      outcome: null,
      label: 'Settlement missing our_share',
      myReward: null,
      rewardCoinHex,
    };
  }
  const outcome = isSettlementOutcome(payload.outcome) ? payload.outcome : null;
  if (!outcome) {
    return {
      type: 'game-error',
      outcome: null,
      label: `Unknown settlement: ${String(payload.outcome)}`,
      myReward,
      rewardCoinHex,
    };
  }
  return {
    type: 'settled',
    outcome,
    label: settlementLabel(outcome),
    myReward,
    rewardCoinHex,
  };
}

export function parseGameStatusTerminalInfo(
  status: GameStatusPayload,
  _rewardCoinHex: string | null,
  _turnState: GameTurnState,
): GameTerminalInfo {
  if (status.status === 'ended-cancelled') {
    return {
      type: 'ended-cancelled',
      outcome: null,
      label: 'Cancelled',
      myReward: null,
      rewardCoinHex: null,
    };
  }
  if (status.status === 'ended-error') {
    return {
      type: 'game-error',
      outcome: null,
      label: status.reason ?? 'Error',
      myReward: null,
      rewardCoinHex: null,
    };
  }
  return { type: 'none', outcome: null, label: null, myReward: null, rewardCoinHex: null };
}

export async function coinIdHex(value: unknown): Promise<string | null> {
  const bytes = coerceToBytes(value);
  return bytes ? coinIdFromBytes(bytes) : null;
}
