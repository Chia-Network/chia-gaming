import {
  saveSession,
  loadSession,
  clearSession,
  startNewSession,
  saveGame,
  loadSave,
  getSaveList,
  getPlayerId,
  getSessionId,
  setBlockchainType,
  getBlockchainType,
  loadPersistedState,
  SessionSave,
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

const sampleSession: SessionSave = {
  serializedCradle: '{"some":"data"}',
  pairingToken: 'tok-123',
  messageNumber: 5,
  remoteNumber: 3,
  channelReady: true,
  iStarted: true,
  amount: '100',
  perGameAmount: '10',
  pendingTransactions: ['tx1'],
  unackedMessages: [{ msgno: 4, msg: 'hello' }],
  gameLog: ['log1'],
  debugLog: ['dbg1'],
};

beforeEach(() => {
  (global as any).localStorage = makeStorage();
});

afterEach(() => {
  delete (global as any).localStorage;
});

describe('session persistence', () => {
  it('round-trips a SessionSave through save and load', () => {
    saveSession(sampleSession);
    const loaded = loadSession();
    expect(loaded).toEqual(sampleSession);
  });

  it('returns null when nothing is saved', () => {
    expect(loadSession()).toBeNull();
  });

  it('clearSession causes loadSession to return null', () => {
    saveSession(sampleSession);
    clearSession();
    expect(loadSession()).toBeNull();
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
    (global as any).localStorage = storage;
    getPlayerId();
    expect(() => saveSession(sampleSession)).not.toThrow();
    spy.mockRestore();
  });
});

describe('unified persisted state', () => {
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

  it('clearSession preserves playerId but clears session-scoped fields', () => {
    const playerId = getPlayerId();
    getSessionId();
    setBlockchainType('simulator');
    saveSession(sampleSession);

    clearSession();

    expect(getPlayerId()).toBe(playerId);
    expect(loadPersistedState().sessionId).toBeUndefined();
    expect(getBlockchainType()).toBeUndefined();
    expect(loadSession()).toBeNull();
  });

  it('setBlockchainType / getBlockchainType round-trip', () => {
    expect(getBlockchainType()).toBeUndefined();
    setBlockchainType('walletconnect');
    expect(getBlockchainType()).toBe('walletconnect');
  });

  it('saveSession stores gameSave inside the unified state', () => {
    saveSession(sampleSession);
    const state = loadPersistedState();
    expect(state.gameSave).toEqual(sampleSession);
  });
});

describe('migration from old keys', () => {
  it('migrates playerId, sessionId, and sessionSave from old keys', () => {
    const oldSave = { ...sampleSession, uniqueId: 'old-player', blockchainType: 'simulator' as const };
    localStorage.setItem('playerId', 'old-player');
    localStorage.setItem('sessionId', 'old-session');
    localStorage.setItem('sessionSave', JSON.stringify(oldSave));

    const state = loadPersistedState();
    expect(state.playerId).toBe('old-player');
    expect(state.sessionId).toBe('old-session');
    expect(state.blockchainType).toBe('simulator');
    expect(state.gameSave).toBeDefined();
    expect((state.gameSave as any).uniqueId).toBeUndefined();
    expect((state.gameSave as any).blockchainType).toBeUndefined();

    expect(localStorage.getItem('playerId')).toBeNull();
    expect(localStorage.getItem('sessionId')).toBeNull();
    expect(localStorage.getItem('sessionSave')).toBeNull();
  });

  it('migrates playerId alone when no session exists', () => {
    localStorage.setItem('playerId', 'solo-player');
    const state = loadPersistedState();
    expect(state.playerId).toBe('solo-player');
    expect(state.gameSave).toBeUndefined();
    expect(localStorage.getItem('playerId')).toBeNull();
  });

  it('does not migrate when new key already exists', () => {
    localStorage.setItem('persistedState', JSON.stringify({ playerId: 'new-player' }));
    localStorage.setItem('playerId', 'should-be-ignored');
    const state = loadPersistedState();
    expect(state.playerId).toBe('new-player');
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
