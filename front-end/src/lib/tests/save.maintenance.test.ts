import {
  peekSession,
  loadState,
  getAlias,
  setAlias,
  peekAlias,
  getTheme,
  setTheme,
  hardReset,
  getHubAlert,
  setHubAlert,
  claimLease,
  checkLease,
  isLeaseConflict,
  releaseLeaseIfOwner,
} from '../../hooks/save';
import { SESSION_DB_NAME } from '../session/indexedDb';
import {
  startPendingWalletConnectWipe,
  _resetPendingWalletConnectWipeForTests,
} from '../../hooks/saveHardReset';
import {
  clearTestGlobal,
  makeStorage,
  sampleSession,
  saveLiveFields,
  setTestGlobal,
} from './save.harness';

describe('tab lease', () => {
  it('detects a conflicting active-tab owner', () => {
    claimLease();
    expect(checkLease()).toBe(true);
    expect(isLeaseConflict()).toBe(false);

    localStorage.setItem('appState_activeTab', 'another-tab');

    expect(checkLease()).toBe(false);
    expect(isLeaseConflict()).toBe(true);
  });

  it('clears the lease on close only when this tab still owns it', () => {
    claimLease();
    releaseLeaseIfOwner();
    expect(localStorage.getItem('appState_activeTab')).toBeNull();
    expect(checkLease()).toBe(true);
    expect(isLeaseConflict()).toBe(false);

    localStorage.setItem('appState_activeTab', 'another-tab');
    releaseLeaseIfOwner();
    expect(localStorage.getItem('appState_activeTab')).toBe('another-tab');
    expect(isLeaseConflict()).toBe(true);
  });

  it('ignores a lease orphaned by a previous run in the desktop build', () => {
    localStorage.setItem('appState_activeTab', 'previous-run');
    setTestGlobal('window', { __chiaDistribution: 'electron' });

    try {
      expect(isLeaseConflict()).toBe(false);
      expect(checkLease()).toBe(true);
    } finally {
      clearTestGlobal('window');
    }

    expect(isLeaseConflict()).toBe(true);
  });
});

