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
      <div className='flex flex-1 p-4 lg:p-0 items-center justify-center'>
        <span
          className={`font-bold text-xl ${isPlayerTurn ? 'text-success-text' : 'text-alert-text'
            }`}
        >
          {isPlayerTurn ? 'Your Turn' : "Opponent's turn"}
        </span>
      </div>

      <div className='flex w-full flex-1 h-full items-center justify-center bg-transparent'>
        {gameState === GAME_STATES.FINAL ? (
          <Button
            variant='solid'
            color='primary'
            onClick={NewGame}
            // allow both players to start if it's the first move
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
            disabled={isDisabled && moveNumber !== 0} // allow move 0
            className='h-full w-full p-4 lg:p-0'
          >
            {buttonText}
          </Button>
        )}

      </div>

      <div className='flex flex-1 items-center justify-center p-4 lg:p-0'>
        <span className='font-bold text-xl text-canvas-solid'>
          Move {moveNumber}
        </span>
      </div>
    </div>
  );
};

export default GameBottomBar;
