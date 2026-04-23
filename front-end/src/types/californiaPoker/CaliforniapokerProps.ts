import { CalpokerOutcome } from '../ChiaGaming';
import { CalpokerDisplaySnapshot } from '../../hooks/save';

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
  onGameLog: (lines: string[]) => void;
  onSnapshotChange: (snapshot: CalpokerDisplaySnapshot) => void;
  initialSnapshot?: CalpokerDisplaySnapshot;
  myName?: string;
  opponentName?: string;
}
