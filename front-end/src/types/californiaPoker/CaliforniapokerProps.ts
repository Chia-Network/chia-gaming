import { CalpokerOutcome } from '../ChiaGaming';

export interface CaliforniapokerProps {
  outcome: CalpokerOutcome | undefined;
  moveNumber: number;
  playerNumber: number;
  playerHand: number[];
  opponentHand: number[];
  cardSelections: number[];
  setCardSelections: (n: number[] | ((prev: number[]) => number[])) => void;
  handleMakeMove: () => void;
  myWinOutcome: 'win' | 'lose' | 'tie' | undefined;
  onDisplayComplete: () => void;
  onGameLog: (lines: string[]) => void;
  myName?: string;
  opponentName?: string;
}
