import React, { useCallback } from 'react';

import Calpoker from '../features/calPoker';
import type { SessionModel } from '../lib/session/model';
import {
  selectFinishedSessionDisplay,
  stringifyCalpokerSnapshot,
} from '../lib/session/finishedSessionDisplay';
import type { CalpokerDisplaySnapshotView } from '../types/californiaPoker/CaliforniapokerProps';

export interface FinishedSessionGameViewProps {
  model: SessionModel;
  myName?: string;
  opponentName?: string;
  /** Matches live GameSession: starter is player 1. */
  iStarted?: boolean;
}

const noop = () => {};
const noopSelections = (_: string[] | ((prev: string[]) => string[])) => {};
const noopHandOrder = (_playerHand: string[], _opponentHand?: string[]) => {};
const noopSnapshot = (_snapshot: CalpokerDisplaySnapshotView) => {};

/**
 * Read-only Game-tab view after the live WASM session is torn down.
 * Prefers a frozen calpoker board from persisted handState; otherwise a
 * terminal summary so the tab never goes blank.
 */
const FinishedSessionGameView: React.FC<FinishedSessionGameViewProps> = ({
  model,
  myName,
  opponentName,
  iStarted = false,
}) => {
  const display = selectFinishedSessionDisplay(model);
  const playerNumber = iStarted ? 1 : 2;
  const handleGameLog = useCallback((_lines: string[]) => {}, []);

  return (
    <div
      className='relative flex h-full w-full min-h-0 flex-col'
      data-testid='finished-session-game-view'
    >
      {display.hasCalpokerBoard && display.calpoker ? (
        <div className='relative flex-1 min-h-0 pointer-events-none' aria-disabled='true'>
          <Calpoker
            outcome={undefined}
            moveNumber={String(display.calpoker.moveNumber)}
            playerNumber={playerNumber}
            playerHand={display.calpoker.playerHand.map(String)}
            opponentHand={display.calpoker.opponentHand.map(String)}
            cardSelections={(display.calpoker.cardSelections ?? []).map(String)}
            setCardSelections={noopSelections}
            setHandOrder={noopHandOrder}
            handleMakeMove={noop}
            handleCheat={noop}
            handleNerf={noop}
            onGameLog={handleGameLog}
            onSnapshotChange={noopSnapshot}
            initialSnapshot={stringifyCalpokerSnapshot(display.calpoker.displaySnapshot)}
            myName={myName}
            opponentName={opponentName}
            settlementOutcome={model.game.terminal.outcome}
          />
        </div>
      ) : (
        <div
          className='flex-1 flex items-center justify-center text-canvas-solid px-4 text-center'
          data-testid='finished-session-fallback'
        >
          {display.terminalLabel ?? 'No hand details available'}
        </div>
      )}
    </div>
  );
};

export default FinishedSessionGameView;
