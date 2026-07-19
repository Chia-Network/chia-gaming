import 'fake-indexeddb/auto';
import {
  saveSession,
  peekSession,
  clearSession,
  clearGameSessionPreservingHistory,
  getPlayerId,
  getSessionId,
  ensureHubIdentity,
  getMyHubPlayerId,
  clearSessionId,
  getBlockchainType,
  loadState,
  getAlias,
  setAlias,
  peekAlias,
  getTheme,
  setTheme,
  hardReset,
  flushSessionSave,
  getHubAlert,
  setHubAlert,
  claimLease,
  checkLease,
  isLeaseConflict,
  hasSavedSessionMarker,
  shouldOfferResumeOrStartOver,
  markSavedSession,
  clearSavedSessionMarker,
  markAutoResumeOnce,
  peekAutoResumeOnce,
  clearAutoResumeOnce,
  SessionSave,
  _resetForTests,
  _writeRawState,
} from '../../hooks/save';
import { SESSION_DB_NAME, writeSessionRecord } from '../session/indexedDb';
import {
  DIAGNOSTIC_LOG_LIMIT,
  HUMAN_HISTORY_LIMIT,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from '../session/historyLimits';
import { sessionAmountsFromSave } from '../session/model';

const testIndexedDb = indexedDB;

function makeStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
    clear: () => { store.clear(); },
    get length() { return store.size; },
    key: (i: number) => [...store.keys()][i] ?? null,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function setTestGlobal(key: string, value: unknown) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    writable: true,
    value,
  });
}

function clearTestGlobal(key: string) {
  Reflect.deleteProperty(globalThis, key);
}

const sampleSession: Partial<SessionSave> = {
  serializedGameSession: new Uint8Array([0, 1, 2, 255]),
  gameSessionSchemaVersion: 1n,
  pairingToken: 'tok-123',
  messageNumber: 5n,
  remoteNumber: 3n,
  channelReady: true,
  iStarted: true,
  activeGameIds: [],
  myContribution: '60',
  theirContribution: '40',
  perGameAmount: '10',
  unackedMessages: [{ msgno: 4n, msg: new Uint8Array([3, 4, 5]) }],
  humanHistory: ['human1'],
  wasmNotificationHistory: ['notification1'],
  diagnosticLog: ['dbg1'],
};

beforeEach(async () => {
  _resetForTests();
  setTestGlobal('localStorage', makeStorage());
  setTestGlobal('sessionStorage', makeStorage());
  setTestGlobal('indexedDB', testIndexedDb);
  await new Promise<void>((resolve) => {
    const request = indexedDB.deleteDatabase(SESSION_DB_NAME);
    request.onsuccess = () => resolve();
    request.onerror = () => resolve();
    request.onblocked = () => resolve();
  });
});

afterEach(() => {
  clearTestGlobal('localStorage');
  clearTestGlobal('sessionStorage');
});

