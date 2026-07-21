import type { CalpokerDisplaySnapshot, CalpokerHandState } from '../../hooks/save';
import { calpokerStateFromPersisted } from '../../hooks/useCalpokerHand';
import {
  spacepokerStateFromPersisted,
  type SpacepokerHandState,
} from '../../hooks/useSpacepokerHand';
import { krunkStateFromPersisted } from '../../hooks/useKrunkHand';
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

export { calpokerStateFromPersisted, spacepokerStateFromPersisted };

/**
 * Prepare a SessionModel for React props: keep handState readable but
 * non-enumerable so React's error/prop describe path never JSON.stringifies
 * nested bigint card arrays (which throws and can lock the UI).
 */
export function sessionModelForReactProps(model: SessionModel): SessionModel {
  const game = { ...model.game };
  const handState = game.handState;
  delete (game as { handState?: unknown }).handState;
  Object.defineProperty(game, 'handState', {
    value: handState,
    enumerable: false,
    configurable: true,
    writable: true,
  });
  return { ...model, game };
}

export interface FinishedSessionDisplay {
  banner: string;
  terminalLabel: string | null;
  terminalReward: string | null;
  calpoker: CalpokerHandState | undefined;
  spacepoker: SpacepokerHandState | undefined;
  hasCalpokerBoard: boolean;
  hasSpacepokerBoard: boolean;
  /** True when GameHandHost frozen remount should be used. */
  canRemountHand: boolean;
}

function hasMeaningfulCalpokerSnapshot(calpoker: CalpokerHandState): boolean {
  const snap = calpoker.displaySnapshot;
  if (!snap) return false;
  return !!(
    snap.playerBestHandCardIds.length > 0
    || snap.opponentBestHandCardIds.length > 0
    || snap.playerDisplayText
    || snap.opponentDisplayText
    || snap.gameState
  );
}

/** Pure selection used by FinishedSessionGameView and unit tests. */
export function selectFinishedSessionDisplay(model: SessionModel): FinishedSessionDisplay {
  const terminal = model.game.terminal;
  const outcomeLabel = terminal.outcome
    ? SETTLEMENT_OUTCOME_LABELS[terminal.outcome]
    : null;
  const terminalLabel = terminal.label ?? outcomeLabel;
  const calpoker = calpokerStateFromPersisted(model.game.handState);
  const spacepoker = spacepokerStateFromPersisted(model.game.handState);
  const krunk = krunkStateFromPersisted(model.game.handState);
  const hasCalpokerBoard = !!(
    calpoker
    && (
      hasMeaningfulCalpokerSnapshot(calpoker)
      || calpoker.playerHand.length > 0
      || calpoker.opponentHand.length > 0
      || calpoker.settlementOutcome
    )
  );
  const hasSpacepokerBoard = !!(
    spacepoker
    && (
      spacepoker.playerHoleCards
      || spacepoker.opponentHoleCards
      || (spacepoker.terminalState && spacepoker.terminalState !== 'none')
      || spacepoker.outcome
      || spacepoker.settlementOutcome
      || spacepoker.handHistory.length > 0
    )
  );
  return {
    banner: 'Session finished',
    terminalLabel,
    terminalReward: terminal.myReward,
    calpoker,
    spacepoker,
    hasCalpokerBoard,
    hasSpacepokerBoard,
    // Recovery mounts the registered game from validated persisted hand state;
    // it is not gated on game-specific board-content heuristics.
    canRemountHand: !!(calpoker || spacepoker || krunk),
  };
}
