import React, { useEffect, useState } from 'react';
import { Button } from '../../components/button';

import { CalpokerOutcome, BlockchainInboundAddressResult } from '../../types/ChiaGaming';

import { Info, X } from 'lucide-react';
import { Alert } from '../../components/ui/alert';
import { cn } from '../../lib/utils';
import { CaliforniaPoker } from './components';

export interface CalpokerProps {
  outcome: CalpokerOutcome | undefined;
  ourShare: number | undefined;
  theirShare: number | undefined;
  moveNumber: number;
  iStarted: boolean;
  isPlayerTurn: boolean;
  playerNumber: number;
  playerHand: number[];
  opponentHand: number[];
  cardSelections: number[];
  setCardSelections: (n: number[] | ((prev: number[]) => number[])) => void;
  handleMakeMove: () => void;
  handleCheat: () => void;
  addressData: BlockchainInboundAddressResult | undefined;
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
  handleCheat,
  addressData,
}) => {
  const myWinOutcome = outcome?.my_win_outcome;

  const moveDescription = [
    'Commit to random number',
    'Choose 4 cards to discard',
    'Finish game',
  ][moveNumber];

  const [showMoveToast, setShowMoveToast] = useState(false);

  useEffect(() => {
    setShowMoveToast(true);
  }, [moveNumber]);

  const handleHelpClick = () => {
    setShowMoveToast(false);
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

  const iAmAlice = playerNumber === 1;
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

  return (
    <div className='relative flex h-full w-full flex-col'>
      {/* Toolbar row */}
      <div className='flex items-center justify-end gap-2 pb-2'>
        <Button
          onClick={handleHelpClick}
          color='neutral'
          variant='outline'
          size='sm'
          leadingIcon={<Info size='20px' />}
        >
          Hint
        </Button>
        <Button
          onClick={handleCheat}
          color='neutral'
          variant='outline'
          size='sm'
          disabled={!isPlayerTurn}
        >
          Cheat
        </Button>
      </div>

      {/* Game area */}
      <div className='flex-1 overflow-auto'>
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
          myWinOutcome={myWinOutcome}
          banner={banner}
          balanceDisplay={balanceDisplay}
        />
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
            aria-label='close'
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
