import { Button } from '@/src/components/button';

interface GameBottomBarProps {
  isPlayerTurn: boolean,
  buttonText: string,
  moveNumber: number,
  isDisabled: boolean,
  doHandleMakeMove: () => void,
}

const GameBottomBar = ({
  isPlayerTurn,
  buttonText,
  moveNumber,
  isDisabled,
  doHandleMakeMove,
}: GameBottomBarProps) => {
  return (
    <div className='flex rounded-lg flex-col lg:flex-row bg-canvas-bg shadow-md border border-canvas-line lg:flex-[0_0_10%]'>

      <div className='flex w-full lg:flex-1 lg:order-0 order-1 lg:p-0 p-4 flex-col gap-0.5 lg:gap-1 items-center justify-center'>
        <div className='flex w-full items-center justify-between lg:justify-center'>
          <span
            className={`font-bold text-xl ${isPlayerTurn ? 'text-success-text' : 'text-alert-text'}`}
          >
            {isPlayerTurn ? 'Your Turn' : "Opponent's turn"}
          </span>
          <span className='font-bold text-xl text-canvas-solid lg:hidden block'>
            Move {moveNumber}
          </span>
        </div>
      </div>

      {/* Button section */}
      <div className='flex shadow-lg w-full flex-1 h-full items-center justify-center bg-transparent order-2'>
        <Button
          variant='solid'
          color='primary'
          onClick={doHandleMakeMove}
          disabled={isDisabled}
          className='h-full w-full p-4 lg:p-0'
        >
          {buttonText}
        </Button>
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
