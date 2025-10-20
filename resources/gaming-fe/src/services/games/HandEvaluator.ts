interface Card {
  suit: "hearts" | "diamonds" | "clubs" | "spades";
  rank:
    | "2"
    | "3"
    | "4"
    | "5"
    | "6"
    | "7"
    | "8"
    | "9"
    | "10"
    | "J"
    | "Q"
    | "K"
    | "A";
  isWild?: boolean;
}

interface HandRank {
  rank: number;
  name: string;
  highCard?: Card;
  kickers?: Card[];
}

export class HandEvaluator {
  private static readonly RANK_VALUES: { [key: string]: number } = {
    "2": 2,
    "3": 3,
    "4": 4,
    "5": 5,
    "6": 6,
    "7": 7,
    "8": 8,
    "9": 9,
    "10": 10,
    J: 11,
    Q: 12,
    K: 13,
    A: 14,
  };

  private static readonly HAND_RANKS = {
    HIGH_CARD: 1,
    PAIR: 2,
    TWO_PAIR: 3,
    THREE_OF_A_KIND: 4,
    STRAIGHT: 5,
    FLUSH: 6,
    FULL_HOUSE: 7,
    FOUR_OF_A_KIND: 8,
    STRAIGHT_FLUSH: 9,
    ROYAL_FLUSH: 10,
  };

  public static evaluateHand(
    holeCards: Card[],
    communityCards: Card[],
  ): HandRank {
    const allCards = [...holeCards, ...communityCards];
    const validCards = allCards.filter((card) => !card.isWild);
    const wildCards = allCards.filter((card) => card.isWild);

    const royalFlush = this.checkRoyalFlush(validCards, wildCards);
    if (royalFlush) return royalFlush;

    const straightFlush = this.checkStraightFlush(validCards, wildCards);
    if (straightFlush) return straightFlush;

    const fourOfAKind = this.checkFourOfAKind(validCards, wildCards);
    if (fourOfAKind) return fourOfAKind;

    const fullHouse = this.checkFullHouse(validCards, wildCards);
    if (fullHouse) return fullHouse;

    const flush = this.checkFlush(validCards, wildCards);
    if (flush) return flush;

    const straight = this.checkStraight(validCards, wildCards);
    if (straight) return straight;

    const threeOfAKind = this.checkThreeOfAKind(validCards, wildCards);
    if (threeOfAKind) return threeOfAKind;

    const twoPair = this.checkTwoPair(validCards, wildCards);
    if (twoPair) return twoPair;

    const pair = this.checkPair(validCards, wildCards);
    if (pair) return pair;

    return this.getHighCard(validCards);
  }

  private static checkRoyalFlush(
    cards: Card[],
    wildCards: Card[],
  ): HandRank | null {
    const straightFlush = this.checkStraightFlush(cards, wildCards);
    if (straightFlush && straightFlush.highCard?.rank === "A") {
      return {
        rank: this.HAND_RANKS.ROYAL_FLUSH,
        name: "Royal Flush",
        highCard: straightFlush.highCard,
      };
    }
    return null;
  }

  private static checkStraightFlush(
    cards: Card[],
    wildCards: Card[],
  ): HandRank | null {
    const suits = ["hearts", "diamonds", "clubs", "spades"] as const;

    for (const suit of suits) {
      const suitedCards = cards.filter((card) => card.suit === suit);
      const straight = this.findStraight([...suitedCards, ...wildCards]);

      if (straight) {
        return {
          rank: this.HAND_RANKS.STRAIGHT_FLUSH,
          name: "Straight Flush",
          highCard: straight[straight.length - 1],
        };
      }
    }

    return null;
  }

