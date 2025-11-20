import { CardValueSuit } from "../../../types/californiaPoker";
import { HAND_RANKINGS } from "../constants/constants";

function evaluateHand(hand: CardValueSuit[]) {
  const sortedHand = [...hand].sort((a, b) => b.rank - a.rank);
  const suits = sortedHand.map((card) => card.suit);
  const values = sortedHand.map((card) => card.rank);

  const isFlush = suits.every((suit) => suit === suits[0]);

  // Check for regular straight
  let isStraight = values.every(
    (val, i) => i === 0 || val === values[i - 1] - 1,
  );
  let straightHighCard = values[0]; // For regular straights, highest card is first

  // Check for wheel (A-2-3-4-5) - ace low straight
  if (
    !isStraight &&
    values.includes(14) &&
    values.includes(5) &&
    values.includes(4) &&
    values.includes(3) &&
    values.includes(2)
  ) {
    isStraight = true;
    straightHighCard = 5; // In wheel, 5 is the high card
  }

  // Count occurrences of each value
  const valueCounts: Record<number, number> = {};
  values.forEach(
    (val: number) => (valueCounts[val] = (valueCounts[val] || 0) + 1),
  );

  // Organize by count
  const countGroups: Record<number, number[]> = { 4: [], 3: [], 2: [], 1: [] };
  Object.entries(valueCounts).forEach(([value, count]) => {
    countGroups[count].push(parseInt(value));
  });

  // Sort each group by value
  Object.values(countGroups).forEach((group) => group.sort((a, b) => b - a));

  // Determine hand ranking
  if (isStraight && isFlush) {
    return { ...HAND_RANKINGS.STRAIGHT_FLUSH, tiebreakers: [straightHighCard] };
  }

  if (countGroups[4].length > 0) {
    return {
      ...HAND_RANKINGS.FOUR_OF_A_KIND,
      tiebreakers: [...countGroups[4], ...countGroups[1]],
    };
  }

  if (countGroups[3].length > 0 && countGroups[2].length > 0) {
    return {
      ...HAND_RANKINGS.FULL_HOUSE,
      tiebreakers: [...countGroups[3], ...countGroups[2]],
    };
  }

  if (isFlush) {
    return { ...HAND_RANKINGS.FLUSH, tiebreakers: values };
  }

  if (isStraight) {
    return { ...HAND_RANKINGS.STRAIGHT, tiebreakers: [straightHighCard] };
  }

  if (countGroups[3].length > 0) {
    return {
      ...HAND_RANKINGS.THREE_OF_A_KIND,
      tiebreakers: [...countGroups[3], ...countGroups[1]],
    };
  }

  if (countGroups[2].length === 2) {
    return {
      ...HAND_RANKINGS.TWO_PAIR,
      tiebreakers: [...countGroups[2], ...countGroups[1]],
    };
  }

  if (countGroups[2].length === 1) {
    return {
      ...HAND_RANKINGS.ONE_PAIR,
      tiebreakers: [...countGroups[2], ...countGroups[1]],
    };
  }

  return { ...HAND_RANKINGS.HIGH_CARD, tiebreakers: countGroups[1] };
}

export { evaluateHand };