import { StorageAuthorityRequiredError, indexedDbStoragePort } from '../session/indexedDb';
import { storageRepository } from '../session/storageRepository';
import { activeSave } from './session_save_envelope.fixtures';
import './save.harness';

describe('aggregate persistence authority', () => {
  it('requires claimed authority for session, wallet, and rejection mutations', async () => {
    storageRepository._resetForTests();
    await expect(
      storageRepository.updateCommon({ preferences: { theme: 'dark' } }),
    ).resolves.toBeUndefined();
    expect(() => storageRepository.replaceChannelFunding([])).toThrow(
      StorageAuthorityRequiredError,
    );
    expect(() => storageRepository.patchApplicationState((state) => state)).toThrow(
      StorageAuthorityRequiredError,
    );
  });

  it('claim returns the exact aggregate snapshot paired with its authority', async () => {
    const state = activeSave({ pairingToken: 'snapshot' });
    const owned = await indexedDbStoragePort.claimAndRead('writer');
    await indexedDbStoragePort.writeApplicationState(state, owned.authority);
    const claimed = await indexedDbStoragePort.claimAndRead('reader');
    expect(claimed.applicationState).toEqual(state);
    expect(claimed.authority.writeEpoch).toBeGreaterThan(owned.authority.writeEpoch);
  });
});
