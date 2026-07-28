import React, { useCallback, useMemo } from 'react';
import { EMPTY } from 'rxjs';

import { CalpokerHand, KrunkHand, SpacePokerHand } from './GameSession';
import { createFrozenHandBridge } from '../hooks/frozenHandBridge';
import type { CalpokerOutcome } from '../features/calPoker/outcome';
import type { SessionModel } from '../lib/session/model';
import { selectFinishedSessionDisplay } from '../lib/session/finishedSessionDisplay';

export interface FinishedSessionGameViewProps {
  model: SessionModel;
  myName?: string;
  opponentName?: string;
  iStarted?: boolean;
  iProposedHand?: boolean;
}

/**
 * Rehydrates a terminal hand only for display. Protocol lifecycle remains
 * absent: feature actions receive a frozen controller and no notifications.
 */
const FinishedSessionGameView: React.FC<FinishedSessionGameViewProps> = ({
  model,
  myName,
  opponentName,
  iStarted = false,
  iProposedHand = false,
}) => {
  const display = selectFinishedSessionDisplay(model);
  const handState = model.game.handState;
  const gameType = handState?.gameType ?? model.game.activeGameType;
  const gameId = model.game.lastDisplayedId
    ?? model.game.currentHandIds[0]
    ?? model.game.activeIds[0]
    ?? 'finished';
  const frozenBridge = useMemo(
    () => createFrozenHandBridge(handState),
    [model.game.handKey, handState],
  );
  const noopTurnChanged = useCallback((_gameId: string, _isMyTurn: boolean) => {}, []);
  const noopLog = useCallback((_line: string) => {}, []);
  const noopOutcome = useCallback((_outcome: CalpokerOutcome) => {}, []);

  if (!display.canRemountHand || !handState) {
    return (
      <div
        className='flex h-full w-full items-center justify-center px-4 text-center text-canvas-solid'
        data-testid='finished-session-fallback'
      >
        {display.terminalLabel ?? 'No hand details available'}
      </div>
    );
  }

  const commonProps = {
    gameObject: frozenBridge,
    iStarted,
    gameplayEvent$: EMPTY,
    onTurnChanged: noopTurnChanged,
    appendGameLog: noopLog,
    myName,
    opponentName,
  };

  return (
    <div
      className='relative h-full w-full min-h-0 pointer-events-none'
      data-testid='finished-session-game-view'
      aria-disabled
      inert
    >
      {gameType === 'calpoker' ? (
        <CalpokerHand
          {...commonProps}
          gameId={gameId}
          playerNumber={iStarted ? 1 : 2}
          onOutcome={noopOutcome}
          perGameAmount={model.betweenHand.lastTerms.myContribution}
        />
      ) : gameType === 'spacepoker' ? (
        <SpacePokerHand
          {...commonProps}
          gameId={gameId}
          betSize={String(model.betweenHand.lastTerms.myContribution)}
          unitSizeMojos={model.betweenHand.lastTerms.gameType === 'spacepoker'
            ? String(model.betweenHand.lastTerms.spacepokerUnitSize ?? 0n)
            : undefined}
          perGameAmount={model.betweenHand.lastTerms.myContribution}
        />
      ) : gameType === 'krunk' ? (
        <KrunkHand
          {...commonProps}
          currentHandGameIds={model.game.currentHandIds}
          activeGameIds={model.game.activeIds}
          iProposedHand={iProposedHand}
          betSize={model.betweenHand.lastTerms.myContribution}
        />
      ) : (
        <div className='flex items-center justify-center py-20 text-canvas-text'>
          Game details unavailable
        </div>
      )}
    </div>
  );
};

export default FinishedSessionGameView;
