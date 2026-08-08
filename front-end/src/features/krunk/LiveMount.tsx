import { lazy, useCallback } from 'react';
import type { Observable } from 'rxjs';
import type { SessionController } from '../../hooks/SessionController';
import type { GameplayEvent } from '../../hooks/useGameSession';
import type { PersistedGameState } from '../../lib/session/gameStateCodec';
import type { GameTerminalModel } from '../../lib/session/types';

const Krunk = lazy(() => import('./Krunk'));

export interface KrunkLiveMountProps {
  gameObject: SessionController;
  currentHandGameIds: string[];
  activeGameIds: string[];
  iProposedHand: boolean;
  gameplayEvent$: Observable<GameplayEvent>;
  betSize: bigint;
  onTurnChanged: (gameId: string, isMyTurn: boolean) => void;
  appendGameLog: (line: string) => void;
  myName?: string;
  opponentName?: string;
  initialPersistedState?: PersistedGameState;
  terminalsById: Record<string, GameTerminalModel>;
}

export function KrunkLiveMount(props: KrunkLiveMountProps) {
  const { appendGameLog, ...rest } = props;
  const handleGameLog = useCallback(
    (lines: string[]) => {
      lines.forEach(appendGameLog);
      appendGameLog('');
    },
    [appendGameLog],
  );
  return <Krunk {...rest} onGameLog={handleGameLog} />;
}
