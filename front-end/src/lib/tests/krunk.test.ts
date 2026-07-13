import { KrunkHandler, canDraftKrunkGuess } from '../../hooks/useKrunkHand';
import {
  isValidKrunkStake,
  parseTermsFromNotificationValue,
} from '../../hooks/useGameSession';

describe('Krunk terms', () => {
  it('requires positive 100-mojo stake increments', () => {
    expect(isValidKrunkStake(0n)).toBe(false);
    expect(isValidKrunkStake(99n)).toBe(false);
    expect(isValidKrunkStake(100n)).toBe(true);
    expect(isValidKrunkStake(200n)).toBe(true);
    expect(isValidKrunkStake(201n)).toBe(false);
  });

  it('keeps the aggregate per-player contributions from a grouped proposal', () => {
    expect(parseTermsFromNotificationValue({
      my_contribution: { Amount: '300' },
      their_contribution: { Amount: '300' },
      timeout: 15,
    }, 'krunk')).toEqual({
      gameType: 'krunk',
      myContribution: 300n,
      theirContribution: 300n,
      gameTimeout: 15n,
    });
  });
});

describe('Krunk first guess drafting', () => {
  it('allows drafting after our word commit while their commit is pending', () => {
    expect(canDraftKrunkGuess(true, KrunkHandler.BobWaiting, 0)).toBe(true);
    expect(canDraftKrunkGuess(false, KrunkHandler.BobWaiting, 0)).toBe(false);
    expect(canDraftKrunkGuess(true, KrunkHandler.BobWaiting, 1)).toBe(false);
    expect(canDraftKrunkGuess(true, KrunkHandler.BobGuess, 0)).toBe(false);
  });
});
