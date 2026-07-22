export interface OutcomeHandType {
  name: string;
  values: bigint[];
}

export function cardIdToRankSuit(cardId: bigint | number): { rank: number; suit: number } {
  const id = typeof cardId === 'bigint' ? Number(cardId) : cardId;
  const rank = Math.floor(id / 4) + 2;
  const suit = (id % 4) + 1;
  return { rank, suit };
}

function aget<T>(handValue: T[], choice: number, def: T): T {
  if (choice > handValue.length || choice < 0) {
    return def;
  }

  return handValue[choice];
}

function rget<T>(array: T[], start: number, end: number, def: T): T[] {
  const result = [];
  for (let i = start; i < end; i++) {
    result.push(aget(array, i, def));
  }

  return result;
}

export function handValueToDescription(
  handValue: bigint[],
  myCards: bigint[],
): OutcomeHandType {
  const handType = rget(handValue, 0, 3, 0n);

  // Hand encoding from onehandcalc.clinc:
  //   straight flush: (5 high_card)
  //   4 of a kind:    (4 1 quad_rank kicker)
  //   full house:     (3 2 set_rank pair_rank)
  //   flush:          (3 1 3 high_card k1 k2 k3 k4)
  //   straight:       (3 1 2 high_card)
  //   set:            (3 1 1 set_rank k1 k2)
  //   two pair:       (2 2 1 high_pair low_pair kicker)
  //   pair:           (2 1 1 1 pair_rank k1 k2 k3)
  //   high card:      (1 1 1 1 1 high k1 k2 k3 k4)

  switch (handType.toString()) {
    case '3,1,3':
      return {
        name: 'Flush',
        values: rget(handValue, 3, 8, 0n),
      };

    case '3,1,2':
      return {
        name: 'Straight',
        values: [aget(handValue, 3, 0n)],
      };

    case '3,1,1':
      return {
        name: 'Three of a kind',
        values: rget(handValue, 3, 6, 0n),
      };

    case '2,2,1':
      return {
        name: 'Two Pair',
        values: rget(handValue, 3, 6, 0n),
      };

    case '2,1,1':
      return {
        name: 'Pair',
        values: rget(handValue, 4, 8, 0n),
      };
  }

  handType.pop();

  switch (handType.toString()) {
    case '4,1':
      return {
        name: 'Four of a kind',
        values: rget(handValue, 2, 4, 0n),
      };

    case '3,2':
      return {
        name: 'Full house',
        values: rget(handValue, 2, 4, 0n),
      };
  }

  if (handType[0] === 5n) {
    return {
      name: 'Straight flush',
      values: [aget(handValue, 1, 0n)],
    };
  }

  return {
    name: 'High card',
    values: rget(handValue, 5, 10, 0n),
  };
}