describe('session persistence', () => {
  it('atomically round-trips one raw binary/bigint record through IndexedDB', async () => {
    const rawBuffer = Uint8Array.from([9, 8, 7]).buffer;
    saveSession({
      ...sampleSession,
      rawBuffer,
    } as Partial<SessionSave>);
    await flushSessionSave();

    const stored = await new Promise<{ count: number; record: SessionSave & { rawBuffer: ArrayBuffer } }>(
      (resolve, reject) => {
        const open = indexedDB.open(SESSION_DB_NAME, 1);
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
              record: record.result as SessionSave & { rawBuffer: ArrayBuffer },
            });
          };
        };
      },
    );

    expect(stored.count).toBe(1);
    expect(stored.record.serializedGameSession).toBeInstanceOf(Uint8Array);
    expect(stored.record.rawBuffer).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(stored.record.rawBuffer)).toEqual(new Uint8Array([9, 8, 7]));
    expect(typeof stored.record.messageNumber).toBe('bigint');

    _resetForTests();
    const loaded = await peekSession() as (SessionSave & { rawBuffer: ArrayBuffer }) | null;
    expect(loaded).toMatchObject(sampleSession);
    expect(loaded?.serializedGameSession).toBeInstanceOf(Uint8Array);
    expect(loaded?.rawBuffer).toBeInstanceOf(ArrayBuffer);
    expect(loaded?.unackedMessages?.[0].msg).toBeInstanceOf(Uint8Array);
    expect(typeof loaded?.messageNumber).toBe('bigint');
    expect(loaded).not.toHaveProperty('history');
    expect(loaded).not.toHaveProperty('log');
  });

  it('sets the saved-session marker when a resumable record is written', async () => {
    expect(hasSavedSessionMarker()).toBe(false);

    saveSession(sampleSession);
    await flushSessionSave();
    expect(hasSavedSessionMarker()).toBe(true);

    await clearSession();
    expect(hasSavedSessionMarker()).toBe(false);
  });

  it('keeps an explicit pre-game marker across blockchainType preference writes', async () => {
    markSavedSession();
    saveSession({ blockchainType: 'simulator' });
    await flushSessionSave();

    expect(hasSavedSessionMarker()).toBe(true);
    expect(await peekSession()).toMatchObject({ blockchainType: 'simulator' });
  });

  it('treats leftover blockchainType without a marker as resume-worthy', async () => {
    saveSession({ blockchainType: 'walletconnect' });
    await flushSessionSave();
    clearSavedSessionMarker();

    expect(shouldOfferResumeOrStartOver()).toBe(true);
    expect(await peekSession()).toMatchObject({ blockchainType: 'walletconnect' });
    expect(hasSavedSessionMarker()).toBe(true);
  });

  it('treats leftover hubUrl without a marker as resume-worthy', async () => {
    saveSession({ hubUrl: 'http://localhost:3003' });
    await flushSessionSave();
    clearSavedSessionMarker();

    expect(shouldOfferResumeOrStartOver()).toBe(true);
    expect(await peekSession()).toMatchObject({ hubUrl: 'http://localhost:3003' });
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
    saveSession(sampleSession);
    await flushSessionSave();
    expect(hasSavedSessionMarker()).toBe(true);

    // Simulate marker-only boot: memory has preferences, IndexedDB has the cradle.
    _resetForTests();
    expect(hasSavedSessionMarker()).toBe(true);
    expect(loadState().serializedGameSession).toBeUndefined();

    saveSession({ diagnosticLog: ['boot log'] });
    await flushSessionSave();

    _resetForTests();
    const loaded = await peekSession();
    expect(loaded?.serializedGameSession).toEqual(sampleSession.serializedGameSession);
    expect(loaded?.pairingToken).toBe(sampleSession.pairingToken);
    expect(loaded?.diagnosticLog).toEqual(['boot log']);
  });

  it('flush persists a newer in-memory cradle even when sessionId is unset', async () => {
    const first = new Uint8Array([1, 1, 1, 1]);
    const second = new Uint8Array([2, 2, 2, 2, 2, 2]);
    markSavedSession();
    saveSession({
      serializedGameSession: first,
      gameSessionSchemaVersion: 1n,
      pairingToken: 'tok-v1',
      // Intentionally omit sessionId — handshake saves often look like this.
    });
    await flushSessionSave();

    saveSession({
      serializedGameSession: second,
      gameSessionSchemaVersion: 1n,
      pairingToken: 'tok-v2',
    });
    await flushSessionSave();

    _resetForTests();
    const loaded = await peekSession();
    expect(loaded?.serializedGameSession).toEqual(second);
    expect(loaded?.pairingToken).toBe('tok-v2');
  });

  it('returns a pre-game blockchainType record when the boot marker is set', async () => {
    localStorage.setItem('appState_savedSession', '1');
    await writeSessionRecord({
      version: 8n,
      playerId: 'player',
      blockchainType: 'simulator',
    });
    expect(await peekSession()).toMatchObject({ blockchainType: 'simulator' });
    expect(hasSavedSessionMarker()).toBe(true);
  });

  it('keeps Resume marker for a finished channel snapshot without a live cradle', async () => {
    saveSession({
      blockchainType: 'simulator',
      hubUrl: 'http://localhost:3000',
      pairingToken: undefined,
      serializedGameSession: undefined,
      channelStatus: {
        state: 'ResolvedClean',
        advisory: null,
        coin: null,
        our_balance: '60',
        their_balance: '40',
        game_allocated: '0',
        have_potato: true,
      },
    });
    await flushSessionSave();

    expect(hasSavedSessionMarker()).toBe(true);
    _resetForTests();
    expect(hasSavedSessionMarker()).toBe(true);
    const loaded = await peekSession();
    expect(loaded?.channelStatus?.state).toBe('ResolvedClean');
    expect(loaded?.blockchainType).toBe('simulator');
    expect(hasSavedSessionMarker()).toBe(true);
  });

  it('clears the marker for a present but empty IndexedDB record', async () => {
    localStorage.setItem('appState_savedSession', '1');
    await writeSessionRecord({
      version: 8n,
      playerId: 'player',
    });
    expect(await peekSession()).toBeNull();
    expect(hasSavedSessionMarker()).toBe(false);
  });

  it('propagates IndexedDB write failure to durability callers', async () => {
    clearTestGlobal('indexedDB');
    const scheduled = saveSession(sampleSession);

    await expect(flushSessionSave()).rejects.toThrow('IndexedDB is unavailable');
    await expect(scheduled).rejects.toThrow('IndexedDB is unavailable');
    setTestGlobal('indexedDB', testIndexedDb);
  });

  it('keeps serialized session bytes out of localStorage', async () => {
    saveSession(sampleSession);
    await flushSessionSave();

    expect(localStorage.getItem('appState')).toBeNull();
    const localValues = Array.from(
      { length: localStorage.length },
      (_, i) => localStorage.getItem(localStorage.key(i)!),
    ).join('\n');
    expect(localValues).not.toMatch(/serializedGameSession|unackedMessages|\$bytes|000102ff|AAEC\/w==/);
  });

  it('persists only the configured recent history entries', async () => {
    saveSession({
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

    const loaded = await peekSession();
    expect(loaded?.humanHistory).toHaveLength(HUMAN_HISTORY_LIMIT);
    expect(loaded?.humanHistory?.[0]).toBe('human-2');
    expect(loaded?.wasmNotificationHistory).toHaveLength(WASM_NOTIFICATION_HISTORY_LIMIT);
    expect(loaded?.wasmNotificationHistory?.[0]).toBe('wasm-2');
    expect(loaded?.diagnosticLog).toHaveLength(DIAGNOSTIC_LOG_LIMIT);
    expect(loaded?.diagnosticLog?.[0]).toBe('diag-2');
  });

  it('returns null when nothing is saved', async () => {
    expect(await peekSession()).toBeNull();
  });

  it('clearSession asynchronously deletes resumable state', async () => {
    saveSession(sampleSession);
    await flushSessionSave();
    await clearSession();
    _resetForTests();
    expect(await peekSession()).toBeNull();
  });

  it('saveSession preserves blockchainType', async () => {
    saveSession({ ...sampleSession, blockchainType: 'walletconnect' });
    await flushSessionSave();
    expect((await peekSession())?.blockchainType).toBe('walletconnect');
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
    expect(() => saveSession(sampleSession)).not.toThrow();
    spy.mockRestore();
  });
});

