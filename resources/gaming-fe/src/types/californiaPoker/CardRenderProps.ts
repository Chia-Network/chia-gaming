import { CardValueSuit } from "./CardValueSuit";

interface CardRenderProps {
  card: CardValueSuit;
  onClick: () => void;
  isSelected: boolean;
  isBeingSwapped: boolean;
  cardId: string;
  isInBestHand: boolean | undefined;
};

export type { CardRenderProps };