import { Button } from '@/src/components/button';

interface GameBottomBarProps {
  buttonText: string;
  isDisabled: boolean;
  doHandleMakeMove: () => void;
}

const GameBottomBar = ({
  buttonText,
  isDisabled,
  doHandleMakeMove,
}: GameBottomBarProps) => {
  return (
    <div className='flex-shrink-0 flex rounded-lg bg-canvas-bg shadow-md border border-canvas-line p-2 items-center justify-center'>
      <Button
        variant='solid'
        color='primary'
        onClick={doHandleMakeMove}
        disabled={isDisabled}
        className='w-full p-4'
      >
        {buttonText}
      </Button>
    </div>
  );
};

export default GameBottomBar;
