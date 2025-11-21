import { CardValueSuit } from "./CardValueSuit";

interface MovingCardData {
  id: string;
  card: CardValueSuit;
  startX: number;
  startY: number;
  endX: number;
  endY: number;
  width: number;
  height: number;
  direction: string;
};

interface MovingCardProps {
  cardData: MovingCardData;
  showAnimation: boolean;
};

export type { MovingCardProps, MovingCardData };