import 'fake-indexeddb/auto';
import {
  saveSession,
  peekSession,
  clearSession,
  startNewSession,
  saveGame,
  loadSave,
  getSaveList,
  getPlayerId,
  getSessionId,
  clearSessionId,
  getBlockchainType,
  loadAppState,
  getAlias,
  setAlias,
  getTheme,
  setTheme,
  hardReset,
  flushSessionState,
  getTrackerAlert,
  setTrackerAlert,
  claimLease,
  checkLease,
  isLeaseConflict,
  SessionState,
  _resetForTests,
  _writeRawState,
} from '../../hooks/save';
import { SESSION_DB_NAME, writeSessionRecord } from '../session/indexedDb';
import {
  DIAGNOSTIC_LOG_LIMIT,
  HUMAN_HISTORY_LIMIT,
  WASM_NOTIFICATION_HISTORY_LIMIT,
} from '../session/historyLimits';

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

const sampleSession: Partial<SessionState> = {
  serializedCradle: new Uint8Array([0, 1, 2, 255]),
  pairingToken: 'tok-123',
  messageNumber: 5n,
  remoteNumber: 3n,
  channelReady: true,
  iStarted: true,
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
    } as Partial<SessionState>);
    await flushSessionState();

    const stored = await new Promise<{ count: number; record: SessionState & { rawBuffer: ArrayBuffer } }>(
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
              record: record.result as SessionState & { rawBuffer: ArrayBuffer },
            });
          };
        };
      },
    );

    expect(stored.count).toBe(1);
    expect(stored.record.serializedCradle).toBeInstanceOf(Uint8Array);
    expect(stored.record.rawBuffer).toBeInstanceOf(ArrayBuffer);
    expect(new Uint8Array(stored.record.rawBuffer)).toEqual(new Uint8Array([9, 8, 7]));
    expect(typeof stored.record.messageNumber).toBe('bigint');

    _resetForTests();
    const loaded = await peekSession() as (SessionState & { rawBuffer: ArrayBuffer }) | null;
    expect(loaded).toMatchObject(sampleSession);
    expect(loaded?.serializedCradle).toBeInstanceOf(Uint8Array);
    expect(loaded?.rawBuffer).toBeInstanceOf(ArrayBuffer);
    expect(loaded?.unackedMessages?.[0].msg).toBeInstanceOf(Uint8Array);
    expect(typeof loaded?.messageNumber).toBe('bigint');
    expect(loaded).not.toHaveProperty('history');
    expect(loaded).not.toHaveProperty('log');
  });

  it('propagates IndexedDB write failure to durability callers', async () => {
    clearTestGlobal('indexedDB');
    const scheduled = saveSession(sampleSession);

    await expect(flushSessionState()).rejects.toThrow('IndexedDB is unavailable');
    await expect(scheduled).rejects.toThrow('IndexedDB is unavailable');
    setTestGlobal('indexedDB', testIndexedDb);
  });

  it('keeps serialized session bytes out of localStorage', async () => {
    saveSession(sampleSession);
    await flushSessionState();

    expect(localStorage.getItem('appState')).toBeNull();
    const localValues = Array.from(
      { length: localStorage.length },
      (_, i) => localStorage.getItem(localStorage.key(i)!),
    ).join('\n');
    expect(localValues).not.toMatch(/serializedCradle|unackedMessages|\$bytes|000102ff|AAEC\/w==/);
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
    await flushSessionState();
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
    await flushSessionState();
    await clearSession();
    _resetForTests();
    expect(await peekSession()).toBeNull();
  });

  it('saveSession preserves blockchainType', async () => {
    saveSession({ ...sampleSession, blockchainType: 'walletconnect' });
    await flushSessionState();
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

  it('clearSessionId wipes only the tracker session ID', () => {
    const id = getSessionId();
    setAlias('MyName');

    clearSessionId();

    expect(loadAppState().sessionId).toBeUndefined();
    expect(loadAppState().alias).toBe('MyName');
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

  it('clearSession wipes game state but preserves identity, preferences, and blockchainType', async () => {
    const sid = getSessionId();
    saveSession({ ...sampleSession, blockchainType: 'simulator' });
    setAlias('MyName');

    await clearSession();

    expect(loadAppState().sessionId).toBe(sid);
    expect(getBlockchainType()).toBe('simulator');
    const remaining = await peekSession();
    expect(remaining).toBeNull();
    expect(loadAppState().alias).toBe('MyName');
  });

  it('getBlockchainType reads from flat state', () => {
    expect(getBlockchainType()).toBeUndefined();
    saveSession({ blockchainType: 'walletconnect' });
    expect(getBlockchainType()).toBe('walletconnect');
  });

  it('saveSession merges fields into the flat state', () => {
    saveSession(sampleSession);
    const state = loadAppState();
    expect(state.serializedCradle).toBe(sampleSession.serializedCradle);
    expect(state.pairingToken).toBe(sampleSession.pairingToken);
  });

  it('version field is set on fresh state', () => {
    const state = loadAppState();
    expect(state.version).toBe(5n);
  });

  it('deletes stale appState wholesale without decoding it', async () => {
    _writeRawState({ version: 2, playerId: 'old-player' });
    await peekSession();
    expect(localStorage.getItem('appState')).toBeNull();
    expect(loadAppState().playerId).not.toBe('old-player');
  });

  it('rejects and deletes a stale IndexedDB record', async () => {
    localStorage.setItem('appState_savedSession', '1');
    await writeSessionRecord({
      version: 4n,
      playerId: 'old-player',
      serializedCradle: new Uint8Array([1]),
    });
    expect(await peekSession()).toBeNull();
    expect(localStorage.getItem('appState_savedSession')).toBeNull();
    _resetForTests();
    expect(await peekSession()).toBeNull();
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
    await flushSessionState();
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
    await flushSessionState();
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

    hardReset();

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    await flushPromises();
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

    hardReset();
    await flushPromises();

    expect(deleteDatabase).toHaveBeenCalledWith('app-state');
    expect(deleteDatabase).toHaveBeenCalledWith('WALLET_CONNECT_V2_INDEXED_DB');
    expect(deleteDatabase).toHaveBeenCalledTimes(2);
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

    hardReset();
    await flushPromises();

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
      deleteDatabase: jest.fn(),
    });

    expect(() => hardReset()).not.toThrow();
    await flushPromises();

    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});

describe('alias and theme', () => {
  it('getAlias generates a default and persists it', () => {
    const alias = getAlias();
    expect(alias).toMatch(/^Player_/);
    expect(getAlias()).toBe(alias);
    expect(loadAppState().alias).toBe(alias);
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

describe('tracker alert', () => {
  it('getTrackerAlert returns false initially', () => {
    expect(getTrackerAlert()).toBe(false);
  });

  it('setTrackerAlert / getTrackerAlert round-trip', () => {
    setTrackerAlert(true);
    expect(getTrackerAlert()).toBe(true);
    setTrackerAlert(false);
    expect(getTrackerAlert()).toBe(false);
  });
});

describe('game saves', () => {
  it('startNewSession clears all game saves', () => {
    saveGame({ id: 'g1', searchParams: {}, url: '' });
    saveGame({ id: 'g2', searchParams: {}, url: '' });
    expect(getSaveList()).toEqual(['g2', 'g1']);

    startNewSession();
    expect(getSaveList()).toEqual([]);
    expect(loadSave('g1')).toBeUndefined();
    expect(loadSave('g2')).toBeUndefined();
  });

  it('saveGame caps at 3 entries, evicting oldest', () => {
    saveGame({ id: 'a', searchParams: {}, url: '' });
    saveGame({ id: 'b', searchParams: {}, url: '' });
    saveGame({ id: 'c', searchParams: {}, url: '' });
    expect(getSaveList()).toEqual(['c', 'b', 'a']);

    saveGame({ id: 'd', searchParams: {}, url: '' });
    expect(getSaveList()).toEqual(['d', 'c', 'b']);
    expect(loadSave('a')).toBeUndefined();
  });

  it('loadSave returns undefined for unknown id', () => {
    expect(loadSave('nonexistent')).toBeUndefined();
  });
});
