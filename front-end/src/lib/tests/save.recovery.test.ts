import { expectConsoleError } from '../../../scripts/testSetup';

import { storageRepository } from '../session/storageRepository';
import {
  hasSavedSessionMarker,
  markSavedSession,
  clearSavedSessionMarker,
  markAutoResumeOnce,
  peekAutoResumeOnce,
  clearAutoResumeOnce,
} from '../../hooks/saveCoordination';
import {
  readSessionRecord,
  readWalletOperationRecord,
  SESSION_DB_NAME,
  StorageAuthorityLostError,
} from '../session/indexedDb';
import { baseSave } from './session_save_envelope.fixtures';
import { WalletOperationRuntime, walletOperationRuntime } from '../session/walletOperationRuntime';
import {
  makeStorage,
  requireLive,
  sampleSession,
  saveHistory,
  saveLiveFields,
  savePreferences,
  setTestGlobal,
} from './save.harness';

describe('session persistence: recovery', () => {
  it('advances and publishes lifecycle generation on loss and reclaim', async () => {
    const initial = storageRepository.lifecycleGeneration;
    const events: Array<[number, string]> = [];
    const unsubscribe = storageRepository.onLifecycle((generation, event) => {
      events.push([generation, event]);
    });

    storageRepository.loseAuthority('takeover');
    expect(storageRepository.isGenerationCurrent(initial)).toBe(false);
    await storageRepository.claimLease();

    expect(events).toEqual([
      [initial + 1, 'authority-lost'],
      [initial + 2, 'claim'],
    ]);
    expect(storageRepository.isGenerationCurrent(initial + 2)).toBe(true);
    unsubscribe();
  });

  it('rejects a claim fenced after commit without installing or rewriting browser state', async () => {
    const before = storageRepository.loadState();
    walletOperationRuntime.registerReserved(
      'pre-authority-trade',
      {
        installationPlayerId: before.identity.playerId,
        peerSessionId: 'pre-authority-session',
        providerScope: { provider: 'simulator', identity: before.identity.playerId },
      },
      { kind: 'funding', operationId: 'pre-authority-operation' },
    );
    await walletOperationRuntime.flushPersistence();
    storageRepository._resetForTests({ preserveWalletOperationRuntime: true });
    const retainedPlayerId = storageRepository.loadState().identity.playerId;

    let release!: () => void;
    let committed!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedCommit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    storageRepository.holdNextClaimAfterCommitForTests(barrier, committed);

    const claim = storageRepository.claimAndHydrateSession();
    await reachedCommit;
    localStorage.setItem('appState_activeTab', 'winning-tab');
    const winningPreferences = JSON.stringify({
      playerId: 'winning-player',
      extra: 'must-not-be-normalized',
    });
    localStorage.setItem('appPreferences', winningPreferences);
    storageRepository.loseAuthority('takeover');
    release();

    await expect(claim).rejects.toBeInstanceOf(StorageAuthorityLostError);
    expect(localStorage.getItem('appState_activeTab')).toBe('winning-tab');
    expect(localStorage.getItem('appPreferences')).toBe(winningPreferences);
    expect(storageRepository.loadState().identity.playerId).toBe(retainedPlayerId);
    expect(walletOperationRuntime.snapshot()).toEqual([
      expect.objectContaining({ tradeId: 'pre-authority-trade' }),
    ]);
  });

  it('does not hydrate a persisted bare ledger array', () => {
    expect(() => new WalletOperationRuntime().hydrateFromDisk([])).toThrow(
      'Garbled wallet operation record',
    );
  });

  it('reports malformed ledger boot hydration and leaves the record on disk', async () => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SESSION_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    await new Promise<void>((resolve, reject) => {
      const transaction = db.transaction('wallet-reservations', 'readwrite');
      transaction.objectStore('wallet-reservations').put({ malformed: true }, 'current');
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
    db.close();

    storageRepository._resetForTests();
    const hydration = await storageRepository.hydrateSessionCacheFromDisk();
    expect(hydration).toEqual({
      status: 'failed',
      error: 'Stored wallet operation record is malformed',
    });

    const verifyDb = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = indexedDB.open(SESSION_DB_NAME);
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const stored = await new Promise<unknown>((resolve, reject) => {
      const transaction = verifyDb.transaction('wallet-reservations', 'readonly');
      const request = transaction.objectStore('wallet-reservations').get('current');
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    verifyDb.close();
    expect(stored).toEqual({ malformed: true });
  });

  it('sets the saved-session marker when a resumable record is written', async () => {
    expect(hasSavedSessionMarker()).toBe(false);

    saveLiveFields();
    await storageRepository.flushSessionSave();
    expect(hasSavedSessionMarker()).toBe(true);

    await storageRepository.clearSession();
    expect(hasSavedSessionMarker()).toBe(false);
  });

  it('keeps an explicit pre-game marker across blockchainType preference writes', async () => {
    markSavedSession();
    savePreferences({ blockchainType: 'simulator' });
    await storageRepository.flushSessionSave();

    expect(hasSavedSessionMarker()).toBe(true);
    expect(await storageRepository.peekSession()).toMatchObject({
      preferences: { blockchainType: 'simulator' },
    });
  });

  it('treats leftover blockchainType without a marker as resume-worthy', async () => {
    savePreferences({ blockchainType: 'walletconnect' });
    await storageRepository.flushSessionSave();
    clearSavedSessionMarker();

    expect(storageRepository.shouldOfferResumeOrStartOver()).toBe(true);
    expect(await storageRepository.peekSession()).toMatchObject({
      preferences: { blockchainType: 'walletconnect' },
    });
    expect(hasSavedSessionMarker()).toBe(true);
  });

  it('treats leftover hubUrl without a marker as resume-worthy', async () => {
    savePreferences({ hubUrl: 'http://localhost:3003' });
    await storageRepository.flushSessionSave();
    clearSavedSessionMarker();

    expect(storageRepository.shouldOfferResumeOrStartOver()).toBe(true);
    expect(await storageRepository.peekSession()).toMatchObject({
      preferences: { hubUrl: 'http://localhost:3003' },
    });
    expect(hasSavedSessionMarker()).toBe(true);
  });

  it('shouldOfferResumeOrStartOver is false on a clean slate', () => {
    expect(storageRepository.shouldOfferResumeOrStartOver()).toBe(false);
  });

  it('auto-resume once flag is one-shot in sessionStorage', () => {
    expect(peekAutoResumeOnce()).toBe(false);
    markAutoResumeOnce();
    expect(peekAutoResumeOnce()).toBe(true);
    // Second peek still true (latched) until cleared.
    expect(peekAutoResumeOnce()).toBe(true);
    clearAutoResumeOnce();
    expect(peekAutoResumeOnce()).toBe(false);
  });

  it('auto-resume latch survives clearing sessionStorage until clearAutoResumeOnce', () => {
    markAutoResumeOnce();
    expect(peekAutoResumeOnce()).toBe(true);
    sessionStorage.removeItem('appState_autoResumeOnce');
    expect(peekAutoResumeOnce()).toBe(true);
    clearAutoResumeOnce();
    expect(peekAutoResumeOnce()).toBe(false);
  });

  it('does not let preference-only patches clobber a durable cradle before hydrate', async () => {
    saveLiveFields();
    await storageRepository.flushSessionSave();
    expect(hasSavedSessionMarker()).toBe(true);

    // Simulate marker-only boot: memory has preferences, IndexedDB has the cradle.
    storageRepository._resetForTests();
    await storageRepository.claimLease();
    expect(hasSavedSessionMarker()).toBe(true);
    expect(storageRepository.loadState()).not.toHaveProperty('live');

    saveHistory({ diagnosticLog: ['boot log'] });
    await storageRepository.flushSessionSave();

    storageRepository._resetForTests();
    const loaded = requireLive(await storageRepository.peekSession());
    expect(loaded.live.serializedGameSession).toEqual(sampleSession.serializedGameSession);
    expect(loaded.pairing.token).toBe(sampleSession.pairingToken);
    expect(loaded.history.diagnosticLog).toEqual(['boot log']);
  });

  it('flush persists a newer in-memory cradle even when sessionId is unset', async () => {
    const first = new Uint8Array([1, 1, 1, 1]);
    const second = new Uint8Array([2, 2, 2, 2, 2, 2]);
    markSavedSession();
    saveLiveFields({
      ...sampleSession,
      serializedGameSession: first,
      pairingToken: 'tok-v1',
      // Intentionally omit sessionId — handshake saves often look like this.
    });
    await storageRepository.flushSessionSave();

    saveLiveFields({
      ...sampleSession,
      serializedGameSession: second,
      pairingToken: 'tok-v2',
    });
    await storageRepository.flushSessionSave();

    storageRepository._resetForTests();
    const loaded = requireLive(await storageRepository.peekSession());
    expect(loaded.live.serializedGameSession).toEqual(second);
    expect(loaded.pairing.token).toBe('tok-v2');
  });

  it('returns a pre-game blockchainType record when the boot marker is set', async () => {
    localStorage.setItem('appState_savedSession', '1');
    await storageRepository.persist(
      storageRepository.mutateRecords(
        'write-session',
        baseSave({ playerId: 'player', blockchainType: 'simulator' }),
      ),
    );
    expect(await storageRepository.peekSession()).toMatchObject({
      preferences: { blockchainType: 'simulator' },
    });
    expect(hasSavedSessionMarker()).toBe(true);
  });

  it('clears the marker for a present but empty IndexedDB record', async () => {
    localStorage.setItem('appState_savedSession', '1');
    await storageRepository.persist(
      storageRepository.mutateRecords('write-session', baseSave({ playerId: 'player' })),
    );
    expect(await storageRepository.peekSession()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(false);
  });

  it('returns null when nothing is saved', async () => {
    expect(await storageRepository.peekSession()).toBeNull();
  });

  it('clearSession asynchronously deletes resumable state', async () => {
    saveLiveFields();
    await storageRepository.flushSessionSave();
    await storageRepository.clearSession();
    storageRepository._resetForTests();
    expect(await storageRepository.peekSession()).toBeNull();
  });

  it('orders clearSession before an immediate unawaited replacement save', async () => {
    saveLiveFields({
      ...sampleSession,
      serializedGameSession: new Uint8Array([1]),
    });
    await storageRepository.flushSessionSave();

    const cleared = storageRepository.clearSession();
    const saved = saveLiveFields({
      ...sampleSession,
      serializedGameSession: new Uint8Array([2]),
      pairingToken: 'replacement-after-clear',
    });
    const flushed = storageRepository.flushSessionSave();
    await Promise.all([cleared, saved, flushed]);

    const persisted = requireLive(await readSessionRecord());
    expect(persisted.live.serializedGameSession).toEqual(new Uint8Array([2]));
    expect(persisted.pairing.token).toBe('replacement-after-clear');
  });

  it('rejects an old combined checkpoint without reporting loss of a newer claim', async () => {
    let release!: () => void;
    let committed!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const reachedCommit = new Promise<void>((resolve) => {
      committed = resolve;
    });
    const authorityLost = jest.fn();
    const unsubscribe = storageRepository.onAuthorityLost(authorityLost);
    storageRepository.holdNextCheckpointAfterCommitForTests(barrier, committed);

    saveLiveFields({
      ...sampleSession,
      serializedGameSession: new Uint8Array([7]),
    });
    const checkpoint = storageRepository.flushSessionSave();
    await reachedCommit;
    await storageRepository.claimLease();
    expectConsoleError('Durable storage authority was lost');
    release();

    await expect(checkpoint).rejects.toBeInstanceOf(StorageAuthorityLostError);
    expect(authorityLost).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('clearSession deletes the session while preserving the independent ledger', async () => {
    walletOperationRuntime.registerReserved(
      'trade-clear',
      {
        installationPlayerId: 'installation',
        peerSessionId: 'peer-session',
        providerScope: { provider: 'simulator' as const, identity: 'installation' },
      },
      { kind: 'funding', operationId: 'funding-operation' },
    );
    await walletOperationRuntime.flushPersistence();
    await storageRepository.clearSession();
    storageRepository._resetForTests();

    await storageRepository.claimAndHydrateSession();
    expect(walletOperationRuntime.snapshot()).toEqual([
      expect.objectContaining({
        tradeId: 'trade-clear',
        stage: 'cancel-required',
        reason: 'orphaned-reservation-restored',
      }),
    ]);
  });

  it('hydrates the independent ledger without a session record or marker', async () => {
    storageRepository._resetForTests();
    await storageRepository.claimLease();
    await storageRepository.persist(
      storageRepository.mutateRecords('write-wallet-operations', [
        {
          tradeId: 'trade-independent',
          owner: {
            installationPlayerId: 'installation',
            peerSessionId: 'peer-session',
            providerScope: { provider: 'simulator' as const, identity: 'installation' },
          },
          purpose: { kind: 'fee', operationId: 'submission' },
          stage: 'reserved',
          reason: 'created-before-reload',
        },
      ]),
    );
    clearSavedSessionMarker();

    expect(await storageRepository.claimAndHydrateSession()).toMatchObject({
      phase: 'preferences',
    });
    expect(walletOperationRuntime.snapshot()).toEqual([
      expect.objectContaining({
        tradeId: 'trade-independent',
        stage: 'cancel-required',
        reason: 'orphaned-reservation-restored',
      }),
    ]);
  });

  it('restores retained fee sources without promoting them to cancellation', async () => {
    storageRepository._resetForTests();
    await storageRepository.claimLease();
    await storageRepository.persist(
      storageRepository.mutateRecords('write-wallet-operations', [
        {
          tradeId: 'trade-retained',
          owner: {
            installationPlayerId: 'installation',
            peerSessionId: 'peer-session',
            providerScope: { provider: 'simulator' as const, identity: 'installation' },
          },
          purpose: { kind: 'fee', operationId: 'submission-7' },
          stage: 'retained-for-replay',
          reason: 'fee-source-attached',
        },
      ]),
    );

    await storageRepository.claimAndHydrateSession();

    expect(walletOperationRuntime.snapshot()).toEqual([
      expect.objectContaining({
        tradeId: 'trade-retained',
        stage: 'retained-for-replay',
        reason: 'fee-source-attached',
      }),
    ]);
  });

  it.each(['session deletion', 'rejection tombstone'])(
    '%s preserves the ledger store',
    async (kind) => {
      const entry = {
        tradeId: `trade-${kind}`,
        owner: {
          installationPlayerId: 'installation',
          peerSessionId: 'peer-session',
          providerScope: { provider: 'simulator' as const, identity: 'installation' },
        },
        purpose: { kind: 'funding' as const, operationId: 'funding' },
        stage: 'cancel-required' as const,
        reason: 'cleanup',
      };
      await storageRepository.persist(
        storageRepository.mutateRecords('write-wallet-operations', [entry]),
      );
      saveLiveFields();
      await storageRepository.flushSessionSave();
      if (kind === 'session deletion') {
        await storageRepository.clearSession();
      } else {
        await storageRepository.clearSessionWithRejectionTombstone({
          kind: 'outbound-reject',
          peerId: 'peer',
          sessionId: '0'.repeat(32),
          messageNumber: 2n,
          remoteNumber: 1n,
          unackedMessages: [],
          createdAt: Date.now(),
        });
      }
      expect((await readWalletOperationRecord())?.entries).toEqual([entry]);
    },
  );

  it('saveSession preserves blockchainType', async () => {
    saveLiveFields({ ...sampleSession, blockchainType: 'walletconnect' });
    await storageRepository.flushSessionSave();
    expect((await storageRepository.peekSession())?.preferences.blockchainType).toBe(
      'walletconnect',
    );
  });

  it('saveSession swallows quota-exceeded errors', () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const storage = makeStorage();
    const origSetItem = storage.setItem.bind(storage);
    let firstCall = true;
    storage.setItem = (key: string, value: string) => {
      if (!firstCall) throw new DOMException('quota exceeded');
      firstCall = false;
      origSetItem(key, value);
    };
    setTestGlobal('localStorage', storage);
    storageRepository.getPlayerId();
    expect(() => saveLiveFields()).not.toThrow();
    spy.mockRestore();
  });
});
