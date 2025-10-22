import { BestHandType } from "./BestHandType";
import { CardValueSuit } from "./CardValueSuit";
import { FormatHandProps } from "./FormatHandProps";

interface HandDisplayProps {
  title: string;
  cards: CardValueSuit[];
  area: string;
  winner: string | null;
  winnerType: string;
  bestHand: BestHandType | undefined;
  onCardClick?: (n: number) => void;
  selectedCards: number[];
  swappingCards: CardValueSuit[];
  showSwapAnimation: boolean;
  gameState: string;
  formatHandDescription: (f: FormatHandProps) => string;
};

export type { HandDisplayProps };