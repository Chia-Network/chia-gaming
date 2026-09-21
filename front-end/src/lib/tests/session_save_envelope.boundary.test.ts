import 'fake-indexeddb/auto';
import {
  SESSION_DB_NAME,
  StorageAuthorityLostError,
  indexedDbStoragePort,
  readApplicationState,
} from '../session/indexedDb';
import { activeSave } from './session_save_envelope.fixtures';

function openDatabase(version?: number): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(SESSION_DB_NAME, version);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

describe('application-state IndexedDB boundary', () => {
  beforeEach(
    () =>
      new Promise<void>((resolve) => {
        const request = indexedDB.deleteDatabase(SESSION_DB_NAME);
        request.onsuccess = () => resolve();
        request.onerror = () => resolve();
        request.onblocked = () => resolve();
      }),
  );

  it('upgrades to exactly coordination and application-state without migration', async () => {
    const legacy = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SESSION_DB_NAME, 4);
      request.onupgradeneeded = () => {
        for (const name of ['session', 'wallet-reservations', 'rejections']) {
          request.result.createObjectStore(name);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    legacy.close();

    await indexedDbStoragePort.claimAndRead('owner');
    const current = await openDatabase();
    expect([...current.objectStoreNames].sort()).toEqual(['application-state', 'coordination']);
    current.close();
  });

  it('claims coordination and one aggregate generation atomically', async () => {
    const first = await indexedDbStoragePort.claimAndRead('first');
    const state = activeSave();
    await indexedDbStoragePort.writeApplicationState(state, first.authority);

    const second = await indexedDbStoragePort.claimAndRead('second');
    expect(second.applicationState).toEqual(state);
    await expect(
      indexedDbStoragePort.writeApplicationState(
        activeSave({ pairingToken: 'stale' }),
        first.authority,
      ),
    ).rejects.toBeInstanceOf(StorageAuthorityLostError);
    expect(await readApplicationState()).toEqual(state);
  });

  it('reports one aggregate corruption error without salvaging nested state', async () => {
    const claim = await indexedDbStoragePort.claimAndRead('writer');
    const state = activeSave();
    state.rejectionTransports = [
      {
        kind: 'outbound-reject',
        peerId: 'peer',
        sessionId: 'not-hex',
        messageNumber: 1n,
        remoteNumber: 0n,
        unackedMessages: [],
        createdAt: 1,
      },
    ];
    await expect(
      indexedDbStoragePort.writeApplicationState(state, claim.authority),
    ).rejects.toThrow();
    expect(await readApplicationState()).toBeNull();
  });
});
