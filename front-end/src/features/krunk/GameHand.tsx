import { useCallback } from 'react';
import type { Observable } from 'rxjs';

import type { SessionController } from '../../hooks/SessionController';
import type { RawGameNotification } from '../../hooks/useGameSession';
import Krunk from './Krunk';
import type { KrunkSettlementOutcome } from './handState';

export interface KrunkGameHandProps {
  controller: SessionController;
  currentHandGameIds: string[];
  activeGameIds: string[];
  iProposedHand: boolean;
  notifications$: Observable<RawGameNotification>;
  betSize: bigint;
  onTurnChanged: (gameId: string, isMyTurn: boolean) => void;
  appendGameLog: (line: string) => void;
  myName?: string;
  opponentName?: string;
  frozen: boolean;
  gameSettlementOutcomes?: Record<string, string | null>;
}

export default function KrunkGameHand({
  controller,
  currentHandGameIds,
  activeGameIds,
  iProposedHand,
  notifications$,
  betSize,
  onTurnChanged,
  appendGameLog,
  myName,
  opponentName,
  frozen,
  gameSettlementOutcomes,
}: KrunkGameHandProps) {
  const handleGameLog = useCallback((lines: string[]) => {
    lines.forEach((line) => appendGameLog(line));
    appendGameLog('');
  }, [appendGameLog]);

  return (
    <Krunk
      gameObject={controller}
      currentHandGameIds={currentHandGameIds}
      activeGameIds={activeGameIds}
      iProposedHand={iProposedHand}
      gameplayEvent$={notifications$}
      betSize={betSize}
      onTurnChanged={onTurnChanged}
      onGameLog={handleGameLog}
      myName={myName}
      opponentName={opponentName}
      frozen={frozen}
      gameSettlementOutcomes={gameSettlementOutcomes as Record<string, KrunkSettlementOutcome | null> | undefined}
    />
  );
}
