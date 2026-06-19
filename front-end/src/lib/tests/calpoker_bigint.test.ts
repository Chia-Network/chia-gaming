import {
  cardIdToRankSuit,
  handValueToDescription,
} from '../../types/ChiaGaming';
import {
  shouldAutoFireCalpokerMove,
  shouldProcessCalpokerOpponentMoved,
} from '../../hooks/useCalpokerHand';

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

  it('does not auto-fire final reveal after hand is already finished', () => {
    expect(shouldAutoFireCalpokerMove(true, true, 2n)).toBe(false);
    expect(shouldAutoFireCalpokerMove(false, true, 2n)).toBe(true);
  });

  it('still accepts a late final readable move after terminal if no outcome was shown', () => {
    expect(shouldProcessCalpokerOpponentMoved(true, false)).toBe(true);
    expect(shouldProcessCalpokerOpponentMoved(true, true)).toBe(false);
  });
});
