import React from 'react';

import { CaliforniaPoker } from './components';
import { useCheatKeys } from '../../host/ui';
import { CalpokerDisplaySnapshotView, CalpokerOutcomeView } from './types/CaliforniapokerProps';
import type { GameInteractionMode, SettlementOutcome } from '../../host';

export interface CalpokerProps {
  outcome: CalpokerOutcomeView | undefined;
  moveNumber: string;
  playerNumber: number;
  playerHand: string[];
  opponentHand: string[];
  cardSelections: string[];
  setCardSelections: (n: string[] | ((prev: string[]) => string[])) => void;
  setHandOrder: (playerHand: string[], opponentHand?: string[]) => void;
  handleMakeMove: () => void;
  handleCheat: () => void;
  onGameLog: (lines: string[]) => void;
  onSnapshotChange: (snapshot: CalpokerDisplaySnapshotView) => void;
  initialSnapshot?: CalpokerDisplaySnapshotView;
  myName?: string;
  opponentName?: string;
  terminalOutcome?: SettlementOutcome | null;
  interactionMode?: GameInteractionMode;
}

const Calpoker: React.FC<CalpokerProps> = ({
  outcome,
  moveNumber,
  playerNumber,
  playerHand,
  opponentHand,
  cardSelections,
  setCardSelections,
  setHandOrder,
  handleMakeMove,
  handleCheat,
  onGameLog,
  onSnapshotChange,
  initialSnapshot,
  myName,
  opponentName,
  terminalOutcome,
  interactionMode = 'live',
}) => {
  useCheatKeys(handleCheat, interactionMode === 'live');

  return (
    <div className="relative flex h-full w-full min-h-0 flex-col">
      {/* Game area */}
      <div className="flex-1 min-h-0 flex flex-col">
        <CaliforniaPoker
          playerNumber={playerNumber}
          moveNumber={moveNumber}
          playerHand={playerHand}
          opponentHand={opponentHand}
          cardSelections={cardSelections}
          setCardSelections={setCardSelections}
          setHandOrder={setHandOrder}
          handleMakeMove={handleMakeMove}
          outcome={outcome}
          onGameLog={onGameLog}
          onSnapshotChange={onSnapshotChange}
          initialSnapshot={initialSnapshot}
          myName={myName}
          opponentName={opponentName}
          terminalOutcome={terminalOutcome}
          interactionMode={interactionMode}
        />
      </div>
    </div>
  );
};

export default Calpoker;
