import { CardValueSuit } from "../../../types/californiaPoker";

function sortHand(hand: CardValueSuit[]): CardValueSuit[] {
  return [...hand].sort((a, b) => {
    if (a.rank !== b.rank) return b.rank - a.rank;
    const suitOrder = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 };
    return suitOrder[a.suit] - suitOrder[b.suit];
  });
}

export default sortHand;