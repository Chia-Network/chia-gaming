import React from 'react';
import { Button } from '../../components/button';

import { CalpokerOutcome } from '../../types/ChiaGaming';

import { CaliforniaPoker } from './components';

export interface CalpokerProps {
  outcome: CalpokerOutcome | undefined;
  moveNumber: number;
  iStarted: boolean;
  playerNumber: number;
  playerHand: number[];
  opponentHand: number[];
  cardSelections: number[];
  setCardSelections: (n: number[] | ((prev: number[]) => number[])) => void;
  handleMakeMove: () => void;
  handleCheat: () => void;
  onDisplayComplete: () => void;
}

const Calpoker: React.FC<CalpokerProps> = ({
  outcome,
  moveNumber,
  iStarted,
  playerNumber,
  playerHand,
  opponentHand,
  cardSelections,
  setCardSelections,
  handleMakeMove,
  handleCheat,
  onDisplayComplete,
}) => {
  const myWinOutcome = outcome?.my_win_outcome;

  return (
    <div className='relative flex h-full w-full min-h-0 flex-col'>
      {/* Toolbar row */}
      <div className='flex-shrink-0 flex items-center justify-end gap-2 pb-2'>
        <Button
          onClick={handleCheat}
          color='neutral'
          variant='outline'
          size='sm'
        >
          Cheat
        </Button>
      </div>

      {/* Game area */}
      <div className='flex-1 min-h-0 flex flex-col'>
        <CaliforniaPoker
          playerNumber={playerNumber}
          moveNumber={moveNumber}
          playerHand={playerHand}
          opponentHand={opponentHand}
          cardSelections={cardSelections}
          setCardSelections={setCardSelections}
          handleMakeMove={handleMakeMove}
          iStarted={iStarted}
          outcome={outcome}
          myWinOutcome={myWinOutcome}
          onDisplayComplete={onDisplayComplete}
        />
      </div>
    </div>
  );
};

export default Calpoker;
