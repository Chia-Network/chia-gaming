type SuitName = '♠' | '♥' | '♦' | '♣';
interface CardValueSuit {
  rank: number;
  suit: SuitName;
  originalIndex?: number;
}

export type { CardValueSuit, SuitName };