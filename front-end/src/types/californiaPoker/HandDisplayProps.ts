import { BestHandType } from "./BestHandType";
import { CardValueSuit } from "./CardValueSuit";
import { FormatHandProps } from "./FormatHandProps";

interface HandDisplayProps {
  title: string;
  playerNumber: number;
  cards: CardValueSuit[];
  area: string;
  winner: string | null;
  winnerType: string;
  bestHand: BestHandType | undefined;
  onCardClick?: (n: number) => void;
  selectedCards: number[];
  showSwapAnimation: boolean;
  gameState: string;
  haloCardIds: number[];
  swapHiddenCardIds?: number[];
  onReorder?: (reorderedCards: CardValueSuit[]) => void;
  formatHandDescription: (f: FormatHandProps) => string;
};

export type { HandDisplayProps };
