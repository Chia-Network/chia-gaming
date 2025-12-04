import { Button } from '@/src/components/button';
import { GAME_STATES } from '../constants/constants';
interface GameBottomBarProps {
  isPlayerTurn: boolean,
  gameState: string,
  buttonText: string,
  moveNumber: number,
  isDisabled: boolean,
  NewGame: () => void,
  doHandleMakeMove: () => void,
  GAME_STATES: typeof GAME_STATES
}

const GameBottomBar = ({
  isPlayerTurn,
  gameState,
  buttonText,
  moveNumber,
  isDisabled,
  NewGame,
  doHandleMakeMove,
  GAME_STATES
}: GameBottomBarProps) => {
  return (
    <div className='flex rounded-lg flex-col lg:flex-row bg-canvas-bg shadow-md border border-canvas-line lg:flex-[0_0_10%]'>

      {/* Top row on mobile: turn + move */}
      <div className='flex w-full lg:flex-1 lg:order-0 order-1 lg:p-0 p-4 items-center justify-between lg:justify-center'>
        <span
          className={`font-bold text-xl ${isPlayerTurn ? 'text-success-text' : 'text-alert-text'}`}
        >
          {isPlayerTurn ? 'Your Turn' : "Opponent's turn"}
        </span>

        <span className='font-bold text-xl text-canvas-solid lg:hidden block'>
          Move {moveNumber}
        </span>
      </div>

      {/* Button section */}
      <div className='flex w-full flex-1 h-full items-center justify-center bg-transparent order-2'>
        {gameState === GAME_STATES.FINAL ? (
          <Button
            variant='solid'
            color='primary'
            onClick={NewGame}
            disabled={!isPlayerTurn && moveNumber !== 0}
            className='h-full w-full p-4 lg:p-0'
          >
            {isPlayerTurn || moveNumber === 0 ? 'Start New Game' : 'Opponent to Start...'}
          </Button>
        ) : (
          <Button
            variant='solid'
            color='primary'
            onClick={doHandleMakeMove}
            disabled={isDisabled && moveNumber !== 0}
            className='h-full w-full p-4 lg:p-0'
          >
            {buttonText}
          </Button>
        )}
      </div>

      {/* Move (desktop only) */}
      <div className='hidden lg:flex flex-1 items-center justify-center p-4 lg:p-0 order-1 lg:order-3'>
        <span className='font-bold text-xl text-canvas-solid'>
          Move {moveNumber}
        </span>
      </div>

    </div>

  );
};

export default GameBottomBar;
