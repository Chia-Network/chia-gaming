interface BramCard {
    suit: string;
    rank: string;
    value: number;
}

const SUITS = ['♠', '♥', '♦', '♣'];
const RANKS = ['2', '3', '4', '5', '6', '7', '8', '9', 'T', 'J', 'Q', 'K', 'A'];

const HAND_RANKINGS = {
  STRAIGHT_FLUSH: { score: 8, name: 'Straight Flush' },
  FOUR_OF_A_KIND: { score: 7, name: 'Four of a Kind' },
  FULL_HOUSE: { score: 6, name: 'Full House' },
  FLUSH: { score: 5, name: 'Flush' },
  STRAIGHT: { score: 4, name: 'Straight' },
  THREE_OF_A_KIND: { score: 3, name: 'Three of a Kind' },
  TWO_PAIR: { score: 2, name: 'Two Pair' },
  ONE_PAIR: { score: 1, name: 'One Pair' },
  HIGH_CARD: { score: 0, name: 'High Card' }
};

// hand is Array of { suit, rank, value: getRankValue(rank) }
// value is a umber from 14...down, starting from Ace.

// Utility functions
const getRankValue = (rank: string) => {
  const rankValues: Record<string, number> = { 'A': 14, 'K': 13, 'Q': 12, 'J': 11, 'T': 10 };
  return rankValues[rank] || parseInt(rank);
};

// const valueToDisplayName = (value) => {
//   const displayNames = { 14: 'Ace', 13: 'King', 12: 'Queen', 11: 'Jack', 10: 'Ten' };
//   return displayNames[value] || value.toString();
// };

// const shuffleArray = (array) => {
//   const newArray = [...array];
//   for (let i = newArray.length - 1; i > 0; i--) {
//     const j = Math.floor(Math.random() * (i + 1));
//     [newArray[i], newArray[j]] = [newArray[j], newArray[i]];
//   }
//   return newArray;
// };

// const sortHand = (hand) => {
//   return [...hand].sort((a, b) => {
//     if (a.value !== b.value) return b.value - a.value;
//     const suitOrder = { '♠': 0, '♥': 1, '♦': 2, '♣': 3 };
//     return suitOrder[a.suit] - suitOrder[b.suit];
//   });
// };

// const createDeck = () => {
//   const deck = [];
//   SUITS.forEach(suit => {
//     RANKS.forEach(rank => {
//       deck.push({ suit, rank, value: getRankValue(rank) });
//     });
//   });
//   return deck;
// };

// // Generate all possible 5-card combinations from 8 cards
// const getCombinations = (cards, size = 5) => {
//   const combinations = [];

//   // Use the same nested loop approach as the original to ensure no bias
//   if (size === 5) {
//     for (let i = 0; i < cards.length - 4; i++) {
//       for (let j = i + 1; j < cards.length - 3; j++) {
//         for (let k = j + 1; k < cards.length - 2; k++) {
//           for (let l = k + 1; l < cards.length - 1; l++) {
//             for (let m = l + 1; m < cards.length; m++) {
//               combinations.push([cards[i], cards[j], cards[k], cards[l], cards[m]]);
//             }
//           }
//         }
//       }
//     }
//   }

//   return combinations;
// };

// // Generate all 4-card swap combinations
// const getSwapCombinations = (handSize = 8) => {
//   const combinations = [];

//   for (let i = 0; i < handSize - 3; i++) {
//     for (let j = i + 1; j < handSize - 2; j++) {
//       for (let k = j + 1; k < handSize - 1; k++) {
//         for (let l = k + 1; l < handSize; l++) {
//           combinations.push([i, j, k, l]);
//         }
//       }
//     }
//   }

//   return combinations;
// };

const convert_card = (card_rank_suit: number[]) => {
    const bram_rank = RANKS[card_rank_suit[1]];
    const bram_suit = SUITS[card_rank_suit[0]];
    return {rank: bram_rank, suit: bram_suit, value: getRankValue(bram_rank)};
}

const convert_hand = (hand: number[][]) => {
    return hand.map(convert_card);
}

export const evaluateHand = (cg_hand: number[][]) => {

  const hand = convert_hand(cg_hand);
  const sortedHand = [...hand].sort((a, b) => b.value - a.value);
  const suits = sortedHand.map(card => card.suit);
  const values = sortedHand.map(card => card.value);

  const isFlush = suits.every(suit => suit === suits[0]);

  // Check for regular straight
  let isStraight = values.every((val, i) => i === 0 || val === values[i-1] - 1);
  let straightHighCard = values[0]; // For regular straights, highest card is first

  // Check for wheel (A-2-3-4-5) - ace low straight
  if (!isStraight && values.includes(14) && values.includes(5) &&
      values.includes(4) && values.includes(3) && values.includes(2)) {
    isStraight = true;
    straightHighCard = 5; // In wheel, 5 is the high card
  }

  // Count occurrences of each value
  const valueCounts: Record<number, number> = {};
  values.forEach(val => valueCounts[val] = (valueCounts[val] || 0) + 1);

  // Organize by count
  const countGroups: Record<number, Array<number>> = { 4: [], 3: [], 2: [], 1: [] };
  Object.entries(valueCounts).forEach(([value, count]) => {
    countGroups[count].push(parseInt(value));
  });

  // Sort each group by value
  Object.values(countGroups).forEach(group => group.sort((a, b) => b - a));

  // Determine hand ranking
  if (isStraight && isFlush) {
    return { ...HAND_RANKINGS.STRAIGHT_FLUSH, tiebreakers: [straightHighCard] };
  }

  if (countGroups[4].length > 0) {
    return {
      ...HAND_RANKINGS.FOUR_OF_A_KIND,
      tiebreakers: [...countGroups[4], ...countGroups[1]]
    };
  }

  if (countGroups[3].length > 0 && countGroups[2].length > 0) {
    return {
      ...HAND_RANKINGS.FULL_HOUSE,
      tiebreakers: [...countGroups[3], ...countGroups[2]]
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
      tiebreakers: [...countGroups[3], ...countGroups[1]]
    };
  }

  if (countGroups[2].length === 2) {
    return {
      ...HAND_RANKINGS.TWO_PAIR,
      tiebreakers: [...countGroups[2], ...countGroups[1]]
    };
  }

  if (countGroups[2].length === 1) {
    return {
      ...HAND_RANKINGS.ONE_PAIR,
      tiebreakers: [...countGroups[2], ...countGroups[1]]
    };
  }

  return { ...HAND_RANKINGS.HIGH_CARD, tiebreakers: countGroups[1] };
};

export default evaluateHand;