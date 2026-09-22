import {
  StorageAuthorityLostError,
  StorageAuthorityRequiredError,
  indexedDbStoragePort,
  readApplicationState,
} from '../session/indexedDb';
import { storageRepository } from '../session/storageRepository';
import { captureDurableApplicationState } from '../session/sessionMachinePersist';
import { activeSave } from './session_save_envelope.fixtures';
import './save.harness';

describe('aggregate persistence authority', () => {
  it('fences a stale generation from overwriting the winning aggregate', async () => {
    const first = await indexedDbStoragePort.claimAndRead('first');
    const firstState = activeSave({ pairingToken: 'first' });
    await indexedDbStoragePort.writeApplicationState(firstState, first.authority);

    const winner = await indexedDbStoragePort.claimAndRead('winner');
    const winnerState = activeSave({ pairingToken: 'winner' });
    await indexedDbStoragePort.writeApplicationState(winnerState, winner.authority);

    await expect(
      indexedDbStoragePort.writeApplicationState(
        activeSave({ pairingToken: 'stale' }),
        first.authority,
      ),
    ).rejects.toBeInstanceOf(StorageAuthorityLostError);
    expect(await readApplicationState()).toEqual(winnerState);
  });

  it('requires claimed authority for session, wallet, and rejection mutations', async () => {
    storageRepository._resetForTests();
    await expect(
      storageRepository.updateCommon({ preferences: { theme: 'dark' } }),
    ).resolves.toBeUndefined();
    expect(() => storageRepository.replaceChannelFunding([])).toThrow(
      StorageAuthorityRequiredError,
    );
    expect(() =>
      captureDurableApplicationState({
        kind: 'transform',
        transform: (state) => state,
      }),
    ).toThrow(StorageAuthorityRequiredError);
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
