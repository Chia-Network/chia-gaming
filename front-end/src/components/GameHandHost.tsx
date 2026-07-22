import { useCallback, type ReactNode } from 'react';
import { EMPTY, type Observable } from 'rxjs';

import CalpokerGameHand from '../features/calPoker/GameHand';
import KrunkGameHand from '../features/krunk/GameHand';
import SpacepokerGameHand from '../features/spacePoker/GameHand';
import type { SessionController } from '../hooks/SessionController';
import type { RawGameNotification } from '../hooks/useGameSession';
import { gameDisplayName } from '../lib/gameRegistry';
import type { HandTermsModel } from '../lib/session/model';
import type { CalpokerOutcome } from '../types/ChiaGaming';

export type GameHandHostMode = 'live' | 'frozen';

/**
 * The session shell owns lifecycle and opaque transport only. Each feature
 * validates its own hand state and terminal records inside its isolated mount.
 */
export interface GameHandHostProps {
  mode: GameHandHostMode;
  gameType: string;
  sessionController: SessionController;
  gameplayEvent$?: Observable<RawGameNotification>;
  gameId: string;
  currentHandGameIds?: string[];
  activeGameIds?: string[];
  iStarted: boolean;
  iProposedHand?: boolean;
  playerNumber: number;
  perGameAmount: bigint;
  lastHandTerms: HandTermsModel;
  myName?: string;
  opponentName?: string;
  settlementOutcome?: string | null;
  gameSettlementOutcomes?: Record<string, string | null>;
  onOutcome?: (outcome: CalpokerOutcome) => void;
  onTurnChanged?: (gameId: string, isMyTurn: boolean) => void;
  appendGameLog?: (line: string) => void;
  handKey?: number;
}

export default function GameHandHost({
  mode,
  gameType,
  sessionController,
  gameplayEvent$,
  gameId,
  currentHandGameIds = [],
  activeGameIds = [],
  iStarted,
  iProposedHand = false,
  playerNumber,
  perGameAmount,
  lastHandTerms,
  myName,
  opponentName,
  settlementOutcome = null,
  gameSettlementOutcomes,
  onOutcome,
  onTurnChanged,
  appendGameLog,
  handKey = 0,
}: GameHandHostProps) {
  const notifications$ = mode === 'frozen' ? EMPTY : (gameplayEvent$ ?? EMPTY);
  const noopTurn = useCallback((_gameId: string, _isMyTurn: boolean) => {}, []);
  const noopLog = useCallback((_line: string) => {}, []);
  const noopOutcome = useCallback((_outcome: CalpokerOutcome) => {}, []);
  const turnHandler = onTurnChanged ?? noopTurn;
  const logHandler = appendGameLog ?? noopLog;
  const outcomeHandler = onOutcome ?? noopOutcome;
  const spacepokerUnitSizeMojos = lastHandTerms.gameType === 'spacepoker' && lastHandTerms.spacepokerUnitSize
    ? String(lastHandTerms.spacepokerUnitSize)
    : undefined;

  let content: ReactNode;
  if (gameType === 'calpoker') {
    content = (
      <CalpokerGameHand
        key={handKey}
        controller={sessionController}
        gameId={gameId}
        iStarted={iStarted}
        playerNumber={playerNumber}
        notifications$={notifications$}
        onOutcome={outcomeHandler}
        onTurnChanged={turnHandler}
        appendGameLog={logHandler}
        perGameAmount={perGameAmount}
        myName={myName}
        opponentName={opponentName}
        settlementOutcome={settlementOutcome}
      />
    );
  } else if (gameType === 'spacepoker') {
    content = (
      <SpacepokerGameHand
        key={handKey}
        controller={sessionController}
        gameId={gameId}
        iStarted={iStarted}
        notifications$={notifications$}
        betSize={String(perGameAmount)}
        unitSizeMojos={spacepokerUnitSizeMojos}
        onTurnChanged={turnHandler}
        appendGameLog={logHandler}
        perGameAmount={perGameAmount}
        myName={myName}
        opponentName={opponentName}
        settlementOutcome={settlementOutcome}
      />
    );
  } else if (gameType === 'krunk') {
    content = (
      <KrunkGameHand
        key={handKey}
        controller={sessionController}
        currentHandGameIds={currentHandGameIds}
        activeGameIds={activeGameIds}
        iProposedHand={iProposedHand}
        notifications$={notifications$}
        betSize={perGameAmount}
        onTurnChanged={turnHandler}
        appendGameLog={logHandler}
        myName={myName}
        opponentName={opponentName}
        frozen={mode === 'frozen'}
        gameSettlementOutcomes={gameSettlementOutcomes}
      />
    );
  } else {
    content = (
      <div className='flex items-center justify-center py-20'>
        <p className='text-canvas-text'>Game not supported: {gameDisplayName(gameType)}</p>
      </div>
    );
  }

  return (
    <div
      className={`relative h-full w-full min-h-0${mode === 'frozen' ? ' pointer-events-none' : ''}`}
      aria-disabled={mode === 'frozen' || undefined}
    >
      {content}
    </div>
  );
}
