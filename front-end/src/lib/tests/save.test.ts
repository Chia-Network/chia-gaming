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
  getBlockchainType,
  loadAppState,
  getAlias,
  setAlias,
  getTheme,
  setTheme,
  getBuildNonce,
  SessionSave,
  _resetForTests,
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
  history: ['log1'],
  log: ['dbg1'],
};

beforeEach(() => {
  _resetForTests();
  (global as any).localStorage = makeStorage();
  (global as any).__buildNonce = '/app/test-nonce/';
});

afterEach(() => {
  delete (global as any).localStorage;
  delete (global as any).__buildNonce;
});

describe('session persistence', () => {
  it('round-trips a SessionSave through save and peek', () => {
    saveSession(sampleSession);
    const loaded = peekSession();
    expect(loaded).toEqual({ ...sampleSession, buildNonce: '/app/test-nonce/' });
  });

  it('returns null when nothing is saved', () => {
    expect(peekSession()).toBeNull();
  });

  it('clearSession causes peekSession to return null', () => {
    saveSession(sampleSession);
    clearSession();
    expect(peekSession()).toBeNull();
  });

  it('peekSession returns stale saves as-is; callers are expected to check buildNonce', () => {
    saveSession(sampleSession);
    const first = peekSession();
    expect(first?.buildNonce).toBe('/app/test-nonce/');

    (global as any).__buildNonce = '/app/different-nonce/';
    const stale = peekSession();
    // Pure read: save is still returned even though build nonce no longer matches.
    expect(stale).not.toBeNull();
    expect(stale!.buildNonce).toBe('/app/test-nonce/');
    expect(stale!.buildNonce).not.toBe(getBuildNonce());
  });

  it('saveSession preserves blockchainType from the save object', () => {
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
    (global as any).localStorage = storage;
    getPlayerId();
    expect(() => saveSession(sampleSession)).not.toThrow();
    spy.mockRestore();
  });
});

describe('unified app state', () => {
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

  it('clearSession preserves playerId and alias but clears session-scoped fields', () => {
    const playerId = getPlayerId();
    getSessionId();
    saveSession({ ...sampleSession, blockchainType: 'simulator' });
    setAlias('MyName');

    clearSession();

    expect(getPlayerId()).toBe(playerId);
    expect(loadAppState().sessionId).toBeUndefined();
    expect(getBlockchainType()).toBeUndefined();
    expect(peekSession()).toBeNull();
    expect(loadAppState().alias).toBe('MyName');
  });

  it('getBlockchainType reads from gameSave', () => {
    expect(getBlockchainType()).toBeUndefined();
    saveSession({ blockchainType: 'walletconnect' });
    expect(getBlockchainType()).toBe('walletconnect');
  });

  it('saveSession stores gameSave inside the unified state', () => {
    saveSession(sampleSession);
    const state = loadAppState();
    expect(state.gameSave).toEqual({ ...sampleSession, buildNonce: '/app/test-nonce/' });
  });

  it('version field is set on fresh state', () => {
    const state = loadAppState();
    expect(state.version).toBe(2);
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

describe('migration from old keys', () => {
  it('migrates playerId, sessionId, and sessionSave from old keys', () => {
    const oldSave = { ...sampleSession, uniqueId: 'old-player', blockchainType: 'simulator' as const };
    localStorage.setItem('playerId', 'old-player');
    localStorage.setItem('sessionId', 'old-session');
    localStorage.setItem('sessionSave', JSON.stringify(oldSave));

    const state = loadAppState();
    expect(state.playerId).toBe('old-player');
    expect(state.sessionId).toBe('old-session');
    expect(state.gameSave).toBeDefined();
    expect(state.gameSave!.blockchainType).toBe('simulator');
    expect((state.gameSave as any).uniqueId).toBeUndefined();

    expect(localStorage.getItem('playerId')).toBeNull();
    expect(localStorage.getItem('sessionId')).toBeNull();
    expect(localStorage.getItem('sessionSave')).toBeNull();
  });

  it('migrates playerId alone when no session exists', () => {
    localStorage.setItem('playerId', 'solo-player');
    const state = loadAppState();
    expect(state.playerId).toBe('solo-player');
    expect(state.gameSave).toBeUndefined();
    expect(localStorage.getItem('playerId')).toBeNull();
  });

  it('migrates from v1 persistedState key', () => {
    localStorage.setItem('persistedState', JSON.stringify({ playerId: 'v1-player', sessionId: 'v1-sess' }));
    const state = loadAppState();
    expect(state.playerId).toBe('v1-player');
    expect(state.sessionId).toBe('v1-sess');
    expect(state.version).toBe(2);
    expect(localStorage.getItem('persistedState')).toBeNull();
  });

  it('does not re-migrate when appState already exists', () => {
    const appState = { version: 2, playerId: 'new-player' };
    localStorage.setItem('appState', JSON.stringify(appState));
    localStorage.setItem('playerId', 'should-be-ignored');
    const state = loadAppState();
    expect(state.playerId).toBe('new-player');
  });

  it('migrates alias and theme from old keys', () => {
    localStorage.setItem('playerId', 'test-player');
    localStorage.setItem('alias', 'OldAlias');
    localStorage.setItem('theme', 'dark');
    const state = loadAppState();
    expect(state.alias).toBe('OldAlias');
    expect(state.theme).toBe('dark');
    expect(localStorage.getItem('alias')).toBeNull();
    expect(localStorage.getItem('theme')).toBeNull();
  });

  it('migrates saved games from saveNames/save-{id}', () => {
    localStorage.setItem('playerId', 'test-player');
    localStorage.setItem('saveNames', 'g1,g2');
    localStorage.setItem('save-g1', JSON.stringify({ id: 'g1', searchParams: {}, url: '' }));
    localStorage.setItem('save-g2', JSON.stringify({ id: 'g2', searchParams: {}, url: '' }));
    const state = loadAppState();
    expect(state.savedGames).toHaveLength(2);
    expect(state.savedGames![0].id).toBe('g1');
    expect(state.savedGames![1].id).toBe('g2');
    expect(localStorage.getItem('saveNames')).toBeNull();
    expect(localStorage.getItem('save-g1')).toBeNull();
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
