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
  onCardClick?: (n: string) => void;
  selectedCards: string[];
  showSwapAnimation: boolean;
  gameState: string;
  haloCardIds: string[];
  swapHiddenCardIds?: string[];
  onReorder?: (reorderedCards: CardValueSuit[]) => void;
  formatHandDescription: (f: FormatHandProps) => string;
  timeoutBadge?: 'winner' | 'timeout' | null;
};

export type { HandDisplayProps };
