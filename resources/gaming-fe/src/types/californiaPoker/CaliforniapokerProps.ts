import { CalpokerOutcome, OutcomeLogLine } from "../ChiaGaming";

export interface CaliforniapokerProps {
 
  moveNumber: number;
  iStarted: boolean;
  isPlayerTurn: boolean;
  playerNumber: number;
  playerHand: number[][];
  opponentHand: number[][];
  cardSelections: number;
  setCardSelections: (n: number) => void;
  handleMakeMove: (hex: string) => void;
}