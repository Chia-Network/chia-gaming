import { BestHandType } from './BestHandType';
import { CardValueSuit } from './CardValueSuit';

interface HandDisplayProps {
  playerNumber: number;
  cards: CardValueSuit[];
  area: string;
  winner: string | null;
  winnerType: string;
  bestHand: BestHandType | undefined;
  onCardClick?: (n: string) => void;
  showSwapAnimation: boolean;
  gameState: string;
  haloCardIds: string[];
  swapHiddenCardIds?: string[];
  onReorder?: (reorderedCards: CardValueSuit[]) => void;
  timeoutBadge?: 'winner' | 'timeout' | 'forfeit' | null;
}

export type { HandDisplayProps };
