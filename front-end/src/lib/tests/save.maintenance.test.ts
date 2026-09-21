import { checkLease, isLeaseConflict, releaseLeaseIfOwner } from '../../hooks/saveCoordination';
import { SESSION_DB_NAME, StorageAuthorityLostError } from '../session/indexedDb';
import { liveSave } from './session_save_envelope.fixtures';
import { installReservedWalletObligation } from './wallet_operation_test_helpers';
import {
  startPendingWalletConnectWipe,
  _resetPendingWalletConnectWipeForTests,
  reloadAfterSuccessfulHardReset,
} from '../../hooks/saveHardReset';
import {
  clearTestGlobal,
  makeStorage,
  sampleSession,
  saveLiveFields,
  setTestGlobal,
  testIndexedDb,
} from './save.harness';
import { storageRepository } from '../session/storageRepository';
import { captureDurableApplicationState } from '../session/sessionMachinePersist';

describe('tab lease', () => {
  it('detects a conflicting active-tab owner', async () => {
    await storageRepository.claimApplicationState();
    expect(checkLease()).toBe(true);
    expect(isLeaseConflict()).toBe(false);

    localStorage.setItem('appState_activeTab', 'another-tab');

    expect(checkLease()).toBe(false);
    expect(isLeaseConflict()).toBe(true);
  });

  it('clears the lease on close only when this tab still owns it', async () => {
    await storageRepository.claimApplicationState();
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
  it('reloads only after a confirmed successful reset', () => {
    const reload = jest.fn();
    expect(
      reloadAfterSuccessfulHardReset(
        {
          success: false,
          failures: [{ database: SESSION_DB_NAME, reason: 'blocked' }],
        },
        reload,
      ),
    ).toBe(false);
    expect(reload).not.toHaveBeenCalled();

    expect(reloadAfterSuccessfulHardReset({ success: true }, reload)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('clears owned browser keys while preserving foreign same-origin keys', async () => {
    const beforeReset = storageRepository.lifecycleGeneration;
    const lifecycle = jest.fn();
    const unsubscribe = storageRepository.onLifecycle(lifecycle);
    saveLiveFields({ ...sampleSession, blockchainType: 'walletconnect' });
    localStorage.setItem('appState', 'historical-app-state');
    localStorage.setItem('appState_wcChangeAddress:123', 'xch1owned');
    localStorage.setItem('appState_wcRemoteWalletId:123', '2');
    localStorage.setItem('wc@2:client:0.3//session', 'walletconnect-owned');
    localStorage.setItem('foreign-app-key', 'preserve-local');
    localStorage.setItem('foreign-walletconnect-settings', 'preserve-walletconnect-lookalike');
    sessionStorage.setItem('appState_tabId', 'tab-1');
    sessionStorage.setItem('foreign-session-key', 'preserve-session');
    sessionStorage.setItem(
      'foreign-walletconnect-settings',
      'preserve-session-walletconnect-lookalike',
    );

    await storageRepository.hardReset();

    expect(storageRepository.lifecycleGeneration).toBe(beforeReset + 1);
    expect(lifecycle).toHaveBeenCalledWith(beforeReset + 1, 'hard-reset');
    unsubscribe();
    expect(localStorage.getItem('appState')).toBeNull();
    expect(localStorage.getItem('appState_wcChangeAddress:123')).toBeNull();
    expect(localStorage.getItem('appState_wcRemoteWalletId:123')).toBeNull();
    expect(localStorage.getItem('wc@2:client:0.3//session')).toBeNull();
    expect(localStorage.getItem('foreign-app-key')).toBe('preserve-local');
    expect(localStorage.getItem('foreign-walletconnect-settings')).toBe(
      'preserve-walletconnect-lookalike',
    );
    expect(sessionStorage.getItem('appState_tabId')).toBeNull();
    expect(sessionStorage.getItem('foreign-session-key')).toBe('preserve-session');
    expect(sessionStorage.getItem('foreign-walletconnect-settings')).toBe(
      'preserve-session-walletconnect-lookalike',
    );
    expect(storageRepository.loadState().session).toBeNull();
  });

  it('invalidates a held checkpoint before reset and cannot recreate storage afterward', async () => {
    storageRepository._replaceApplicationStateForTests({
      ...storageRepository.loadState(),
      walletContext: { provider: 'simulator', identity: 'installation' },
    });
    installReservedWalletObligation(
      'pre-reset-ledger',
      {
        installationPlayerId: 'installation',
        peerSessionId: 'pre-reset-peer',
        providerScope: { provider: 'simulator', identity: 'installation' },
      },
      { kind: 'funding', operationId: 'pre-reset-operation' },
    );
    saveLiveFields({
      ...sampleSession,
      walletProviderScope: { provider: 'simulator', identity: 'installation' },
    });
    await storageRepository.flushAggregate();
    const rejection = {
      kind: 'inbound-receipt',
      peerId: 'pre-reset-peer',
      sessionId: 'ab'.repeat(16),
      messageNumber: 1n,
      remoteNumber: 1n,
      unackedMessages: [],
      createdAt: Date.now(),
    } as const;
    await captureDurableApplicationState({
      kind: 'transform',
      transform: (state) => ({ ...state, rejectionTransports: [rejection] }),
    })?.write();

    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    storageRepository.holdNextMutationForTests(held);
    const staleCheckpoint = storageRepository.checkpointApplicationState(
      liveSave({
        ...sampleSession,
        walletProviderScope: { provider: 'simulator', identity: 'installation' },
      }),
      [
        {
          tradeId: 'stale-reset-ledger',
          owner: {
            installationPlayerId: 'installation',
            peerSessionId: 'stale-peer',
            providerScope: { provider: 'simulator', identity: 'installation' },
          },
          purpose: { kind: 'funding', operationId: 'stale-operation' },
          stage: 'reserved',
          reason: 'held-before-hard-reset',
        },
      ],
    );

    const reset = storageRepository.hardReset();
    release();
    await expect(staleCheckpoint).rejects.toBeInstanceOf(StorageAuthorityLostError);
    await reset;

    const databases = await (
      indexedDB as IDBFactory & { databases: () => Promise<Array<{ name?: string }>> }
    ).databases();
    expect(databases.map((database) => database.name)).not.toContain(SESSION_DB_NAME);
    expect(storageRepository.loadState().session).toBeNull();
    expect(storageRepository.walletObligations()).toEqual([]);
  });

  it('deletes only owned IndexedDB databases returned by the browser', async () => {
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
      open: testIndexedDb.open.bind(testIndexedDb),
      databases: jest
        .fn()
        .mockResolvedValue([
          { name: 'chia-gaming-historical' },
          { name: 'foreign-app-state' },
          { name: 'WALLET_CONNECT_V2_INDEXED_DB' },
          { name: undefined },
        ]),
      deleteDatabase,
    });

    await storageRepository.hardReset();

    expect(deleteDatabase).toHaveBeenCalledWith(SESSION_DB_NAME);
    expect(deleteDatabase).toHaveBeenCalledWith('WALLET_CONNECT_V2_INDEXED_DB');
    expect(deleteDatabase).toHaveBeenCalledWith('app-state');
    expect(deleteDatabase).toHaveBeenCalledWith('chia-gaming-historical');
    expect(deleteDatabase).not.toHaveBeenCalledWith('foreign-app-state');
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
    setTestGlobal('indexedDB', {
      open: testIndexedDb.open.bind(testIndexedDb),
      deleteDatabase,
    });

    await storageRepository.hardReset();

    expect(deleteDatabase).toHaveBeenCalledWith(SESSION_DB_NAME);
    expect(deleteDatabase).toHaveBeenCalledWith('WALLET_CONNECT_V2_INDEXED_DB');
    expect(deleteDatabase).toHaveBeenCalledWith('walletconnect');
    expect(deleteDatabase).toHaveBeenCalledWith('walletconnect-v2');
    spy.mockRestore();
  });

  it('reports browser-key deletion failures and keeps the pending wipe marker', async () => {
    const spy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const local = makeStorage();
    local.setItem('appState_savedSession', '1');
    local.removeItem = () => {
      throw new Error('local remove failed');
    };
    const session = makeStorage();
    session.setItem('appState_tabId', 'tab');
    session.removeItem = () => {
      throw new Error('session remove failed');
    };
    setTestGlobal('localStorage', local);
    setTestGlobal('sessionStorage', session);
    setTestGlobal('indexedDB', {
      open: testIndexedDb.open.bind(testIndexedDb),
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

    const result = await storageRepository.hardReset();
    expect(result).toEqual({
      success: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ database: 'localStorage', reason: 'error' }),
        expect.objectContaining({ database: 'sessionStorage', reason: 'error' }),
        expect.objectContaining({ database: '<enumeration>', reason: 'error' }),
      ]),
    });
    expect(localStorage.getItem('appState_pendingWipe')).toBe('1');
    const reload = jest.fn();
    expect(reloadAfterSuccessfulHardReset(result, reload)).toBe(false);
    expect(reload).not.toHaveBeenCalled();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('deletes known databases before waiting on enumeration', async () => {
    let markDeletionStarted!: () => void;
    const deletionStarted = new Promise<void>((resolve) => {
      markDeletionStarted = resolve;
    });
    const deleteDatabase = jest.fn((_name: string) => {
      markDeletionStarted();
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
      open: testIndexedDb.open.bind(testIndexedDb),
      databases: () =>
        new Promise((resolve) => {
          releaseEnumeration = resolve;
        }),
      deleteDatabase,
    });

    const done = storageRepository.hardReset();
    await deletionStarted;
    // Known wipes must be requested without waiting for databases().
    expect(deleteDatabase).toHaveBeenCalledWith(SESSION_DB_NAME);
    expect(deleteDatabase).toHaveBeenCalledWith('WALLET_CONNECT_V2_INDEXED_DB');

    // Let known deleteDatabase requests settle so enumeration can start.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(releaseEnumeration).toBeDefined();
    expect(localStorage.getItem('appState_pendingWipe')).toBe('1');
    releaseEnumeration!([{ name: 'extra-unknown-db' }]);
    await done;
    expect(localStorage.getItem('appState_pendingWipe')).toBeNull();
    expect(deleteDatabase).not.toHaveBeenCalledWith('extra-unknown-db');
  });

  it('returns unsuccessful when a database deletion is blocked by an open connection', async () => {
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
      open: testIndexedDb.open.bind(testIndexedDb),
      databases: jest.fn().mockResolvedValue([{ name: 'WALLET_CONNECT_V2_INDEXED_DB' }]),
      deleteDatabase,
    });

    await expect(storageRepository.hardReset()).resolves.toEqual({
      success: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ database: SESSION_DB_NAME, reason: 'blocked' }),
      ]),
    });
    expect(localStorage.getItem('appState_pendingWipe')).toBe('1');

    const succeedingDelete = jest.fn((_name: string) => {
      const request: { onsuccess?: () => void } = {};
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    });
    setTestGlobal('indexedDB', {
      open: testIndexedDb.open.bind(testIndexedDb),
      databases: jest.fn().mockResolvedValue([]),
      deleteDatabase: succeedingDelete,
    });
    await expect(storageRepository.hardReset()).resolves.toEqual({ success: true });
    expect(localStorage.getItem('appState_pendingWipe')).toBeNull();
    warn.mockRestore();
  });
});