describe('hard reset', () => {
  it('clears localStorage and cached session state, leaving only the deferred-wipe marker', async () => {
    saveLiveFields({ ...sampleSession, blockchainType: 'walletconnect' });
    sessionStorage.setItem('appState_tabId', 'tab-1');

    await hardReset();

    expect(localStorage.length).toBe(0);
    // Hard reset intentionally leaves one sessionStorage survivor: the marker
    // that tells the next boot to finish a WalletConnect IndexedDB wipe that a
    // live connection may have blocked here.
    expect(sessionStorage.length).toBe(1);
    expect(sessionStorage.getItem('appState_pendingWcWipe')).not.toBeNull();
    expect(await peekSession()).toBeNull();
  });

  it('starts deletion for every IndexedDB database returned by the browser', async () => {
    const deleteDatabase = jest.fn((_name: string) => {
      const request: {
        onsuccess?: () => void;
        onerror?: () => void;
        onblocked?: () => void;
        error?: unknown;
      } = {};
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    });
    setTestGlobal('indexedDB', {
      databases: jest
        .fn()
        .mockResolvedValue([
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
      const request: {
        onsuccess?: () => void;
        onerror?: () => void;
        onblocked?: () => void;
        error?: unknown;
      } = {};
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
    local.clear = () => {
      throw new Error('local clear failed');
    };
    const session = makeStorage();
    session.clear = () => {
      throw new Error('session clear failed');
    };
    setTestGlobal('localStorage', local);
    setTestGlobal('sessionStorage', session);
    setTestGlobal('indexedDB', {
      databases: jest.fn().mockRejectedValue(new Error('database list failed')),
      deleteDatabase: jest.fn((_name: string) => {
        const request: {
          onsuccess?: () => void;
          onerror?: () => void;
          onblocked?: () => void;
          error?: unknown;
        } = {};
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
      const request: {
        onsuccess?: () => void;
        onerror?: () => void;
        onblocked?: () => void;
        error?: unknown;
      } = {};
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    });
    let releaseEnumeration: ((value: Array<{ name?: string }>) => void) | undefined;
    setTestGlobal('indexedDB', {
      databases: () =>
        new Promise((resolve) => {
          releaseEnumeration = resolve;
        }),
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

  it('resolves even when a database deletion is blocked by an open connection', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const deleteDatabase = jest.fn((_name: string) => {
      const request: {
        onsuccess?: () => void;
        onerror?: () => void;
        onblocked?: () => void;
        error?: unknown;
      } = {};
      // A live connection blocks the delete; the request never succeeds.
      setTimeout(() => request.onblocked?.(), 0);
      return request;
    });
    setTestGlobal('indexedDB', {
      databases: jest.fn().mockResolvedValue([{ name: 'WALLET_CONNECT_V2_INDEXED_DB' }]),
      deleteDatabase,
    });

    await expect(hardReset()).resolves.toBeUndefined();
    warn.mockRestore();
  });
});

describe('deferred WalletConnect wipe', () => {
  it('completes a wipe left pending by a prior hard reset, then no-ops', async () => {
    // A prior hard reset sets the pending-wipe marker (its own delete may have
    // been blocked). Drive it through the public API rather than the literal key.
    setTestGlobal('indexedDB', {
      databases: jest.fn().mockResolvedValue([]),
      deleteDatabase: jest.fn((_name: string) => {
        const request: { onsuccess?: () => void; onblocked?: () => void } = {};
        setTimeout(() => request.onsuccess?.(), 0);
        return request;
      }),
    });
    await hardReset();
    _resetPendingWalletConnectWipeForTests();

    const deleteDatabase = jest.fn((_name: string) => {
      const request: { onsuccess?: () => void; onblocked?: () => void } = {};
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    });
    setTestGlobal('indexedDB', {
      databases: jest
        .fn()
        .mockResolvedValue([
          { name: 'WALLET_CONNECT_V2_INDEXED_DB' },
          { name: 'chia-gaming-session' },
        ]),
      deleteDatabase,
    });

    await startPendingWalletConnectWipe();

    expect(deleteDatabase).toHaveBeenCalledWith('WALLET_CONNECT_V2_INDEXED_DB');
    expect(deleteDatabase).not.toHaveBeenCalledWith('chia-gaming-session');
    expect(sessionStorage.getItem('appState_pendingWcWipe')).toBeNull();

    const callsAfterFirst = deleteDatabase.mock.calls.length;
    await startPendingWalletConnectWipe();
    expect(deleteDatabase.mock.calls.length).toBe(callsAfterFirst);
  });

  it('keeps the marker when the boot-time wipe is itself blocked, so the next boot retries', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const succeedingDelete = jest.fn((_name: string) => {
      const request: { onsuccess?: () => void; onblocked?: () => void } = {};
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    });
    setTestGlobal('indexedDB', {
      databases: jest.fn().mockResolvedValue([]),
      deleteDatabase: succeedingDelete,
    });
    await hardReset();
    _resetPendingWalletConnectWipeForTests();

    // Another tab still holds the WalletConnect database open at this boot.
    const blockedDelete = jest.fn((_name: string) => {
      const request: { onsuccess?: () => void; onblocked?: () => void } = {};
      setTimeout(() => request.onblocked?.(), 0);
      return request;
    });
    setTestGlobal('indexedDB', {
      databases: jest.fn().mockResolvedValue([{ name: 'WALLET_CONNECT_V2_INDEXED_DB' }]),
      deleteDatabase: blockedDelete,
    });

    await startPendingWalletConnectWipe();

    expect(blockedDelete).toHaveBeenCalledWith('WALLET_CONNECT_V2_INDEXED_DB');
    expect(sessionStorage.getItem('appState_pendingWcWipe')).not.toBeNull();

    // Next boot: the blocking connection is gone and the wipe completes.
    _resetPendingWalletConnectWipeForTests();
    succeedingDelete.mockClear();
    setTestGlobal('indexedDB', {
      databases: jest.fn().mockResolvedValue([{ name: 'WALLET_CONNECT_V2_INDEXED_DB' }]),
      deleteDatabase: succeedingDelete,
    });

    await startPendingWalletConnectWipe();

    expect(succeedingDelete).toHaveBeenCalledWith('WALLET_CONNECT_V2_INDEXED_DB');
    expect(sessionStorage.getItem('appState_pendingWcWipe')).toBeNull();
    warn.mockRestore();
  });

  it('no-ops when no wipe is pending', async () => {
    _resetPendingWalletConnectWipeForTests();
    const deleteDatabase = jest.fn();
    setTestGlobal('indexedDB', {
      databases: jest.fn().mockResolvedValue([{ name: 'WALLET_CONNECT_V2_INDEXED_DB' }]),
      deleteDatabase,
    });

    await startPendingWalletConnectWipe();

    expect(deleteDatabase).not.toHaveBeenCalled();
  });
});

describe('alias and theme', () => {
  it('getAlias generates a default and persists it', () => {
    const alias = getAlias();
    expect(alias).toMatch(/^Player_/);
    expect(getAlias()).toBe(alias);
    expect(loadState().preferences.alias).toBe(alias);
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

describe('game saves', () => {});
