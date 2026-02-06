import { CardValueSuit } from "../../../../types/californiaPoker";
import { SuitName } from "../../../../types/californiaPoker/CardValueSuit";

function sortHand(hand: CardValueSuit[]): CardValueSuit[] {
  return [...hand].sort((a, b) => {
  if (a.rank !== b.rank) return b.rank - a.rank;
  const suitOrder: Record<SuitName, number> = {
    'Q': 0,  // Treat 'Q' as a special type (e.g., Joker, Queen marker, etc.)
    '♠': 1,
    '♥': 2,
    '♦': 3,
    '♣': 4,
  };
  const getSuitValue = (suit: SuitName) =>
    suitOrder[suit as '♠' | '♥' | '♦' | '♣'] ?? 0;
  return getSuitValue(a.suit) - getSuitValue(b.suit);
});

}

export default sortHand;