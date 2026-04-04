import React, { useEffect, useRef } from 'react';

import { CalpokerOutcome } from '../../types/ChiaGaming';
import { CalpokerDisplaySnapshot } from '../../hooks/save';

import { CaliforniaPoker } from './components';

export interface CalpokerProps {
  outcome: CalpokerOutcome | undefined;
  moveNumber: number;
  playerNumber: number;
  playerHand: number[];
  opponentHand: number[];
  cardSelections: number[];
  setCardSelections: (n: number[] | ((prev: number[]) => number[])) => void;
  handleMakeMove: () => void;
  handleCheat: () => void;
  onDisplayComplete: () => void;
  onGameLog: (lines: string[]) => void;
  onSnapshotChange: (snapshot: CalpokerDisplaySnapshot) => void;
  initialSnapshot?: CalpokerDisplaySnapshot;
  myName?: string;
  opponentName?: string;
  onPlayAgain?: () => void;
  onEndSession?: () => void;
  showBetweenHandActions?: boolean;
}

const Calpoker: React.FC<CalpokerProps> = ({
  outcome,
  moveNumber,
  playerNumber,
  playerHand,
  opponentHand,
  cardSelections,
  setCardSelections,
  handleMakeMove,
  handleCheat,
  onDisplayComplete,
  onGameLog,
  onSnapshotChange,
  initialSnapshot,
  myName,
  opponentName,
  onPlayAgain,
  onEndSession,
  showBetweenHandActions,
}) => {
  const myWinOutcome = outcome?.my_win_outcome;

  const cheatBufRef = useRef('');
  useEffect(() => {
    const SEQUENCE = 'cheat^';
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key.length !== 1) return;
      const buf = cheatBufRef.current + e.key;
      if (SEQUENCE.startsWith(buf)) {
        cheatBufRef.current = buf;
        if (buf === SEQUENCE) {
          cheatBufRef.current = '';
          handleCheat();
        }
      } else {
        cheatBufRef.current = SEQUENCE.startsWith(e.key) ? e.key : '';
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleCheat]);

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
          handleMakeMove={handleMakeMove}
          outcome={outcome}
          myWinOutcome={myWinOutcome}
          onDisplayComplete={onDisplayComplete}
          onGameLog={onGameLog}
          onSnapshotChange={onSnapshotChange}
          initialSnapshot={initialSnapshot}
          myName={myName}
          opponentName={opponentName}
          onPlayAgain={onPlayAgain}
          onEndSession={onEndSession}
          showBetweenHandActions={showBetweenHandActions}
        />
      </div>
    </div>
  );
};

export default Calpoker;
