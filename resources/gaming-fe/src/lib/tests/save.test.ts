import {
  saveSession,
  loadSession,
  clearSession,
  startNewSession,
  saveGame,
  loadSave,
  getSaveList,
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
  uniqueId: 'alice',
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
    (global as any).localStorage = {
      ...makeStorage(),
      setItem: () => { throw new DOMException('quota exceeded'); },
    };
    expect(() => saveSession(sampleSession)).not.toThrow();
    spy.mockRestore();
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
