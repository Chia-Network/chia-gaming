import {
  isSpacepokerTimeoutOrForfeit,
  spacepokerTerminalBadge,
} from './terminal';
import { isTerminalSpacepokerHandler, SpHandler } from './useSpacepokerHand';

describe('Space Poker terminal UX', () => {
  it('maps its own timeout and forfeit terminal badges', () => {
    expect(spacepokerTerminalBadge('timed_out_waiting_for_our_move', 'ours')).toBe('timeout');
    expect(spacepokerTerminalBadge('timed_out_waiting_for_our_move', 'theirs')).toBe('winner');
    expect(spacepokerTerminalBadge('opponent_timed_out', 'ours')).toBe('winner');
    expect(isSpacepokerTimeoutOrForfeit('settled_cleanly')).toBe(false);
  });

  it('allows settlement to transition an active hand even after moves are disabled', () => {
    expect(isTerminalSpacepokerHandler(SpHandler.MidRound)).toBe(false);
    expect(isTerminalSpacepokerHandler(SpHandler.Folded)).toBe(true);
    expect(isTerminalSpacepokerHandler(SpHandler.Showdown)).toBe(true);
  });
});
