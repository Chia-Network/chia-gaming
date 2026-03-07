import { CalpokerOutcome, OutcomeLogLine } from '../ChiaGaming';

export interface CaliforniapokerProps {
  outcome: CalpokerOutcome | undefined;
  log: OutcomeLogLine[];
  moveNumber: number;
  iStarted: boolean;
  isPlayerTurn: boolean;
  playerNumber: number;
  playerHand: number[];
  opponentHand: number[];
  cardSelections: number[];
  setCardSelections: (n: number[] | ((prev: number[]) => number[])) => void;
  handleMakeMove: () => void;
  myWinOutcome: 'win' | 'lose' | 'tie' | undefined;
  banner: string;
  balanceDisplay: string;
  stopPlaying: () => void;
}
