import { cardIdToRankSuit, handValueToDescription } from './types';
import {
  shouldAutoFireCalpokerMove,
  shouldProcessCalpokerOpponentMoved,
  calpokerResponderFinishesAtReveal,
  shouldRestoreCalpokerSelection,
} from './useCalpokerHand';
import { calpokerTimeoutBadge } from '../../lib/settlement';

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

  it('at the endgame reveal, only the responder finishes; the terminal mover (Alice) still plays step e', () => {
    // iStarted === false is the first mover ("Alice"), who owes the terminal
    // move e and must NOT be marked finished, or her autofire never fires.
    expect(calpokerResponderFinishesAtReveal(false)).toBe(false);
    // iStarted === true is the responder ("Bob"), who gives up and must not
    // send a phantom sixth move.
    expect(calpokerResponderFinishesAtReveal(true)).toBe(true);
  });

  it('preserves a terminal snapshot at move 1', () => {
    expect(shouldRestoreCalpokerSelection('1', false, true)).toBe(false);
  });

  it('restores an active move-1 hand to card selection', () => {
    expect(shouldRestoreCalpokerSelection('1', false, false)).toBe(true);
  });

  it('does not describe an off-chain settlement as a timeout', () => {
    expect(calpokerTimeoutBadge('accept_settlement', 'ours')).toBeNull();
    expect(calpokerTimeoutBadge('accept_settlement', 'theirs')).toBeNull();
    expect(calpokerTimeoutBadge('timed_out_waiting_for_our_move', 'ours')).toBe('timeout');
    expect(calpokerTimeoutBadge('opponent_timed_out', 'ours')).toBe('winner');
  });

  it('does not show a timeout badge after a completed hand settles on-chain', () => {
    expect(calpokerTimeoutBadge('timed_out_waiting_for_our_move', 'ours', true)).toBeNull();
    expect(calpokerTimeoutBadge('opponent_timed_out', 'theirs', true)).toBeNull();
  });
});