  private static checkFourOfAKind(
    cards: Card[],
    wildCards: Card[],
  ): HandRank | null {
    const rankGroups = this.groupByRank(cards);
    const wildCount = wildCards.length;

    for (const [rank, group] of Object.entries(rankGroups)) {
      if (group.length + wildCount >= 4) {
        const remainingWilds = wildCount - (4 - group.length);
        const kickers = this.getKickers(cards, [group[0]], remainingWilds);

        return {
          rank: this.HAND_RANKS.FOUR_OF_A_KIND,
          name: "Four of a Kind",
          highCard: group[0],
          kickers,
        };
      }
    }

    return null;
  }

  private static checkFullHouse(
    cards: Card[],
    wildCards: Card[],
  ): HandRank | null {
    const rankGroups = this.groupByRank(cards);
    const wildCount = wildCards.length;
    let threeOfAKind: Card[] | null = null;
    let pair: Card[] | null = null;

    for (const [rank, group] of Object.entries(rankGroups)) {
      if (group.length + wildCount >= 3) {
        threeOfAKind = group;
        break;
      }
    }

    if (threeOfAKind) {
      const remainingWilds = wildCount - (3 - threeOfAKind.length);

      for (const [rank, group] of Object.entries(rankGroups)) {
        if (group !== threeOfAKind && group.length + remainingWilds >= 2) {
          pair = group;
          break;
        }
      }

      if (pair) {
        return {
          rank: this.HAND_RANKS.FULL_HOUSE,
          name: "Full House",
          highCard: threeOfAKind[0],
          kickers: [pair[0]],
        };
      }
    }

    return null;
  }

  private static checkFlush(cards: Card[], wildCards: Card[]): HandRank | null {
    const suits = ["hearts", "diamonds", "clubs", "spades"] as const;

    for (const suit of suits) {
      const suitedCards = cards.filter((card) => card.suit === suit);
      if (suitedCards.length + wildCards.length >= 5) {
        const sortedCards = this.sortByRank(suitedCards);
        return {
          rank: this.HAND_RANKS.FLUSH,
          name: "Flush",
          highCard: sortedCards[0],
          kickers: sortedCards.slice(1, 5),
        };
      }
    }

    return null;
  }

  private static checkStraight(
    cards: Card[],
    wildCards: Card[],
  ): HandRank | null {
    const straight = this.findStraight([...cards, ...wildCards]);
    if (straight) {
      return {
        rank: this.HAND_RANKS.STRAIGHT,
        name: "Straight",
        highCard: straight[straight.length - 1],
      };
    }
    return null;
  }

  private static checkThreeOfAKind(
    cards: Card[],
    wildCards: Card[],
  ): HandRank | null {
    const rankGroups = this.groupByRank(cards);
    const wildCount = wildCards.length;

    for (const [rank, group] of Object.entries(rankGroups)) {
      if (group.length + wildCount >= 3) {
        const remainingWilds = wildCount - (3 - group.length);
        const kickers = this.getKickers(cards, [group[0]], remainingWilds);

        return {
          rank: this.HAND_RANKS.THREE_OF_A_KIND,
          name: "Three of a Kind",
          highCard: group[0],
          kickers,
        };
      }
    }

    return null;
  }

  private static checkTwoPair(
    cards: Card[],
    wildCards: Card[],
  ): HandRank | null {
    const rankGroups = this.groupByRank(cards);
    const wildCount = wildCards.length;
    const pairs: Card[][] = [];

    for (const [rank, group] of Object.entries(rankGroups)) {
      if (group.length + wildCount >= 2) {
        pairs.push(group);
        if (pairs.length === 2) {
          const remainingWilds =
            wildCount - (2 - pairs[0].length) - (2 - pairs[1].length);
          const kickers = this.getKickers(
            cards,
            [pairs[0][0], pairs[1][0]],
            remainingWilds,
          );

          return {
            rank: this.HAND_RANKS.TWO_PAIR,
            name: "Two Pair",
            highCard: pairs[0][0],
            kickers: [pairs[1][0], ...kickers],
          };
        }
      }
    }

    return null;
  }

