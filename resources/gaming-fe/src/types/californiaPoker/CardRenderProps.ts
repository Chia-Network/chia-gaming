import { CardValueSuit } from './CardValueSuit';

interface CardRenderProps {
  id: string;
  index: number;
  card: CardValueSuit;
  onClick: () => void;
  isSelected: boolean;
  isBeingSwapped: boolean;
  cardId: string;
  isInBestHand: boolean | undefined;
  area: string;
}

export type { CardRenderProps };
