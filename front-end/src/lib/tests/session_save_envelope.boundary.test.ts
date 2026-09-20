import { calpokerStateCodec } from '@games/calpoker/ui/serialize';
import {
  CURRENT_VERSION,
  flushSessionSave,
  hasSavedSessionMarker,
  markSavedSession,
  peekSession,
  saveSession,
} from '../session/sessionCache';
import { readSessionRecord, readWalletOperationRecord } from '../session/indexedDb';
import {
  ACTIVE_INSTANCE,
  activeSave,
  baseSave,
  installSessionEnvelopeTestSetup,
  liveSave,
} from './session_save_envelope.fixtures';
import { storageCoordinator } from '../session/storageCoordinator';

installSessionEnvelopeTestSetup();

describe('save boundary enforcement', () => {
  it('preserves wallet storage when session reading encounters a newer database version', async () => {
    const sentinel = new Uint8Array([9, 8, 7]);
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('chia-gaming-session', 5);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('wallet-reservations', 'readwrite');
        tx.objectStore('wallet-reservations').put(sentinel, 'current');
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });

    try {
      await expect(readSessionRecord()).rejects.toMatchObject({ name: 'VersionError' });
      const rawLedger = await new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open('chia-gaming-session', 5);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('wallet-reservations', 'readonly');
          const request = tx.objectStore('wallet-reservations').get('current');
          tx.onerror = () => reject(tx.error);
          tx.oncomplete = () => {
            db.close();
            resolve(request.result);
          };
        };
      });
      expect(rawLedger).toEqual(sentinel);
    } finally {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase('chia-gaming-session');
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('test database deletion was blocked'));
      });
    }
  });

  it('preserves wallet storage when the session object store is missing', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.deleteDatabase('chia-gaming-session');
      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(new Error('test database deletion was blocked'));
    });
    const sentinel = new Uint8Array([6, 5, 4]);
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('chia-gaming-session', 4);
      open.onerror = () => reject(open.error);
      open.onupgradeneeded = () => {
        open.result.createObjectStore('wallet-reservations');
      };
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('wallet-reservations', 'readwrite');
        tx.objectStore('wallet-reservations').put(sentinel, 'current');
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });

    try {
      await expect(readSessionRecord()).rejects.toMatchObject({ name: 'NotFoundError' });
      const rawLedger = await new Promise<unknown>((resolve, reject) => {
        const open = indexedDB.open('chia-gaming-session', 4);
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('wallet-reservations', 'readonly');
          const request = tx.objectStore('wallet-reservations').get('current');
          tx.onerror = () => reject(tx.error);
          tx.oncomplete = () => {
            db.close();
            resolve(request.result);
          };
        };
      });
      expect(rawLedger).toEqual(sentinel);
    } finally {
      await new Promise<void>((resolve, reject) => {
        const request = indexedDB.deleteDatabase('chia-gaming-session');
        request.onsuccess = () => resolve();
        request.onerror = () => reject(request.error);
        request.onblocked = () => reject(new Error('test database deletion was blocked'));
      });
    }
  });

  it('blocks session hydration when the independent wallet ledger is malformed', async () => {
    const session = liveSave();
    await storageCoordinator.persist(storageCoordinator.writeSession(session));
    const malformedLedger = new Uint8Array([1, 2, 3]);
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open('chia-gaming-session');
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('wallet-reservations', 'readwrite');
        tx.objectStore('wallet-reservations').put(malformedLedger, 'current');
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
    markSavedSession();

    await expect(peekSession()).rejects.toThrow('Stored wallet operation record is malformed');
    expect(await readSessionRecord()).toEqual(session);
    await expect(readWalletOperationRecord()).rejects.toThrow(
      'Stored wallet operation record is malformed',
    );
  });

  it('deletes the previous envelope version without migration and keeps the marker', async () => {
    const ledger = [
      {
        tradeId: 'trade-preserved',
        owner: {
          installationPlayerId: 'installation',
          peerSessionId: 'peer-session',
          providerScope: { provider: 'simulator' as const, identity: 'installation' },
        },
        purpose: { kind: 'funding' as const, operationId: 'funding' },
        stage: 'cancel-required' as const,
        reason: 'cleanup',
      },
    ];
    await storageCoordinator.persist(storageCoordinator.writeWalletOperations(ledger));
    markSavedSession();
    await storageCoordinator.persist(
      storageCoordinator.writeSession({
        version: CURRENT_VERSION - 1n,
        playerId: 'old-player',
        serializedGameSession: new Uint8Array([1, 2, 3]),
      } as unknown as SessionSave),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect((await readWalletOperationRecord())?.entries).toEqual(ledger);
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('rejects an invalid full envelope before writing it', async () => {
    const invalid = liveSave({
      serializedGameSession: new Uint8Array([1]),
      activeGameIds: ['game-1', 'game-1'],
      currentHandGameIds: ['game-1'],
      activeGameType: 'calpoker',
      gameInstances: { 'game-1': ACTIVE_INSTANCE },
    });
    if (invalid.phase !== 'live') throw new Error('expected live fixture');
    const scheduled = saveSession({
      scope: 'live',
      pairing: invalid.pairing,
      live: invalid.live,
      presentation: invalid.presentation,
    });

    await expect(flushSessionSave()).rejects.toThrow('duplicate activeGameIds');
    await expect(scheduled).rejects.toThrow('duplicate activeGameIds');
    expect(await readSessionRecord()).toBeNull();
  });

  it('deletes an invalid current-v13 game envelope while retaining the boot marker', async () => {
    markSavedSession();
    await storageCoordinator.persist(
      storageCoordinator.writeSession(
        activeSave({
          activeGameIds: ['game-1', 'game-1'],
        }),
      ),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('deletes a cross-phase v13 payload during hydration', async () => {
    markSavedSession();
    await storageCoordinator.persist(
      storageCoordinator.writeSession(
        baseSave({
          activeGameIds: ['game-1'],
          currentHandGameIds: ['game-1'],
          activeGameType: 'calpoker',
          gameInstances: { 'game-1': ACTIVE_INSTANCE },
          handState: calpokerStateCodec.encode({
            playerHand: [1n],
            opponentHand: [2n],
            moveNumber: 1n,
            isPlayerTurn: true,
            iStarted: true,
            error: null,
          }),
          betweenHandLastHandProposal: {
            my_contribution: '20',
            their_contribution: '20',
            game_timeout: '15',
            game_type: 'calpoker',
            parameters: null,
          },
        }),
      ),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('deletes a live v13 record that restoreSession cannot consume', async () => {
    markSavedSession();
    await storageCoordinator.persist(
      storageCoordinator.writeSession(liveSave({ messageNumber: undefined })),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('deletes a persisted hand whose game type disagrees with its terms', async () => {
    markSavedSession();
    await storageCoordinator.persist(
      storageCoordinator.writeSession(
        activeSave({
          activeGameType: 'spacepoker',
        }),
      ),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('deletes a malformed current-v16 metadata envelope read from IndexedDB', async () => {
    markSavedSession();
    await storageCoordinator.persist(
      storageCoordinator.writeSession(
        baseSave({
          betweenHandCompose: {
            selected_game: 'calpoker',
            game_timeout: 'not-a-timeout',
            proposal_sent: false,
            drafts: {
              calpoker: { amount: '10' },
              krunk: { amount: '100' },
              spacepoker: { unitSize: '1', stackSize: '10' },
            },
          },
        }),
      ),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('catches and deletes malformed raw IndexedDB bytes', async () => {
    const open = indexedDB.open('chia-gaming-session');
    await new Promise<void>((resolve, reject) => {
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('session', 'readwrite');
        tx.objectStore('session').put(new Uint8Array([1, 2, 3]), 'current');
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
    markSavedSession();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('rejects a raw legacy IndexedDB object before decoding it', async () => {
    const raw = activeSave();
    if (raw.phase !== 'live') throw new Error('expected live fixture');
    Reflect.deleteProperty(raw.presentation.gameInstances['game-1'].terminal, 'label');
    const open = indexedDB.open('chia-gaming-session');
    await new Promise<void>((resolve, reject) => {
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('session', 'readwrite');
        tx.objectStore('session').put(raw, 'current');
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
    markSavedSession();
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    await expect(readSessionRecord()).rejects.toThrow('Stored session record is malformed');
    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });
});