describe('flat state', () => {
  it('getPlayerId generates and persists a player ID', () => {
    const id = getPlayerId();
    expect(id).toBeTruthy();
    expect(getPlayerId()).toBe(id);
  });

  it('getSessionId generates and persists a session ID', () => {
    const id = getSessionId();
    expect(id).toBeTruthy();
    expect(getSessionId()).toBe(id);
  });

  it('peekSession keeps preference sessionId when the IndexedDB record omits it', async () => {
    const sid = getSessionId();
    markSavedSession();
    // Durable resumable fields without sessionId (simulates older/partial IDB writes).
    saveSession({
      pairingToken: 'tok-keep-sid',
      myContribution: '100',
      theirContribution: '100',
      perGameAmount: '10',
      blockchainType: 'simulator',
    });
    await flushSessionSave();

    // Drop sessionId from the IDB record only; preferences still hold sid.
    const record = await new Promise<SessionSave>((resolve, reject) => {
      const open = indexedDB.open(SESSION_DB_NAME, 1);
      open.onerror = () => reject(open.error);
      open.onsuccess = () => {
        const db = open.result;
        const tx = db.transaction('session', 'readonly');
        const get = tx.objectStore('session').get('current');
        tx.oncomplete = () => {
          db.close();
          resolve(get.result as SessionSave);
        };
        tx.onerror = () => reject(tx.error);
      };
    });
    delete record.sessionId;
    await writeSessionRecord(record);

    _resetForTests();
    setTestGlobal('localStorage', makeStorage());
    // Re-seed preferences with the original sid (reset cleared module cache;
    // localStorage mock is fresh — write prefs as boot would see them).
    localStorage.setItem('appPreferences', JSON.stringify({
      playerId: 'player-keep-sid',
      sessionId: sid,
    }));
    localStorage.setItem('appState_savedSession', '1');

    const loaded = await peekSession();
    expect(loaded?.pairingToken).toBe('tok-keep-sid');
    expect(getSessionId()).toBe(sid);
  });

  it('ensureHubIdentity restores sessionId from IndexedDB when preferences omit it', async () => {
    const sid = getSessionId();
    markSavedSession();
    saveSession({
      pairingToken: 'tok-idb-sid',
      sessionId: sid,
      myContribution: '100',
      theirContribution: '100',
      perGameAmount: '10',
      blockchainType: 'simulator',
    });
    await flushSessionSave();

    _resetForTests();
    setTestGlobal('localStorage', makeStorage());
    // Prefs have no sessionId — the remint-before-hydrate bug would mint here.
    localStorage.setItem('appPreferences', JSON.stringify({
      playerId: 'player-idb-sid',
    }));
    localStorage.setItem('appState_savedSession', '1');

    expect(() => getSessionId()).toThrow(/before ensureHubIdentity/);
    const restored = await ensureHubIdentity();
    expect(restored).toBe(sid);
    expect(getSessionId()).toBe(sid);
  });

  it('persists myHubPlayerId in preferences and restores it across reload', async () => {
    const sid = getSessionId();
    markSavedSession();
    saveSession({
      pairingToken: 'tok-pid',
      sessionId: sid,
      myHubPlayerId: 'p_stable_abc',
      myContribution: '100',
      theirContribution: '100',
      perGameAmount: '10',
      blockchainType: 'simulator',
    });
    await flushSessionSave();

    const prefs = JSON.parse(localStorage.getItem('appPreferences')!);
    expect(prefs.myHubPlayerId).toBe('p_stable_abc');

    _resetForTests();
    setTestGlobal('localStorage', makeStorage());
    localStorage.setItem('appPreferences', JSON.stringify({
      playerId: 'player-local',
      sessionId: sid,
      myHubPlayerId: 'p_stable_abc',
    }));
    localStorage.setItem('appState_savedSession', '1');

    await ensureHubIdentity();
    expect(getMyHubPlayerId()).toBe('p_stable_abc');
    expect(getSessionId()).toBe(sid);
  });

  it('clearSessionId wipes only the hub session ID', () => {
    const id = getSessionId();
    setAlias('MyName');
    saveSession({ myHubPlayerId: 'p_to_clear' });

    clearSessionId();

    expect(loadState().sessionId).toBeUndefined();
    expect(loadState().myHubPlayerId).toBeUndefined();
    expect(loadState().alias).toBe('MyName');
    expect(getSessionId()).toBeTruthy();
    expect(getSessionId()).not.toBe(id);
  });

  it('clearSession preserves playerId', () => {
    const oldId = getPlayerId();
    clearSession();
    const newId = getPlayerId();
    expect(newId).toBeTruthy();
    expect(newId).toBe(oldId);
  });

  it('clearSession wipes game state but preserves identity, preferences, blockchainType, and boot marker', async () => {
    const sid = getSessionId();
    markSavedSession();
    saveSession({ ...sampleSession, blockchainType: 'simulator' });
    setAlias('MyName');
    await flushSessionSave();

    await clearSession();

    expect(loadState().sessionId).toBe(sid);
    expect(getBlockchainType()).toBe('simulator');
    expect(hasSavedSessionMarker()).toBe(true);
    const remaining = await peekSession();
    expect(remaining).not.toBeNull();
    expect(remaining?.blockchainType).toBe('simulator');
    expect(remaining?.pairingToken).toBeUndefined();
    expect(loadState().alias).toBe('MyName');
  });

  it('clearSession drops the boot marker when no blockchainType or hubUrl remains', async () => {
    markSavedSession();
    saveSession(sampleSession);
    await flushSessionSave();
    expect(getBlockchainType()).toBeUndefined();

    await clearSession();

    expect(hasSavedSessionMarker()).toBe(false);
    expect(await peekSession()).toBeNull();
  });

  it('clearSession keeps the boot marker when only hubUrl remains', async () => {
    markSavedSession();
    saveSession({ hubUrl: 'http://localhost:3003' });
    await flushSessionSave();

    await clearSession();

    expect(hasSavedSessionMarker()).toBe(true);
    expect(await peekSession()).toMatchObject({ hubUrl: 'http://localhost:3003' });
  });

  it('clearGameSessionPreservingHistory keeps logs, connection prefs, and pre-cradle handshake', async () => {
    markSavedSession();
    saveSession({
      ...sampleSession,
      blockchainType: 'simulator',
      hubUrl: 'http://localhost:3003',
      humanHistory: ['keep-me'],
      diagnosticLog: ['diag-keep'],
      sessionPeerId: 'peer-abc',
      gameSessionId: 'gs-1',
      channelTimeout: '100',
      unrollTimeout: '50',
      opponentAlias: 'Opponent',
    });
    await flushSessionSave();

    await clearGameSessionPreservingHistory();

    expect(hasSavedSessionMarker()).toBe(true);
    const remaining = await peekSession();
    expect(remaining?.blockchainType).toBe('simulator');
    expect(remaining?.hubUrl).toBe('http://localhost:3003');
    expect(remaining?.humanHistory).toEqual(['keep-me']);
    expect(remaining?.diagnosticLog).toEqual(['diag-keep']);
    expect(remaining?.serializedGameSession).toBeUndefined();
    // Handshake checkpoint survives so a reload mid-hex-load can Resume.
    expect(remaining?.pairingToken).toBe('tok-123');
    expect(remaining?.sessionPeerId).toBe('peer-abc');
    expect(remaining?.gameSessionId).toBe('gs-1');
    expect(remaining?.iStarted).toBe(true);
    expect(remaining?.myContribution).toBe('60');
    expect(remaining?.theirContribution).toBe('40');
    expect(remaining?.perGameAmount).toBe('10');
    expect(remaining?.channelTimeout).toBe('100');
    expect(remaining?.unrollTimeout).toBe('50');
    expect(remaining?.opponentAlias).toBe('Opponent');
  });

  it('pairingToken-only pending handshake is resumable without a cradle', async () => {
    saveSession({
      blockchainType: 'simulator',
      hubUrl: 'http://localhost:3003',
      pairingToken: 'peer_x_1',
      sessionPeerId: 'peer-x',
      gameSessionId: 'gs-pending',
      iStarted: false,
      myContribution: '100',
      theirContribution: '100',
      perGameAmount: '10',
      channelTimeout: '200',
      unrollTimeout: '80',
      humanHistory: ['accepted proposal'],
    });
    await flushSessionSave();

    expect(shouldOfferResumeOrStartOver()).toBe(true);
    const loaded = await peekSession();
    expect(loaded?.serializedGameSession).toBeUndefined();
    expect(loaded?.pairingToken).toBe('peer_x_1');
    expect(loaded?.myContribution).toBe('100');
    expect(loaded?.sessionPeerId).toBe('peer-x');
    expect(sessionAmountsFromSave(loaded!)).toEqual({
      myContribution: 100n,
      theirContribution: 100n,
      perGameAmount: 10n,
    });
  });

  it('getBlockchainType reads from flat state', () => {
    expect(getBlockchainType()).toBeUndefined();
    saveSession({ blockchainType: 'walletconnect' });
    expect(getBlockchainType()).toBe('walletconnect');
  });

  it('saveSession merges fields into the flat state', () => {
    saveSession(sampleSession);
    const state = loadState();
    expect(state.serializedGameSession).toBe(sampleSession.serializedGameSession);
    expect(state.pairingToken).toBe(sampleSession.pairingToken);
  });

  it('version field is set on fresh state', () => {
    const state = loadState();
    expect(state.version).toBe(8n);
  });

  it('deletes stale appState wholesale without decoding it', async () => {
    _writeRawState({ version: 2, playerId: 'old-player' });
    await peekSession();
    expect(localStorage.getItem('appState')).toBeNull();
    expect(loadState().playerId).not.toBe('old-player');
  });

  it('rejects and deletes a stale IndexedDB record but keeps the boot marker', async () => {
    localStorage.setItem('appState_savedSession', '1');
    await writeSessionRecord({
      version: 5n,
      playerId: 'old-player',
      serializedGameSession: new Uint8Array([1]),
    });
    expect(await peekSession()).toBeNull();
    expect(localStorage.getItem('appState_savedSession')).toBe('1');
  });

  it('clears a saved-session marker when no matching record exists', async () => {
    localStorage.setItem('appState_savedSession', '1');

    expect(await peekSession()).toBeNull();
    expect(localStorage.getItem('appState_savedSession')).toBeNull();
  });

  it('deletes an incompatible IndexedDB schema instead of migrating it', async () => {
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open(SESSION_DB_NAME, 2);
      request.onupgradeneeded = () => request.result.createObjectStore('stale');
      request.onsuccess = () => {
        request.result.close();
        resolve();
      };
      request.onerror = () => reject(request.error);
    });

    expect(await peekSession()).toBeNull();
    expect(await peekSession()).toBeNull();
  });

  it('round-trips large bigint values through persisted state without precision loss', async () => {
    const huge = 9_007_199_254_740_993n;
    saveSession({
      ...sampleSession,
      blockchainType: 'simulator',
      defaultFee: huge,
      handState: {
        gameType: 'spacepoker',
        version: 1n,
        state: {
          gameState: { handler: 2n, myTurn: true, N: huge },
          playerHoleCards: [huge, huge + 1n],
          halfPot: huge + 2n,
        },
      },
    });
    await flushSessionSave();
    _resetForTests();

    const state = (await peekSession())!;
    const handState = state.handState?.state as any;

    expect(state.defaultFee).toBe(huge);
    expect(handState.gameState.N).toBe(huge);
    expect(handState.playerHoleCards[1]).toBe(huge + 1n);
    expect(handState.halfPot).toBe(huge + 2n);
  });

  it('preserves Calpoker hand arrays as bigint through round-trip', async () => {
    saveSession({
      ...sampleSession,
      blockchainType: 'simulator',
      handState: {
        gameType: 'calpoker',
        version: 1n,
        state: {
          playerHand: [8n, 7n, 6n, 5n],
          opponentHand: [4n, 3n, 2n, 1n],
          moveNumber: 1n,
          isPlayerTurn: true,
          cardSelections: [8n, 7n],
          displaySnapshot: {
            gameState: 'selecting',
            winner: null,
            playerBestHandCardIds: [],
            opponentBestHandCardIds: [],
            playerHaloCardIds: [],
            opponentHaloCardIds: [],
            playerDisplayText: '',
            opponentDisplayText: '',
          },
        },
      },
    });
    await flushSessionSave();
    _resetForTests();

    const handState = (await peekSession())?.handState?.state as any;

    expect(handState.playerHand).toEqual([8n, 7n, 6n, 5n]);
    expect(handState.opponentHand).toEqual([4n, 3n, 2n, 1n]);
    expect(handState.cardSelections).toEqual([8n, 7n]);
  });
});

