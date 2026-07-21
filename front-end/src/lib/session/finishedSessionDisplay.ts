import type { CalpokerDisplaySnapshot, CalpokerHandState, PersistedGameState } from '../../hooks/save';
import type { SessionModel } from './model';
import { SETTLEMENT_OUTCOME_LABELS } from '../settlement';
import type { CalpokerDisplaySnapshotView } from '../../types/californiaPoker/CaliforniapokerProps';

export function stringifyCalpokerSnapshot(
  snapshot: CalpokerDisplaySnapshot | undefined,
): CalpokerDisplaySnapshotView | undefined {
  if (!snapshot) return undefined;
  return {
    ...snapshot,
    playerBestHandCardIds: snapshot.playerBestHandCardIds.map(String),
    opponentBestHandCardIds: snapshot.opponentBestHandCardIds.map(String),
    playerHaloCardIds: snapshot.playerHaloCardIds.map(String),
    opponentHaloCardIds: snapshot.opponentHaloCardIds.map(String),
  };
}

export function calpokerStateFromPersisted(
  persisted: PersistedGameState | null | undefined,
): CalpokerHandState | undefined {
  if (!persisted || persisted.gameType !== 'calpoker') return undefined;
  return persisted.state as CalpokerHandState;
}

export interface FinishedSessionDisplay {
  banner: string;
  terminalLabel: string | null;
  terminalReward: string | null;
  calpoker: CalpokerHandState | undefined;
  hasCalpokerBoard: boolean;
}

/** Pure selection used by FinishedSessionGameView and unit tests. */
export function selectFinishedSessionDisplay(model: SessionModel): FinishedSessionDisplay {
  const terminal = model.game.terminal;
  const outcomeLabel = terminal.outcome
    ? SETTLEMENT_OUTCOME_LABELS[terminal.outcome]
    : null;
  const terminalLabel = terminal.label ?? outcomeLabel;
  const calpoker = calpokerStateFromPersisted(model.game.handState);
  const hasCalpokerBoard = !!(
    calpoker
    && (
      (calpoker.displaySnapshot
        && (calpoker.displaySnapshot.playerBestHandCardIds.length > 0
          || calpoker.displaySnapshot.opponentBestHandCardIds.length > 0
          || calpoker.displaySnapshot.playerDisplayText
          || calpoker.displaySnapshot.opponentDisplayText
          || calpoker.displaySnapshot.gameState))
      || calpoker.playerHand.length > 0
      || calpoker.opponentHand.length > 0
    )
  );
  return {
    banner: 'Session finished',
    terminalLabel,
    terminalReward: terminal.myReward,
    calpoker,
    hasCalpokerBoard,
  };
}
