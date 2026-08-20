interface GameBottomBarProps {
  buttonText: string;
  isDisabled: boolean;
  doHandleMakeMove: () => void;
}

const GameBottomBar = ({ buttonText, isDisabled, doHandleMakeMove }: GameBottomBarProps) => {
  return (
    <button
      type="button"
      onClick={doHandleMakeMove}
      disabled={isDisabled}
      className="w-auto px-4 py-2 items-center justify-center rounded-lg font-bold transition-all duration-300 ease-out disabled:opacity-50 hover:cursor-pointer disabled:cursor-not-allowed leading-none bg-primary-solid text-primary-on-primary"
    >
      {buttonText}
    </button>
  );
};

export default GameBottomBar;
