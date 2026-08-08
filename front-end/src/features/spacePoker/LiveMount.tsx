import { lazy, useCallback } from 'react';
import type { Observable } from 'rxjs';
import type { SessionController } from '../../hooks/SessionController';
import type { GameplayEvent } from '../../hooks/useGameSession';
import type { PersistedGameState } from '../../lib/session/gameStateCodec';
import type { HandTermsModel } from '../../lib/session/types';
import type { GameTerminalModel } from '../../lib/session/types';
import { formatAmount } from '../../util';
import { resolveSpacepokerUnitSize } from './unitSize';

const SpacePoker = lazy(() => import('./SpacePoker'));

export interface SpacepokerLiveMountProps {
  gameObject: SessionController;
  gameId: string;
  iStarted: boolean;
  gameplayEvent$: Observable<GameplayEvent>;
  terms: Extract<HandTermsModel, { gameType: 'spacepoker' }>;
  initialPersistedState?: PersistedGameState;
  onTurnChanged: (gameId: string, isMyTurn: boolean) => void;
  appendGameLog: (line: string) => void;
  myName?: string;
  opponentName?: string;
  terminal: GameTerminalModel;
}

export function SpacepokerLiveMount(props: SpacepokerLiveMountProps) {
  const {
    gameObject,
    gameId,
    iStarted,
    gameplayEvent$,
    terms,
    initialPersistedState,
    onTurnChanged,
    appendGameLog,
    myName,
    opponentName,
    terminal,
  } = props;
  const unitSizeMojos = resolveSpacepokerUnitSize({
    terms,
    persistedState: initialPersistedState,
  });
  if (!unitSizeMojos) {
    throw new Error('Space Poker mount requires one canonical positive unit size');
  }
  const stackSize = terms.myContribution / unitSizeMojos;
  const handleTurnChanged = useCallback(
    (isMyTurn: boolean) => onTurnChanged(gameId, isMyTurn),
    [gameId, onTurnChanged],
  );
  const handleGameLog = useCallback(
    (lines: string[]) => {
      appendGameLog(`Space Poker ${stackSize} (${formatAmount(unitSizeMojos)})`);
      lines.forEach(appendGameLog);
      appendGameLog('');
    },
    [appendGameLog, stackSize, unitSizeMojos],
  );

  return (
    <SpacePoker
      gameObject={gameObject}
      gameId={gameId}
      iStarted={iStarted}
      gameplayEvent$={gameplayEvent$}
      betSize={terms.myContribution.toString()}
      unitSizeMojos={unitSizeMojos.toString()}
      onTurnChanged={handleTurnChanged}
      onGameLog={handleGameLog}
      myName={myName}
      opponentName={opponentName}
      terminal={terminal}
    />
  );
}
