import {
  cardIdToRankSuit,
  handValueToDescription,
} from '../../types/ChiaGaming';

describe('Calpoker bigint domain helpers', () => {
  it('accepts bigint card ids at display boundaries', () => {
    expect(cardIdToRankSuit(51n)).toEqual({ rank: 14, suit: 4 });
  });

  it('describes bigint hand values', () => {
    const desc = handValueToDescription([2n, 1n, 1n, 1n, 14n, 13n, 12n, 11n], [0n]);
    expect(desc).toEqual({
      name: 'Pair',
      values: [14n, 13n, 12n, 11n],
    });
  });
});