describe('deferred WalletConnect wipe', () => {
  it('completes a wipe left pending by a prior hard reset, then no-ops', async () => {
    localStorage.setItem('appState_pendingWipe', '1');
    _resetPendingWalletConnectWipeForTests();

    const deleteDatabase = jest.fn((_name: string) => {
      const request: { onsuccess?: () => void; onblocked?: () => void } = {};
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    });
    setTestGlobal('indexedDB', {
      open: testIndexedDb.open.bind(testIndexedDb),
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
    expect(deleteDatabase).toHaveBeenCalledWith('chia-gaming-session');
    expect(localStorage.getItem('appState_pendingWipe')).toBeNull();

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
    localStorage.setItem('appState_pendingWipe', '1');
    _resetPendingWalletConnectWipeForTests();

    // Another tab still holds the WalletConnect database open at this boot.
    const blockedDelete = jest.fn((_name: string) => {
      const request: { onsuccess?: () => void; onblocked?: () => void } = {};
      setTimeout(() => request.onblocked?.(), 0);
      return request;
    });
    setTestGlobal('indexedDB', {
      open: testIndexedDb.open.bind(testIndexedDb),
      databases: jest.fn().mockResolvedValue([{ name: 'WALLET_CONNECT_V2_INDEXED_DB' }]),
      deleteDatabase: blockedDelete,
    });

    await startPendingWalletConnectWipe();

    expect(blockedDelete).toHaveBeenCalledWith('WALLET_CONNECT_V2_INDEXED_DB');
    expect(localStorage.getItem('appState_pendingWipe')).not.toBeNull();

    // Next boot: the blocking connection is gone and the wipe completes.
    _resetPendingWalletConnectWipeForTests();
    succeedingDelete.mockClear();
    setTestGlobal('indexedDB', {
      open: testIndexedDb.open.bind(testIndexedDb),
      databases: jest.fn().mockResolvedValue([{ name: 'WALLET_CONNECT_V2_INDEXED_DB' }]),
      deleteDatabase: succeedingDelete,
    });

    await startPendingWalletConnectWipe();

    expect(succeedingDelete).toHaveBeenCalledWith('WALLET_CONNECT_V2_INDEXED_DB');
    expect(localStorage.getItem('appState_pendingWipe')).toBeNull();
    warn.mockRestore();
  });

  it('keeps the marker when deferred browser-key deletion fails, then retries it', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const failingLocal = makeStorage();
    failingLocal.setItem('appState_pendingWipe', '1');
    failingLocal.removeItem = () => {
      throw new Error('local key deletion failed');
    };
    setTestGlobal('localStorage', failingLocal);
    const deleteDatabase = jest.fn((_name: string) => {
      const request: { onsuccess?: () => void } = {};
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    });
    setTestGlobal('indexedDB', {
      open: testIndexedDb.open.bind(testIndexedDb),
      databases: jest.fn().mockResolvedValue([]),
      deleteDatabase,
    });
    _resetPendingWalletConnectWipeForTests();

    await expect(startPendingWalletConnectWipe()).resolves.toEqual({
      success: false,
      failures: [expect.objectContaining({ database: 'localStorage', reason: 'error' })],
    });
    expect(localStorage.getItem('appState_pendingWipe')).toBe('1');

    const succeedingLocal = makeStorage();
    succeedingLocal.setItem('appState_pendingWipe', '1');
    setTestGlobal('localStorage', succeedingLocal);
    _resetPendingWalletConnectWipeForTests();
    await expect(startPendingWalletConnectWipe()).resolves.toEqual({ success: true });
    expect(localStorage.getItem('appState_pendingWipe')).toBeNull();
    error.mockRestore();
  });

  it('retries a sessionStorage fallback marker when localStorage operations throw', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => {});
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const unavailableLocal = makeStorage();
    unavailableLocal.setItem = () => {
      throw new Error('local set unavailable');
    };
    unavailableLocal.getItem = () => {
      throw new Error('local get unavailable');
    };
    unavailableLocal.removeItem = () => {
      throw new Error('local remove unavailable');
    };
    setTestGlobal('localStorage', unavailableLocal);
    const blockedDelete = jest.fn((_name: string) => {
      const request: { onblocked?: () => void } = {};
      setTimeout(() => request.onblocked?.(), 0);
      return request;
    });
    setTestGlobal('indexedDB', {
      open: testIndexedDb.open.bind(testIndexedDb),
      databases: jest.fn().mockResolvedValue([]),
      deleteDatabase: blockedDelete,
    });

    await expect(storageRepository.hardReset()).resolves.toEqual({
      success: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ database: 'localStorage', reason: 'error' }),
        expect.objectContaining({ reason: 'blocked' }),
      ]),
    });
    expect(sessionStorage.getItem('appState_pendingWipe')).toBe('1');

    _resetPendingWalletConnectWipeForTests();
    blockedDelete.mockClear();
    await expect(startPendingWalletConnectWipe()).resolves.toEqual({
      success: false,
      failures: expect.arrayContaining([
        expect.objectContaining({ database: 'localStorage', reason: 'error' }),
        expect.objectContaining({ reason: 'blocked' }),
      ]),
    });
    expect(blockedDelete).toHaveBeenCalled();
    expect(sessionStorage.getItem('appState_pendingWipe')).toBe('1');

    setTestGlobal('localStorage', makeStorage());
    const succeedingDelete = jest.fn((_name: string) => {
      const request: { onsuccess?: () => void } = {};
      setTimeout(() => request.onsuccess?.(), 0);
      return request;
    });
    setTestGlobal('indexedDB', {
      open: testIndexedDb.open.bind(testIndexedDb),
      databases: jest.fn().mockResolvedValue([]),
      deleteDatabase: succeedingDelete,
    });
    _resetPendingWalletConnectWipeForTests();
    await expect(startPendingWalletConnectWipe()).resolves.toEqual({ success: true });
    expect(succeedingDelete).toHaveBeenCalled();
    expect(localStorage.getItem('appState_pendingWipe')).toBeNull();
    expect(sessionStorage.getItem('appState_pendingWipe')).toBeNull();
    warn.mockRestore();
    error.mockRestore();
  });

  it('no-ops when no wipe is pending', async () => {
    _resetPendingWalletConnectWipeForTests();
    const deleteDatabase = jest.fn();
    setTestGlobal('indexedDB', {
      open: testIndexedDb.open.bind(testIndexedDb),
      databases: jest.fn().mockResolvedValue([{ name: 'WALLET_CONNECT_V2_INDEXED_DB' }]),
      deleteDatabase,
    });

    await startPendingWalletConnectWipe();

    expect(deleteDatabase).not.toHaveBeenCalled();
  });
});

