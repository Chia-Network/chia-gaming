export interface CalpokerOutcomeView {
  my_win_outcome: 'win' | 'lose' | 'tie';
  my_cards: string[];
  their_cards: string[];
  my_final_hand: string[];
  their_final_hand: string[];
  my_used_cards: string[];
  their_used_cards: string[];
  my_hand_value: string[];
  their_hand_value: string[];
}

export interface CalpokerDisplaySnapshotView {
  gameState: string;
  winner: string | null;
  playerBestHandCardIds: string[];
  opponentBestHandCardIds: string[];
  playerHaloCardIds: string[];
  opponentHaloCardIds: string[];
  playerDisplayText: string;
  opponentDisplayText: string;
}

export interface CaliforniapokerProps {
  outcome: CalpokerOutcomeView | undefined;
  moveNumber: string;
  playerNumber: number;
  playerHand: string[];
  opponentHand: string[];
  cardSelections: string[];
  setCardSelections: (n: string[] | ((prev: string[]) => string[])) => void;
  setHandOrder: (playerHand: string[], opponentHand?: string[]) => void;
  handleMakeMove: () => void;
  myWinOutcome: 'win' | 'lose' | 'tie' | undefined;
  onGameLog: (lines: string[]) => void;
  onSnapshotChange: (snapshot: CalpokerDisplaySnapshotView) => void;
  initialSnapshot?: CalpokerDisplaySnapshotView;
  myName?: string;
  opponentName?: string;
  settlementOutcome?: import('../../lib/settlement').SettlementOutcome | null;
}
