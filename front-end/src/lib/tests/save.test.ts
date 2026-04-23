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

const sampleSession: Partial<SessionState> = {
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
  it('round-trips session fields through save and peek', () => {
    saveSession(sampleSession);
    const loaded = peekSession();
    expect(loaded).toMatchObject({ ...sampleSession, buildNonce: '/app/test-nonce/' });
  });

  it('returns null when nothing is saved', () => {
    expect(peekSession()).toBeNull();
  });

  it('clearSession causes peekSession to return null', () => {
    saveSession(sampleSession);
    clearSession();
    expect(peekSession()).toBeNull();
  });

  it('peekSession returns stale saves as-is; callers check buildNonce', () => {
    saveSession(sampleSession);
    const first = peekSession();
    expect(first?.buildNonce).toBe('/app/test-nonce/');

    (global as any).__buildNonce = '/app/different-nonce/';
    const stale = peekSession();
    expect(stale).not.toBeNull();
    expect(stale!.buildNonce).toBe('/app/test-nonce/');
    expect(stale!.buildNonce).not.toBe(getBuildNonce());
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
    (global as any).localStorage = storage;
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

  it('clearSession generates a new playerId', () => {
    const oldId = getPlayerId();
    clearSession();
    const newId = getPlayerId();
    expect(newId).toBeTruthy();
    expect(newId).not.toBe(oldId);
  });

  it('clearSession wipes everything', () => {
    getSessionId();
    saveSession({ ...sampleSession, blockchainType: 'simulator' });
    setAlias('MyName');

    clearSession();

    expect(loadAppState().sessionId).toBeUndefined();
    expect(getBlockchainType()).toBeUndefined();
    expect(peekSession()).toBeNull();
    expect(loadAppState().alias).toBeUndefined();
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
    expect(state.buildNonce).toBe('/app/test-nonce/');
  });

  it('version field is set on fresh state', () => {
    const state = loadAppState();
    expect(state.version).toBe(3);
  });

  it('old version data is treated as fresh start', () => {
    _writeRawState({ version: 2, playerId: 'old-player' });
    const state = loadAppState();
    expect(state.playerId).not.toBe('old-player');
    expect(state.version).toBe(3);
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