describe('alias and theme', () => {
  it('getAlias generates a default and persists it', () => {
    const alias = storageRepository.getOrCreateAlias();
    expect(alias).toMatch(/^Player_/);
    expect(storageRepository.getOrCreateAlias()).toBe(alias);
    expect(storageRepository.loadState().preferences.alias).toBe(alias);
  });

  it('peekAlias returns undefined until set, without inventing', () => {
    expect(storageRepository.query('alias')).toBeUndefined();
    storageRepository.updatePreference({ key: 'alias', value: 'MyName' });
    expect(storageRepository.query('alias')).toBe('MyName');
  });

  it('setAlias stores and retrieves', () => {
    storageRepository.updatePreference({ key: 'alias', value: 'CustomName' });
    expect(storageRepository.getOrCreateAlias()).toBe('CustomName');
  });

  it('getTheme returns undefined initially', () => {
    expect(storageRepository.query('theme')).toBeUndefined();
  });

  it('setTheme / getTheme round-trip', () => {
    storageRepository.updatePreference({ key: 'theme', value: 'dark' });
    expect(storageRepository.query('theme')).toBe('dark');
    storageRepository.updatePreference({ key: 'theme', value: 'light' });
    expect(storageRepository.query('theme')).toBe('light');
  });
});

describe('hub alert', () => {
  it('getHubAlert returns false initially', () => {
    expect(storageRepository.query('hubAlert')).toBe(false);
  });

  it('setHubAlert / getHubAlert round-trip', () => {
    storageRepository.updatePreference({ key: 'hubAlert', value: true });
    expect(storageRepository.query('hubAlert')).toBe(true);
    storageRepository.updatePreference({ key: 'hubAlert', value: false });
    expect(storageRepository.query('hubAlert')).toBe(false);
  });
});

describe('game saves', () => {});
