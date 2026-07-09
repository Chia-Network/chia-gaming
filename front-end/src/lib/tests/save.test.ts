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
  SessionState,
  _resetForTests,
  _writeRawState,
} from '../../hooks/save';

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
  serializedCradle: '{"some":"data"}',
  pairingToken: 'tok-123',
  messageNumber: 5n,
  remoteNumber: 3n,
  channelReady: true,
  iStarted: true,
  amount: '100',
  perGameAmount: '10',
  unackedMessages: [{ msgno: 4n, msg: 'hello' }],
  history: ['log1'],
  log: ['dbg1'],
};

beforeEach(() => {
  _resetForTests();
  setTestGlobal('localStorage', makeStorage());
  setTestGlobal('sessionStorage', makeStorage());
});

afterEach(() => {
  clearTestGlobal('localStorage');
  clearTestGlobal('sessionStorage');
  clearTestGlobal('indexedDB');
});

describe('session persistence', () => {
  it('round-trips session fields through save and peek', () => {
    saveSession(sampleSession);
    const loaded = peekSession();
    expect(loaded).toMatchObject(sampleSession);
  });

  it('returns null when nothing is saved', () => {
    expect(peekSession()).toBeNull();
  });

  it('clearSession causes peekSession to return null', () => {
    saveSession(sampleSession);
    clearSession();
    expect(peekSession()).toBeNull();
  });

  it('saveSession preserves blockchainType', () => {
    saveSession({ ...sampleSession, blockchainType: 'walletconnect' });
    expect(peekSession()?.blockchainType).toBe('walletconnect');
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

  it('clearSession wipes game state but preserves identity, preferences, and blockchainType', () => {
    const sid = getSessionId();
    saveSession({ ...sampleSession, blockchainType: 'simulator' });
    setAlias('MyName');

    clearSession();

    expect(loadAppState().sessionId).toBe(sid);
    expect(getBlockchainType()).toBe('simulator');
    expect(peekSession()).not.toBeNull();
    expect(peekSession()!.serializedCradle).toBeUndefined();
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
    expect(state.version).toBe(3n);
  });

  it('old version data is treated as fresh start', () => {
    _writeRawState({ version: 2, playerId: 'old-player' });
    const state = loadAppState();
    expect(state.playerId).not.toBe('old-player');
    expect(state.version).toBe(3n);
  });

  it('preserves bigint types through lossless JSON round-trip', () => {
    _writeRawState({
      version: 3,
      playerId: 'p1',
      messageNumber: 5,
      remoteNumber: 3,
      unackedMessages: [{ msgno: 4, msg: 'hello' }],
      handState: {
        gameType: 'calpoker',
        version: 1,
        state: {
          playerHand: [1, 2],
          opponentHand: [3, 4],
          moveNumber: 2,
          isPlayerTurn: true,
          cardSelections: [1],
          displaySnapshot: {
            gameState: 'selecting',
            winner: null,
            playerBestHandCardIds: [1],
            opponentBestHandCardIds: [3],
            playerHaloCardIds: [2],
            opponentHaloCardIds: [4],
            playerDisplayText: 'player',
            opponentDisplayText: 'opponent',
          },
        },
      },
    });

    const state = loadAppState();
    const handState = state.handState?.state as any;

    expect(typeof state.messageNumber).toBe('bigint');
    expect(typeof state.remoteNumber).toBe('bigint');
    expect(typeof state.unackedMessages?.[0].msgno).toBe('bigint');
    expect(state.handState?.gameType).toBe('calpoker');
    expect(typeof state.handState?.version).toBe('bigint');
    expect(typeof handState.moveNumber).toBe('bigint');
    expect(typeof handState.playerHand[0]).toBe('bigint');
    expect(typeof handState.displaySnapshot.playerBestHandCardIds[0]).toBe('bigint');
  });

  it('round-trips large bigint values through persisted state without precision loss', () => {
    const huge = 9_007_199_254_740_993n;
    saveSession({
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
    flushSessionState();
    _resetForTests();

    const state = loadAppState();
    const handState = state.handState?.state as any;

    expect(state.defaultFee).toBe(huge);
    expect(handState.gameState.N).toBe(huge);
    expect(handState.playerHoleCards[1]).toBe(huge + 1n);
    expect(handState.halfPot).toBe(huge + 2n);
  });

  it('preserves Calpoker hand arrays as bigint through round-trip', () => {
    _writeRawState({
      version: 3,
      playerId: 'p1',
      handState: {
        gameType: 'calpoker',
        version: 1,
        state: {
          playerHand: [8, 7, 6, 5],
          opponentHand: [4, 3, 2, 1],
          moveNumber: 1,
          isPlayerTurn: true,
          cardSelections: [8, 7],
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

    const handState = loadAppState().handState?.state as any;

    expect(handState.playerHand).toEqual([8n, 7n, 6n, 5n]);
    expect(handState.opponentHand).toEqual([4n, 3n, 2n, 1n]);
    expect(handState.cardSelections).toEqual([8n, 7n]);
  });
});

describe('hard reset', () => {
  it('clears localStorage, sessionStorage, and cached session state', () => {
    saveSession({ ...sampleSession, blockchainType: 'walletconnect' });
    sessionStorage.setItem('appState_tabId', 'tab-1');

    hardReset();

    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
    expect(peekSession()).toBeNull();
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
