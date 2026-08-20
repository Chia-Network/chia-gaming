import { CardValueSuit } from './CardValueSuit';

interface CardRenderProps {
  id: string;
  card: CardValueSuit;
  onClick: () => void;
  isBeingSwapped: boolean;
  hideForSwap?: boolean;
  cardId: string;
  isInBestHand: boolean | undefined;
  isFinal: boolean;
  hasHalo: boolean;
  showDragOutline?: boolean;
  area: string;
}

export type { CardRenderProps };