describe('tab lease', () => {
  it('detects a conflicting active-tab owner', () => {
    claimLease();
    expect(checkLease()).toBe(true);
    expect(isLeaseConflict()).toBe(false);

    localStorage.setItem('appState_activeTab', 'another-tab');

    expect(checkLease()).toBe(false);
    expect(isLeaseConflict()).toBe(true);
  });
});

describe('hard reset', () => {
  it('clears localStorage, sessionStorage, and cached session state', async () => {
    saveSession({ ...sampleSession, blockchainType: 'walletconnect' });
    sessionStorage.setItem('appState_tabId', 'tab-1');

    await hardReset();

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(await peekSession()).toBeNull();
  });

  it('starts deletion for every IndexedDB database returned by the browser', async () => {
    const deleteDatabase = jest.fn((_name: string) => {
      const request: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; error?: unknown } = {};
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    });
    setTestGlobal('indexedDB', {
      databases: jest.fn().mockResolvedValue([
        { name: 'app-state' },
        { name: 'WALLET_CONNECT_V2_INDEXED_DB' },
        { name: undefined },
      ]),
      deleteDatabase,
    });

    await hardReset();

    expect(deleteDatabase).toHaveBeenCalledWith(SESSION_DB_NAME);
    expect(deleteDatabase).toHaveBeenCalledWith('WALLET_CONNECT_V2_INDEXED_DB');
    expect(deleteDatabase).toHaveBeenCalledWith('app-state');
    expect(deleteDatabase).toHaveBeenCalledWith('walletconnect');
    expect(deleteDatabase).toHaveBeenCalledWith('walletconnect-v2');
  });

  it('deletes known IndexedDB databases when enumeration is unavailable (e.g. Safari)', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const deleteDatabase = jest.fn((_name: string) => {
      const request: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; error?: unknown } = {};
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    });
    // No `databases` function: mimics browsers that can't enumerate.
    setTestGlobal('indexedDB', { deleteDatabase });

    await hardReset();

    expect(deleteDatabase).toHaveBeenCalledWith(SESSION_DB_NAME);
    expect(deleteDatabase).toHaveBeenCalledWith('WALLET_CONNECT_V2_INDEXED_DB');
    expect(deleteDatabase).toHaveBeenCalledWith('walletconnect');
    expect(deleteDatabase).toHaveBeenCalledWith('walletconnect-v2');
    spy.mockRestore();
  });

  it('logs but does not throw when hard reset storage APIs fail', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const local = makeStorage();
    local.clear = () => { throw new Error('local clear failed'); };
    const session = makeStorage();
    session.clear = () => { throw new Error('session clear failed'); };
    setTestGlobal('localStorage', local);
    setTestGlobal('sessionStorage', session);
    setTestGlobal('indexedDB', {
      databases: jest.fn().mockRejectedValue(new Error('database list failed')),
      deleteDatabase: jest.fn((_name: string) => {
        const request: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; error?: unknown } = {};
        setTimeout(() => request.onsuccess?.(), 0);
        return request;
      }),
    });

    await expect(hardReset()).resolves.toBeUndefined();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('deletes known databases before waiting on enumeration', async () => {
    const deleteDatabase = jest.fn((_name: string) => {
      const request: { onsuccess?: () => void; onerror?: () => void; onblocked?: () => void; error?: unknown } = {};
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    });
    let releaseEnumeration: ((value: Array<{ name?: string }>) => void) | undefined;
    setTestGlobal('indexedDB', {
      databases: () => new Promise((resolve) => { releaseEnumeration = resolve; }),
      deleteDatabase,
    });

    const done = hardReset();
    // Known wipes must be requested without waiting for databases().
    expect(deleteDatabase).toHaveBeenCalledWith(SESSION_DB_NAME);
    expect(deleteDatabase).toHaveBeenCalledWith('WALLET_CONNECT_V2_INDEXED_DB');

    // Let known deleteDatabase requests settle so enumeration can start.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releaseEnumeration).toBeDefined();
    releaseEnumeration!([{ name: 'extra-unknown-db' }]);
    await done;
    expect(deleteDatabase).toHaveBeenCalledWith('extra-unknown-db');
  });
});

