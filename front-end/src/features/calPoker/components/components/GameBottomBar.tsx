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
    <Button
      variant='solid'
      color='primary'
      onClick={doHandleMakeMove}
      disabled={isDisabled}
      className='w-auto px-4 py-2'
    >
      {buttonText}
    </Button>
  );
};

export default GameBottomBar;
