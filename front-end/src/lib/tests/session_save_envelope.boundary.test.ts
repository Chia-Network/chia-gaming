import { calpokerStateCodec } from '../../features/calPoker/stateCodec';
import {
  flushSessionSave,
  hasSavedSessionMarker,
  markSavedSession,
  peekSession,
  saveSession,
} from '../../hooks/save';
import { readSessionRecord, writeSessionRecord } from '../session/indexedDb';
import {
  ACTIVE_INSTANCE,
  activeSave,
  baseSave,
  installSessionEnvelopeTestSetup,
  liveSave,
} from './session_save_envelope.fixtures';

installSessionEnvelopeTestSetup();

describe('save boundary enforcement', () => {
  it('deletes an obsolete v11 envelope without migration and keeps the marker', async () => {
    markSavedSession();
    await writeSessionRecord({
      version: 11n,
      playerId: 'old-player',
      serializedGameSession: new Uint8Array([1, 2, 3]),
    } as unknown as Parameters<typeof writeSessionRecord>[0]);
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
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

  it('deletes an invalid current-v12 game envelope while retaining the boot marker', async () => {
    markSavedSession();
    await writeSessionRecord(
      activeSave({
        activeGameIds: ['game-1', 'game-1'],
      }),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('deletes a cross-phase v12 payload during hydration', async () => {
    markSavedSession();
    await writeSessionRecord(
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
        }),
        betweenHandLastTerms: {
          my_contribution: '20',
          their_contribution: '20',
          game_timeout: '15',
          game_type: 'calpoker',
        },
      }),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('deletes a live v12 record that restoreSession cannot consume', async () => {
    markSavedSession();
    await writeSessionRecord(liveSave({ messageNumber: undefined }));
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('deletes a persisted hand whose game type disagrees with its terms', async () => {
    markSavedSession();
    await writeSessionRecord(
      activeSave({
        activeGameType: 'spacepoker',
      }),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('deletes a malformed current-v12 metadata envelope read from IndexedDB', async () => {
    markSavedSession();
    await writeSessionRecord(
      baseSave({
        betweenHandCompose: {
          selected_game: 'calpoker',
          game_timeout: 'not-a-timeout',
          proposal_sent: false,
          calpoker: { amount: '10' },
          krunk: { amount: '100' },
          spacepoker: { unit_size: '1', stack_size: '10' },
        },
      }),
    );
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await peekSession()).toBeNull();
    expect(await readSessionRecord()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(true);
    errorSpy.mockRestore();
  });

  it('catches and deletes malformed raw IndexedDB bytes', async () => {
    const open = indexedDB.open('chia-gaming-session', 1);
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
    const open = indexedDB.open('chia-gaming-session', 1);
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
