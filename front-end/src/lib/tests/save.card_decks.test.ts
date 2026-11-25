import { releaseLeaseIfOwner } from '../session/saveCoordination';
import { storageRepository } from '../session/storageRepository';
import './save.harness';

describe('card deck preference', () => {
  it('saves one deck per game with the other preferences, across a reload', async () => {
    storageRepository._resetForTests();
    await storageRepository.claimApplicationState();
    expect(storageRepository.query('cardDecks')).toEqual({});
    await storageRepository.updatePreference({ key: 'cardDecks', value: { calpoker: 'pixel' } });
    releaseLeaseIfOwner();
    storageRepository._resetForTests();

    await storageRepository.claimApplicationState();
    expect(storageRepository.query('cardDecks')).toEqual({ calpoker: 'pixel' });
  });
});
