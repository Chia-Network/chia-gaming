import { CardValueSuit } from "../../../../types/californiaPoker";
import evaluateStraightPotential from "./EvaluateStraightPotential";

const scoreKeepCombination = (cards: CardValueSuit[]) => {
  const sortedCards = [...cards].sort((a, b) => b.rank - a.rank);
  const values = sortedCards.map((c) => c.rank);
  const suits = sortedCards.map((c) => c.suit);

  const valueCounts: Record<number, number> = {};
  values.forEach((val) => (valueCounts[val] = (valueCounts[val] || 0) + 1));

  const counts = Object.values(valueCounts).sort((a, b) => b - a);

  let score = 0;

  // Score based on pairs, trips, etc.
  if (counts[0] === 3) score += 1000;
  else if (counts[0] === 2) {
    score += 500;
    if (counts[1] === 2) score += 300;
  }

  // Score based on flush potential
  const suitCounts: Record<string, number> = {};
  suits.forEach(
    (suit: string) => (suitCounts[suit] = (suitCounts[suit] || 0) + 1),
  );
  const maxSuitCount = Math.max(...Object.values(suitCounts));
  if (maxSuitCount === 4) score += 400;
  else if (maxSuitCount === 3) score += 100;

  // Score straight potential
  score += evaluateStraightPotential(values);

  // High card bonus
  score += values.reduce((sum, val, index) => sum + val * (5 - index), 0);

  return score;
};

export default scoreKeepCombination;