describe('alias and theme', () => {
  it('getAlias generates a default and persists it', () => {
    const alias = getAlias();
    expect(alias).toMatch(/^Player_/);
    expect(getAlias()).toBe(alias);
    expect(loadState().alias).toBe(alias);
  });

  it('peekAlias returns undefined until set, without inventing', () => {
    expect(peekAlias()).toBeUndefined();
    setAlias('MyName');
    expect(peekAlias()).toBe('MyName');
  });

  it('setAlias stores and retrieves', () => {
    setAlias('CustomName');
    expect(getAlias()).toBe('CustomName');
  });

  it('getTheme returns undefined initially', () => {
    expect(getTheme()).toBeUndefined();
  });

  it('setTheme / getTheme round-trip', () => {
    setTheme('dark');
    expect(getTheme()).toBe('dark');
    setTheme('light');
    expect(getTheme()).toBe('light');
  });
});

describe('hub alert', () => {
  it('getHubAlert returns false initially', () => {
    expect(getHubAlert()).toBe(false);
  });

  it('setHubAlert / getHubAlert round-trip', () => {
    setHubAlert(true);
    expect(getHubAlert()).toBe(true);
    setHubAlert(false);
    expect(getHubAlert()).toBe(false);
  });
});

describe('game saves', () => {


});
