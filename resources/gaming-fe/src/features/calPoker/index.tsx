import React, { useEffect, useState } from 'react';
import { Button } from '../../components/button';

import { CalpokerOutcome, OutcomeLogLine } from '../../types/ChiaGaming';
import GameLog from '../../components/GameLog';
import CaliforniaPoker from '../californiaPoker';
import { Info, LogOut, X } from 'lucide-react';
import { Alert } from '../../components/ui/alert';
import { cn } from '../../lib/utils';

export interface CalpokerProps {
  outcome: CalpokerOutcome | undefined;
  ourShare: number | undefined;
  theirShare: number | undefined;
  moveNumber: number;
  iStarted: boolean;
  isPlayerTurn: boolean;
  playerNumber: number;
  playerHand: number[][];
  opponentHand: number[][];
  cardSelections: number;
  setCardSelections: (n: number) => void;
  handleMakeMove: (hex: string) => void;
  stopPlaying: () => void;
  addressData: any;
  log: OutcomeLogLine[];
}

const Calpoker: React.FC<CalpokerProps> = ({
  outcome,
  ourShare,
  theirShare,
  moveNumber,
  iStarted,
  isPlayerTurn,
  playerNumber,
  playerHand,
  opponentHand,
  cardSelections,
  setCardSelections,
  handleMakeMove,
  stopPlaying,
  addressData,
  log,
}) => {
  const myWinOutcome = outcome?.my_win_outcome;

  const iAmAlice = playerNumber === 2;
  const myHandValue = iAmAlice
    ? outcome?.alice_hand_value
    : outcome?.bob_hand_value;
  let banner = isPlayerTurn ? 'Your turn' : "Opponent's turn";
  if (myWinOutcome === 'win') {
    banner = `You win ${myHandValue}`;
  } else if (myWinOutcome === 'lose') {
    banner = `You lose ${myHandValue}`;
  } else if (myWinOutcome === 'tie') {
    banner = `Game tied ${myHandValue}`;
  }
  const moveDescription = [
    'Commit to random number',
    'Choose 4 cards to discard',
    'Finish game',
  ][moveNumber];

  // Toast (Snackbar) state for move description
  const [showMoveToast, setShowMoveToast] = useState(false);

  useEffect(() => {
    // show toast on mount or when moveNumber changes
    setShowMoveToast(true);
  }, [moveNumber]);

  const handleHelpClick = () => {
    // Re-trigger the toast so it animates again from the top
    setShowMoveToast(false);
    // small timeout to allow exit animation before re-opening
    setTimeout(() => setShowMoveToast(true), 120);
  };

  useEffect(() => {
    if (!showMoveToast) return;

    const timer = setTimeout(() => setShowMoveToast(false), 4500);
    return () => clearTimeout(timer);
  }, [showMoveToast, moveNumber]);

  const handleCloseMoveToast = () => {
    setShowMoveToast(false);
  };

  const balanceDisplay =
    ourShare !== undefined && theirShare !== undefined
      ? ` - Our Share ${ourShare} vs ${theirShare}`
      : '';

  return (
    <div
      className='relative gap-4 flex min-h-screen w-full flex-col justify-center items-center bg-canvas-bg-subtle px-4 text-canvas-text sm:px-6 md:px-8'
    >
      {/* Header */}
      <div className='flex w-full flex-col items-center pt-4 justify-between gap-4 sm:flex-row sm:gap-6'>
        <h1 className='w-full text-3xl font-bold text-canvas-text-contrast sm:text-left sm:text-4xl'>
          California Poker
        </h1>

        <div className='flex w-full items-center gap-2 flex-row justify-end'>
          {/* HINT button */}
          <Button
            onClick={handleHelpClick}
            color={'neutral'}
            variant={'outline'}
            size={'sm'}
            leadingIcon={<Info size={'20px'} />}
          >
            Hint
          </Button>

          {/* Leave */}
          <Button
            data-testid='stop-playing'
            variant={'destructive'}
            color={'outline'}
            onClick={stopPlaying}
            size={'sm'}
            disabled={moveNumber !== 0}
            leadingIcon={<LogOut />}
          >
            End Session
          </Button>
        </div>
      </div>

      {/* Main Game Layout */}
      <div className='flex w-full justify-center overflow-visible lg:h-[calc(100vh-100px)]'>
        <div className='flex w-full flex-col gap-2 overflow-hidden lg:h-full lg:min-h-0 lg:flex-row'>
          {/* MAIN GAME AREA */}
          <div className='flex-1 overflow-auto lg:flex-[18_1_0%] lg:min-h-0'>
            <CaliforniaPoker
              playerNumber={playerNumber}
              isPlayerTurn={isPlayerTurn}
              moveNumber={moveNumber}
              playerHand={playerHand}
              opponentHand={opponentHand}
              cardSelections={cardSelections}
              setCardSelections={setCardSelections}
              handleMakeMove={handleMakeMove}
              iStarted={iStarted}
              outcome={outcome}
              log={log}
              myWinOutcome={myWinOutcome}
              banner={banner}
              balanceDisplay={balanceDisplay}
            />
          </div>

          {/* GAME LOG */}
          <div className='bg-canvas-bg lg:flex-[7_1_0%] lg:min-h-0 lg:overflow-y-auto'>
            <div className='h-full'>
              <GameLog log={log} />
            </div>
          </div>
        </div>
      </div>

      {/* Move Description Toast */}
      <div
        className={cn(
          'pointer-events-none fixed top-6 left-1/2 -translate-x-1/2 z-50 flex justify-center px-4 transition-all duration-300 ease-out',
          showMoveToast
            ? 'pointer-events-auto translate-y-0 opacity-100'
            : '-translate-y-4 opacity-0'
        )}
      >
        <Alert className='flex items-center gap-3 rounded-2xl border border-canvas-line bg-canvas-bg-subtle px-5 py-3 font-semibold text-canvas-text-contrast shadow-lg'>
          <span>{moveDescription}</span>
          <button
            type='button'
            aria-label='close move description'
            className='ml-2 rounded-full p-1 text-canvas-text transition hover:bg-canvas-bg'
            onClick={handleCloseMoveToast}
          >
            <X className='h-4 w-4' />
          </button>
        </Alert>
      </div>


      {/* Hidden blockchain address */}
      <div
        id='blockchain-address'
        className='absolute h-0 w-0 opacity-0'
      >
        {JSON.stringify(addressData)}
      </div>
    </div>
  );
};

export default Calpoker;
