type SuitName = 'Q' |'♠' | '♥' | '♦' | '♣';
interface CardValueSuit {
  rank: number;
  suit: SuitName;
  originalIndex?: number;
  cardId?: number;
}

export type { CardValueSuit, SuitName };