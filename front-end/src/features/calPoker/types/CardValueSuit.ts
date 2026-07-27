type SuitName = 'Q' |'♠' | '♥' | '♦' | '♣';
interface CardValueSuit {
  rank: number;
  suit: SuitName;
  cardId?: string;
}

export type { CardValueSuit, SuitName };