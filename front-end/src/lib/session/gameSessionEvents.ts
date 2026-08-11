import type {
  ActionFailedPayload,
  GameSettledPayload,
  GameStatusPayload,
  MoveRejectedPayload,
  WasmNotification,
} from '../../types/ChiaGaming';
import { coinIdFromBytes, coerceToBytes } from '../../util';
import {
  isSettlementOutcome,
  parseSettlementShare,
  settlementLabel,
  type SettlementOutcome,
} from '../settlement';
import { decodeGameTerms, isRegisteredGameType } from '../gameRegistry';
import { DEFAULT_GAME_TIMEOUT_BLOCKS } from './normalization';
import type {
  GameTerminalModel,
  GameTurnState,
  HandTermsModel,
  ProposalGroupModel,
  QueuedNotificationModel,
} from './types';

export type GameplayEvent =
  | { ProposalAccepted: { id: bigint | number | string } }
  | { OpponentMoved: { readable: Uint8Array | number[]; gameId?: string; moverShare: string } }
  | { GameMessage: { readable: Uint8Array | number[]; gameId?: string } }
  | { MoveRejected: { gameId: string; tag: string; message: string } }
  | { Settled: { gameId: string; outcome: SettlementOutcome; ourShare: string } }
  | {
      GameError: {
        gameId: string;
        reason: string;
        source: 'action' | 'terminal';
        action?: 'make-move' | 'accept-settlement';
      };
    };

export type GameTerminalInfo = GameTerminalModel;
export interface GameTerminalAttentionInfo {
  label: string;
  myReward: string | null;
  rewardCoinHex: string | null;
}
export type HandTerms = HandTermsModel;
export type QueuedNotification = QueuedNotificationModel;

export function parseAmount(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === 'object' && 'Amount' in (value as Record<string, unknown>)) {
    return String((value as Record<string, unknown>).Amount);
  }
  return String(value);
}

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

export function settledEventForInfo(gameId: string, info: GameTerminalInfo): GameplayEvent | null {
  if (info.type !== 'settled' || info.outcome == null || info.myReward == null) return null;
  return {
    Settled: { gameId, outcome: info.outcome, ourShare: info.myReward },
  };
}

export function gameplayEventsForGameStatus(
  notification: WasmNotification,
  activeIds: string[],
  terminalEvent: GameplayEvent | null,
): GameplayEvent[] {
  const status = notification.GameStatus as GameStatusPayload | undefined;
  if (!status) return [];
  const id = String(status.id);
  const readable = coerceToBytes(status.other_params?.readable);
  const events: GameplayEvent[] = [];
  if (readable) {
    const moverShare = parseAmount(status.other_params?.mover_share);
    if (moverShare != null) {
      events.push({ OpponentMoved: { readable, gameId: id, moverShare } });
    } else if (activeIds.includes(id)) {
      events.push({ GameMessage: { readable, gameId: id } });
    }
  }
  if (terminalEvent) events.push(terminalEvent);
  return events;
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

function parseTimeout(value: unknown): bigint | null {
  if (value == null) return DEFAULT_GAME_TIMEOUT_BLOCKS;
  const raw =
    typeof value === 'object' && value !== null && 'Timeout' in value
      ? (value as Record<string, unknown>).Timeout
      : value;
  try {
    const timeout = BigInt(String(raw));
    return timeout > 0n ? timeout : null;
  } catch {
    return null;
  }
}

function decodeHexText(value: string): string {
  if (!/^[0-9a-f]+$/i.test(value)) return value;
  return String.fromCharCode(...(value.match(/.{2}/g) ?? []).map((part) => parseInt(part, 16)));
}

function gameTypeFromValue(value: Record<string, unknown>): HandTerms['gameType'] | null {
  const raw = value.game_type;
  if (typeof raw !== 'string') return null;
  const decoded = decodeHexText(raw);
  return isRegisteredGameType(decoded) ? decoded : null;
}

export function parseTermsFromNotificationValue(
  value: unknown,
  gameType?: HandTerms['gameType'],
): HandTerms | null {
  if (typeof value !== 'object' || value === null) return null;
  const object = value as Record<string, unknown>;
  const mine = parseAmount(object.my_contribution);
  const theirs = parseAmount(object.their_contribution);
  const resolvedType = gameType ?? gameTypeFromValue(object);
  const timeout = parseTimeout(object.timeout);
  if (!mine || !theirs || !resolvedType || timeout == null) return null;
  try {
    return decodeGameTerms(
      resolvedType,
      {
        myContribution: BigInt(mine),
        theirContribution: BigInt(theirs),
        gameTimeout: timeout,
      },
      object.initial_state,
    );
  } catch {
    return null;
  }
}

export function parseIncomingProposal(value: unknown): ProposalGroupModel | null {
  if (typeof value !== 'object' || value === null) return null;
  const object = value as Record<string, unknown>;
  const gameType = gameTypeFromValue(object);
  const terms = gameType ? parseTermsFromNotificationValue(object, gameType) : null;
  const memberIds = Array.isArray(object.group_ids) ? object.group_ids.map(String) : [];
  if (!terms || object.id == null || memberIds.length === 0) return null;
  return {
    primaryId: String(object.id),
    memberIds,
    terms,
    origin: 'peer',
    disposition: 'incoming-cached',
  };
}

export async function coinIdHex(value: unknown): Promise<string | null> {
  const bytes = coerceToBytes(value);
  return bytes ? coinIdFromBytes(bytes) : null;
}
