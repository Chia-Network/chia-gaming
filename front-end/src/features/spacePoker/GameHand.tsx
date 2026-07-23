import { useCallback } from 'react';
import type { Observable } from 'rxjs';

import type { SessionController } from '../../hooks/SessionController';
import type { RawGameNotification } from '../../hooks/useGameSession';
import { formatAmount } from '../../util';
import SpacePoker from './SpacePoker';
import type { SpacepokerSettlementOutcome } from './handState';

export interface SpacepokerGameHandProps {
  controller: SessionController;
  gameId: string;
  iStarted: boolean;
  notifications$: Observable<RawGameNotification>;
  betSize: string;
  unitSizeMojos?: string;
  onTurnChanged: (gameId: string, isMyTurn: boolean) => void;
  appendGameLog: (line: string) => void;
  perGameAmount: bigint;
  myName?: string;
  opponentName?: string;
  settlementOutcome?: string | null;
}

export default function SpacepokerGameHand({
  controller,
  gameId,
  iStarted,
  notifications$,
  betSize,
  unitSizeMojos,
  onTurnChanged,
  appendGameLog,
  perGameAmount,
  myName,
  opponentName,
  settlementOutcome,
}: SpacepokerGameHandProps) {
  const unitMojos = unitSizeMojos ? BigInt(unitSizeMojos) : 1n;
  const stackSize = unitMojos > 0n ? perGameAmount / unitMojos : 0n;
  const handleTurnChanged = useCallback(
    (isMyTurn: boolean) => onTurnChanged(gameId, isMyTurn),
    [gameId, onTurnChanged],
  );
  const handleGameLog = useCallback((lines: string[]) => {
    appendGameLog(`Space Poker ${stackSize} (${formatAmount(unitMojos)})`);
    lines.forEach((line) => appendGameLog(line));
    appendGameLog('');
  }, [appendGameLog, stackSize, unitMojos]);

  return (
    <SpacePoker
      gameObject={controller}
      gameId={gameId}
      iStarted={iStarted}
      gameplayEvent$={notifications$}
      betSize={betSize}
      unitSizeMojos={unitSizeMojos}
      onTurnChanged={handleTurnChanged}
      onGameLog={handleGameLog}
      myName={myName}
      opponentName={opponentName}
      settlementOutcome={settlementOutcome as SpacepokerSettlementOutcome | null}
    />
  );
}
