import React from 'react';

import { CaliforniaPoker } from './components';
import { useCheatNerfKeys } from '../../hooks/useCheatNerfKeys';
import {
  CalpokerDisplaySnapshotView,
  CalpokerOutcomeView,
} from '../../types/californiaPoker/CaliforniapokerProps';

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
  handleNerf: () => void;
  onGameLog: (lines: string[]) => void;
  onSnapshotChange: (snapshot: CalpokerDisplaySnapshotView) => void;
  initialSnapshot?: CalpokerDisplaySnapshotView;
  myName?: string;
  opponentName?: string;
  timeoutByUs?: boolean | null;
  timeoutForfeited?: boolean;
  settlementOutcome?: import('../../lib/settlement').SettlementOutcome | null;
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
  handleNerf,
  onGameLog,
  onSnapshotChange,
  initialSnapshot,
  myName,
  opponentName,
  timeoutByUs,
  timeoutForfeited,
  settlementOutcome,
}) => {
  const myWinOutcome = outcome?.my_win_outcome;

  useCheatNerfKeys(handleCheat, handleNerf);

  return (
    <div className='relative flex h-full w-full min-h-0 flex-col'>
      {/* Game area */}
      <div className='flex-1 min-h-0 flex flex-col'>
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
          myWinOutcome={myWinOutcome}
          onGameLog={onGameLog}
          onSnapshotChange={onSnapshotChange}
          initialSnapshot={initialSnapshot}
          myName={myName}
          opponentName={opponentName}
          timeoutByUs={timeoutByUs}
          timeoutForfeited={timeoutForfeited}
          settlementOutcome={settlementOutcome}
        />
      </div>
    </div>
  );
};

export default Calpoker;
