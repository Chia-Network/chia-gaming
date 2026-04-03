type SuitName = 'Q' |'♠' | '♥' | '♦' | '♣';
interface CardValueSuit {
  rank: number;
  suit: SuitName;
  cardId?: number;
}

export type { CardValueSuit, SuitName };