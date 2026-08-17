import { SESSION_DB_NAME } from '../lib/session/indexedDb';
import { isWalletConnectStorageKey, signalHardResetToOtherTabs } from './saveCoordination';

const KNOWN_WALLETCONNECT_DB_NAMES = [
  'WALLET_CONNECT_V2_INDEXED_DB',
  'walletconnect',
  'walletconnect-v2',
];
const KNOWN_HARD_RESET_DB_NAMES = [SESSION_DB_NAME, ...KNOWN_WALLETCONNECT_DB_NAMES];

function deleteIndexedDb(name: string, context = 'IndexedDB cleanup'): Promise<void> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve();
      request.onerror = () => {
        console.error(
          `[save] ${context}: failed to delete IndexedDB database "${name}":`,
          request.error,
        );
        resolve();
      };
      request.onblocked = () => {
        console.warn(
          `[save] ${context}: deletion blocked for IndexedDB database "${name}"; waiting for other connections to close`,
        );
      };
    } catch (error) {
      console.error(
        `[save] ${context}: failed to start IndexedDB database deletion for "${name}":`,
        error,
      );
      resolve();
    }
  });
}

function clearWalletConnectLocalStorageKeys(): void {
  try {
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && isWalletConnectStorageKey(key)) toRemove.push(key);
    }
    for (const key of toRemove) localStorage.removeItem(key);
  } catch {
    /* ignore */
  }
}

async function clearWalletConnectIndexedDb(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  const dynamicDatabaseLookup = indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>;
  };

  if (typeof dynamicDatabaseLookup.databases === 'function') {
    try {
      const databases = await dynamicDatabaseLookup.databases();
      const toDelete = databases
        .map((db) => db.name)
        .filter(
          (name): name is string => typeof name === 'string' && isWalletConnectStorageKey(name),
        );
      await Promise.all(
        toDelete.map((name) => deleteIndexedDb(name, 'WalletConnect IndexedDB cleanup')),
      );
      return;
    } catch {
      // Fall through to known database names.
    }
  }

  await Promise.all(
    KNOWN_WALLETCONNECT_DB_NAMES.map((name) =>
      deleteIndexedDb(name, 'WalletConnect IndexedDB cleanup'),
    ),
  );
}

export async function clearWalletConnectStorage(): Promise<void> {
  clearWalletConnectLocalStorageKeys();
  await clearWalletConnectIndexedDb();
}

async function clearAllIndexedDbForHardReset(): Promise<void> {
  if (typeof indexedDB === 'undefined') return;

  await Promise.all(KNOWN_HARD_RESET_DB_NAMES.map((name) => deleteIndexedDb(name, 'hard reset')));

  const dynamicDatabaseLookup = indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>;
  };
  if (typeof dynamicDatabaseLookup.databases !== 'function') {
    console.error(
      '[save] hard reset cannot enumerate IndexedDB databases: indexedDB.databases unavailable; known DB names already deleted',
    );
    return;
  }

  try {
    const databases = await dynamicDatabaseLookup.databases();
    const known = new Set(KNOWN_HARD_RESET_DB_NAMES);
    await Promise.all(
      databases
        .map((db) => db.name)
        .filter(
          (name): name is string => typeof name === 'string' && name.length > 0 && !known.has(name),
        )
        .map((name) => deleteIndexedDb(name, 'hard reset')),
    );
  } catch (error) {
    console.error('[save] failed to enumerate IndexedDB during hard reset:', error);
  }
}

export async function hardResetStorage(stopPersistence: () => void): Promise<void> {
  signalHardResetToOtherTabs();
  stopPersistence();
  try {
    localStorage.clear();
  } catch (error) {
    console.error('[save] failed to clear localStorage during hard reset:', error);
  }
  try {
    sessionStorage.clear();
  } catch (error) {
    console.error('[save] failed to clear sessionStorage during hard reset:', error);
  }
  await clearAllIndexedDbForHardReset();
}
