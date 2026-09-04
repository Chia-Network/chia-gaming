import {
  peekSession,
  clearSession,
  hasSavedSessionMarker,
  shouldOfferResumeOrStartOver,
  markSavedSession,
  clearSavedSessionMarker,
  markAutoResumeOnce,
  peekAutoResumeOnce,
  clearAutoResumeOnce,
  clearSessionWithInboundRejectionReceipt,
  loadState,
  flushSessionSave,
  getPlayerId,
  _resetForTests,
} from '../../hooks/save';
import {
  MAX_DURABLE_REJECTION_TOMBSTONES,
  readRejectionTombstones,
  REJECTION_TOMBSTONE_TTL_MS,
  rejectionTombstoneKey,
  SESSION_DB_NAME,
  writeRejectionTombstone,
  writeSessionRecord,
} from '../session/indexedDb';
import {
  DIAGNOSTIC_LOG_LIMIT,
  HUMAN_HISTORY_LIMIT,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from '../session/historyLimits';
import { baseSave } from './session_save_envelope.fixtures';
import {
  clearTestGlobal,
  makeStorage,
  requireLive,
  sampleSession,
  saveHistory,
  saveLiveFields,
  savePreferences,
  setTestGlobal,
  testIndexedDb,
} from './save.harness';

describe('session persistence', () => {
  it('obfuscates and round-trips one raw binary/bigint record through IndexedDB', async () => {
    saveLiveFields({
      ...sampleSession,
    });
    await flushSessionSave();

    const stored = await new Promise<{ count: number; record: unknown }>((resolve, reject) => {
      const open = indexedDB.open(SESSION_DB_NAME);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('session', 'readonly');
        const store = tx.objectStore('session');
        const count = store.count();
        const record = store.get('current');
        tx.onerror = () => reject(tx.error);
        tx.oncomplete = () => {
          db.close();
          resolve({
            count: count.result,
            record: record.result,
          });
        };
      };
    });

    expect(stored.count).toBe(1);
    expect(stored.record).toBeInstanceOf(Uint8Array);
    expect(new TextDecoder().decode(stored.record as Uint8Array)).not.toContain(
      'serializedGameSession',
    );

    _resetForTests();
    const loaded = await peekSession();
    expect(loaded).toMatchObject({ phase: 'live' });
    expect(loaded?.phase === 'live' && loaded.live.serializedGameSession).toBeInstanceOf(
      Uint8Array,
    );
    expect(loaded?.phase === 'live' && loaded.live.unackedMessages[0].msg).toBeInstanceOf(
      Uint8Array,
    );
    expect(typeof (loaded?.phase === 'live' && loaded.live.messageNumber)).toBe('bigint');
    expect(loaded?.history.humanHistory).toEqual(['human1']);
    expect(loaded).not.toHaveProperty('log');
  });

  it('bounds rejection tombstones without replacing the active session record', async () => {
    saveLiveFields();
    await flushSessionSave();
    await Promise.all(
      Array.from({ length: MAX_DURABLE_REJECTION_TOMBSTONES + 1 }, (_, index) =>
        writeRejectionTombstone({
          kind: 'outbound-reject',
          peerId: `peer-${index}`,
          sessionId: index.toString(16).padStart(32, '0'),
          messageNumber: 2n,
          remoteNumber: 1n,
          unackedMessages: [{ msgno: 1n, msg: new Uint8Array([index]) }],
          createdAt: Date.now() + index,
        }),
      ),
    );

    const tombstones = await readRejectionTombstones();
    expect(tombstones).toHaveLength(MAX_DURABLE_REJECTION_TOMBSTONES);
    expect(tombstones[0].peerId).toBe('peer-1');
    _resetForTests();
    expect(await peekSession()).toMatchObject({ phase: 'live' });
  });

  it('keeps same-session rejection tombstones distinct across peers', async () => {
    const sessionId = 'ab'.repeat(16);
    const routed = new Map([
      [rejectionTombstoneKey('peer-a', sessionId), 'a'],
      [rejectionTombstoneKey('peer-b', sessionId), 'b'],
    ]);
    expect(routed.size).toBe(2);
    await Promise.all(
      ['peer-a', 'peer-b'].map((peerId, index) =>
        writeRejectionTombstone({
          kind: 'outbound-reject',
          peerId,
          sessionId,
          messageNumber: 2n,
          remoteNumber: 1n,
          unackedMessages: [{ msgno: 1n, msg: new Uint8Array([index]) }],
          createdAt: Date.now() + index,
        }),
      ),
    );

    expect(await readRejectionTombstones()).toEqual([
      expect.objectContaining({ peerId: 'peer-a', sessionId }),
      expect.objectContaining({ peerId: 'peer-b', sessionId }),
    ]);
  });

  it('retains empty inbound receipts and expires stale rejection records', async () => {
    const now = Date.now();
    await writeRejectionTombstone({
      kind: 'inbound-receipt',
      peerId: 'expired-peer',
      sessionId: 'cd'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 4n,
      unackedMessages: [],
      createdAt: now - REJECTION_TOMBSTONE_TTL_MS - 1,
    });
    await writeRejectionTombstone({
      kind: 'inbound-receipt',
      peerId: 'current-peer',
      sessionId: 'ef'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 7n,
      unackedMessages: [],
      createdAt: now,
    });

    expect(await readRejectionTombstones()).toEqual([
      expect.objectContaining({
        kind: 'inbound-receipt',
        peerId: 'current-peer',
        remoteNumber: 7n,
        unackedMessages: [],
      }),
    ]);
  });

  it('atomically replaces the active session with an inbound rejection receipt', async () => {
    saveLiveFields();
    await flushSessionSave();
    await clearSessionWithInboundRejectionReceipt({
      peerId: 'rejecting-peer',
      sessionId: '12'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 6n,
      unackedMessages: [],
      createdAt: Date.now(),
    });

    _resetForTests();
    expect(await peekSession()).toBeNull();
    expect(await readRejectionTombstones()).toEqual([
      expect.objectContaining({
        kind: 'inbound-receipt',
        peerId: 'rejecting-peer',
        remoteNumber: 6n,
      }),
    ]);
  });

  it('sets the saved-session marker when a resumable record is written', async () => {
    expect(hasSavedSessionMarker()).toBe(false);

    saveLiveFields();
    await flushSessionSave();
    expect(hasSavedSessionMarker()).toBe(true);

    await clearSession();
    expect(hasSavedSessionMarker()).toBe(false);
  });

  it('keeps an explicit pre-game marker across blockchainType preference writes', async () => {
    markSavedSession();
    savePreferences({ blockchainType: 'simulator' });
    await flushSessionSave();

    expect(hasSavedSessionMarker()).toBe(true);
    expect(await peekSession()).toMatchObject({
      preferences: { blockchainType: 'simulator' },
    });
  });

  it('treats leftover blockchainType without a marker as resume-worthy', async () => {
    savePreferences({ blockchainType: 'walletconnect' });
    await flushSessionSave();
    clearSavedSessionMarker();

    expect(shouldOfferResumeOrStartOver()).toBe(true);
    expect(await peekSession()).toMatchObject({
      preferences: { blockchainType: 'walletconnect' },
    });
    expect(hasSavedSessionMarker()).toBe(true);
  });

  it('treats leftover hubUrl without a marker as resume-worthy', async () => {
    savePreferences({ hubUrl: 'http://localhost:3003' });
    await flushSessionSave();
    clearSavedSessionMarker();

    expect(shouldOfferResumeOrStartOver()).toBe(true);
    expect(await peekSession()).toMatchObject({
      preferences: { hubUrl: 'http://localhost:3003' },
    });
    expect(hasSavedSessionMarker()).toBe(true);
  });

  it('shouldOfferResumeOrStartOver is false on a clean slate', () => {
    expect(shouldOfferResumeOrStartOver()).toBe(false);
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
    await flushSessionSave();
    expect(hasSavedSessionMarker()).toBe(true);

    // Simulate marker-only boot: memory has preferences, IndexedDB has the cradle.
    _resetForTests();
    expect(hasSavedSessionMarker()).toBe(true);
    expect(loadState()).not.toHaveProperty('live');

    saveHistory({ diagnosticLog: ['boot log'] });
    await flushSessionSave();

    _resetForTests();
    const loaded = requireLive(await peekSession());
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
    await flushSessionSave();

    saveLiveFields({
      ...sampleSession,
      serializedGameSession: second,
      pairingToken: 'tok-v2',
    });
    await flushSessionSave();

    _resetForTests();
    const loaded = requireLive(await peekSession());
    expect(loaded.live.serializedGameSession).toEqual(second);
    expect(loaded.pairing.token).toBe('tok-v2');
  });

  it('returns a pre-game blockchainType record when the boot marker is set', async () => {
    localStorage.setItem('appState_savedSession', '1');
    await writeSessionRecord(baseSave({ playerId: 'player', blockchainType: 'simulator' }));
    expect(await peekSession()).toMatchObject({
      preferences: { blockchainType: 'simulator' },
    });
    expect(hasSavedSessionMarker()).toBe(true);
  });

  it('clears the marker for a present but empty IndexedDB record', async () => {
    localStorage.setItem('appState_savedSession', '1');
    await writeSessionRecord(baseSave({ playerId: 'player' }));
    expect(await peekSession()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(false);
  });

  it('propagates IndexedDB write failure to durability callers', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    clearTestGlobal('indexedDB');
    try {
      const scheduled = saveLiveFields();

      await expect(flushSessionSave()).rejects.toThrow('IndexedDB is unavailable');
      await expect(scheduled).rejects.toThrow('IndexedDB is unavailable');
      expect(spy).toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      setTestGlobal('indexedDB', testIndexedDb);
    }
  });

  it('keeps serialized session bytes out of localStorage', async () => {
    saveLiveFields();
    await flushSessionSave();

    expect(localStorage.getItem('appState')).toBeNull();
    const localValues = Array.from({ length: localStorage.length }, (_, i) =>
      localStorage.getItem(localStorage.key(i)!),
    ).join('\n');
    expect(localValues).not.toMatch(
      /serializedGameSession|unackedMessages|\$bytes|000102ff|AAEC\/w==/,
    );
  });

  it('persists only the configured recent history entries', async () => {
    saveLiveFields({
      ...sampleSession,
      humanHistory: Array.from({ length: HUMAN_HISTORY_LIMIT + 2 }, (_, i) => `human-${i}`),
      wasmNotificationHistory: Array.from(
        { length: WASM_NOTIFICATION_HISTORY_LIMIT + 2 },
        (_, i) => `wasm-${i}`,
      ),
      diagnosticLog: Array.from({ length: DIAGNOSTIC_LOG_LIMIT + 2 }, (_, i) => `diag-${i}`),
    });
    await flushSessionSave();
    _resetForTests();

    const loaded = requireLive(await peekSession());
    expect(loaded.history.humanHistory).toHaveLength(HUMAN_HISTORY_LIMIT);
    expect(loaded.history.humanHistory?.[0]).toBe('human-2');
    expect(loaded.history.wasmNotificationHistory).toHaveLength(WASM_NOTIFICATION_HISTORY_LIMIT);
    expect(loaded.history.wasmNotificationHistory?.[0]).toBe('wasm-2');
    expect(loaded.history.diagnosticLog).toHaveLength(DIAGNOSTIC_LOG_LIMIT);
    expect(loaded.history.diagnosticLog?.[0]).toBe('diag-2');
  });

  it('returns null when nothing is saved', async () => {
    expect(await peekSession()).toBeNull();
  });

  it('clearSession asynchronously deletes resumable state', async () => {
    saveLiveFields();
    await flushSessionSave();
    await clearSession();
    _resetForTests();
    expect(await peekSession()).toBeNull();
  });

  it('saveSession preserves blockchainType', async () => {
    saveLiveFields({ ...sampleSession, blockchainType: 'walletconnect' });
    await flushSessionSave();
    expect((await peekSession())?.preferences.blockchainType).toBe('walletconnect');
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
    getPlayerId();
    expect(() => saveLiveFields()).not.toThrow();
    spy.mockRestore();
  });
});
