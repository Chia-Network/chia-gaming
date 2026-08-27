import { useCallback, useEffect, useState } from 'react';
import { SpHandler } from './useSpacepokerHand';

interface SpacePokerActionControlsProps {
  interactive: boolean;
  handler: SpHandler;
  myTurn: boolean;
  round: string;
  coinTossIOpen: boolean | null;
  lastRaiseUnits: string;
  maxRaiseUnits: string;
  forcedAuto: boolean;
  formatBet: (units: bigint) => string;
  handleCheck: () => void;
  handleRaise: (units: bigint) => void;
  handleCall: () => void;
  handleFold: () => void;
}

export function SpacePokerActionControls({
  interactive,
  handler,
  myTurn,
  round,
  coinTossIOpen,
  lastRaiseUnits,
  maxRaiseUnits,
  forcedAuto,
  formatBet,
  handleCheck,
  handleRaise,
  handleCall,
  handleFold,
}: SpacePokerActionControlsProps) {
  const [raiseAmount, setRaiseAmount] = useState(1);
  const inBetting = handler === SpHandler.BeginRound || handler === SpHandler.MidRound;
  const maxRaiseInput = Math.max(1, Number(maxRaiseUnits));
  const raiseAmountInput = Math.min(raiseAmount, maxRaiseInput);
  const isBeginRound = handler === SpHandler.BeginRound;
  const autoPong = isBeginRound && round === '4' && coinTossIOpen === false;
  const actionsEnabled = interactive && myTurn && inBetting && !autoPong && !forcedAuto;
  const checkCallLabel =
    handler === SpHandler.MidRound && lastRaiseUnits !== '0' ? 'Call' : 'Check';

  useEffect(() => {
    if (!actionsEnabled) {
      setRaiseAmount(1);
    }
  }, [actionsEnabled]);

  const doRaise = useCallback(() => {
    if (!actionsEnabled || raiseAmountInput < 1 || raiseAmountInput > Number(maxRaiseUnits)) return;
    handleRaise(BigInt(raiseAmountInput));
  }, [actionsEnabled, raiseAmountInput, maxRaiseUnits, handleRaise]);

  const btnClass =
    'px-3 py-1.5 rounded bg-primary-solid text-primary-on-primary text-sm font-medium hover:bg-primary-solid-hover disabled:opacity-40';

  return (
    <div className="flex flex-wrap items-center justify-center gap-2">
      {isBeginRound ? (
        <button onClick={handleCheck} disabled={!actionsEnabled} className={`${btnClass} w-16`}>
          Check
        </button>
      ) : (
        <button onClick={handleCall} disabled={!actionsEnabled} className={`${btnClass} w-16`}>
          {checkCallLabel}
        </button>
      )}
      <div className="flex items-center gap-1">
        <button
          onClick={doRaise}
          disabled={!actionsEnabled || Number(maxRaiseUnits) < 1}
          className={btnClass}
        >
          Raise
        </button>
        <input
          type="range"
          min={1}
          max={maxRaiseInput}
          value={raiseAmountInput}
          onChange={(event) => setRaiseAmount(Number(event.target.value))}
          disabled={!actionsEnabled}
          className="w-20 sm:w-32 disabled:opacity-40"
        />
        <span className="text-xs text-canvas-text-contrast w-16 text-center">
          {formatBet(BigInt(raiseAmountInput))}
        </span>
      </div>
      <button onClick={handleFold} disabled={!actionsEnabled || isBeginRound} className={btnClass}>
        Fold
      </button>
    </div>
  );
}
