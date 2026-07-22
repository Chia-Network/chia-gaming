import {
  isSpacepokerTimeoutOrForfeit,
  spacepokerTerminalBadge,
} from './terminal';

describe('Space Poker terminal UX', () => {
  it('maps its own timeout and forfeit terminal badges', () => {
    expect(spacepokerTerminalBadge('timed_out_waiting_for_our_move', 'ours')).toBe('timeout');
    expect(spacepokerTerminalBadge('timed_out_waiting_for_our_move', 'theirs')).toBe('winner');
    expect(spacepokerTerminalBadge('opponent_timed_out', 'ours')).toBe('winner');
    expect(isSpacepokerTimeoutOrForfeit('settled_cleanly')).toBe(false);
  });
});