  private static checkPair(cards: Card[], wildCards: Card[]): HandRank | null {
    const rankGroups = this.groupByRank(cards);
    const wildCount = wildCards.length;

    for (const [rank, group] of Object.entries(rankGroups)) {
      if (group.length + wildCount >= 2) {
        const remainingWilds = wildCount - (2 - group.length);
        const kickers = this.getKickers(cards, [group[0]], remainingWilds);

        return {
          rank: this.HAND_RANKS.PAIR,
          name: "Pair",
          highCard: group[0],
          kickers,
        };
      }
    }

    return null;
  }

  private static getHighCard(cards: Card[]): HandRank {
    const sortedCards = this.sortByRank(cards);
    return {
      rank: this.HAND_RANKS.HIGH_CARD,
      name: "High Card",
      highCard: sortedCards[0],
      kickers: sortedCards.slice(1, 5),
    };
  }

  private static groupByRank(cards: Card[]): { [key: string]: Card[] } {
    const groups: { [key: string]: Card[] } = {};
    for (const card of cards) {
      if (!groups[card.rank]) {
        groups[card.rank] = [];
      }
      groups[card.rank].push(card);
    }
    return groups;
  }

  private static sortByRank(cards: Card[]): Card[] {
    return [...cards].sort(
      (a, b) => this.RANK_VALUES[b.rank] - this.RANK_VALUES[a.rank],
    );
  }

  private static findStraight(cards: Card[]): Card[] | null {
    const sortedCards = this.sortByRank(cards);
    const uniqueRanks = [...new Set(sortedCards.map((card) => card.rank))];
    const rankValues = uniqueRanks
      .map((rank) => this.RANK_VALUES[rank])
      .sort((a, b) => b - a);

    if (rankValues.includes(14) && rankValues.includes(2)) {
      const lowStraight = [14, 5, 4, 3, 2];
      if (lowStraight.every((rank) => rankValues.includes(rank))) {
        return lowStraight.map((rank) => {
          const rankStr = Object.keys(this.RANK_VALUES).find(
            (key) => this.RANK_VALUES[key] === rank,
          )!;
          return sortedCards.find((card) => card.rank === rankStr)!;
        });
      }
    }

    for (let i = 0; i <= rankValues.length - 5; i++) {
      const straight = rankValues.slice(i, i + 5);
      if (straight[0] - straight[4] === 4) {
        return straight.map((rank) => {
          const rankStr = Object.keys(this.RANK_VALUES).find(
            (key) => this.RANK_VALUES[key] === rank,
          )!;
          return sortedCards.find((card) => card.rank === rankStr)!;
        });
      }
    }

    return null;
  }

  private static getKickers(
    cards: Card[],
    excludeCards: Card[],
    wildCount: number,
  ): Card[] {
    const availableCards = cards.filter((card) => !excludeCards.includes(card));
    const sortedCards = this.sortByRank(availableCards);
    return sortedCards.slice(0, 5 - excludeCards.length - wildCount);
  }

  public static compareHands(hand1: HandRank, hand2: HandRank): number {
    if (hand1.rank !== hand2.rank) {
      return hand2.rank - hand1.rank;
    }

    if (hand1.highCard && hand2.highCard) {
      const highCardCompare =
        this.RANK_VALUES[hand2.highCard.rank] -
        this.RANK_VALUES[hand1.highCard.rank];
      if (highCardCompare !== 0) {
        return highCardCompare;
      }
    }

    if (hand1.kickers && hand2.kickers) {
      for (
        let i = 0;
        i < Math.min(hand1.kickers.length, hand2.kickers.length);
        i++
      ) {
        const kickerCompare =
          this.RANK_VALUES[hand2.kickers[i].rank] -
          this.RANK_VALUES[hand1.kickers[i].rank];
        if (kickerCompare !== 0) {
          return kickerCompare;
        }
      }
    }

    return 0;
  }
}
