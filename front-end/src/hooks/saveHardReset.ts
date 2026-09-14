import { SESSION_DB_NAME } from '../lib/session/indexedDb';
import { isWalletConnectStorageKey, signalHardResetToOtherTabs } from './saveCoordination';

const KNOWN_WALLETCONNECT_DB_NAMES = [
  'WALLET_CONNECT_V2_INDEXED_DB',
  'walletconnect',
  'walletconnect-v2',
];
const KNOWN_HARD_RESET_DB_NAMES = [SESSION_DB_NAME, ...KNOWN_WALLETCONNECT_DB_NAMES];

/** Resolves true when the database is gone, false when it survived the attempt. */
function deleteIndexedDb(name: string, context = 'IndexedDB cleanup'): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(true);
      request.onerror = () => {
        console.error(
          `[save] ${context}: failed to delete IndexedDB database "${name}":`,
          request.error,
        );
        resolve(false);
      };
      request.onblocked = () => {
        console.warn(
          `[save] ${context}: deletion blocked for IndexedDB database "${name}"; ` +
            'open connections will be wiped at next boot',
        );
        resolve(false);
      };
    } catch (error) {
      console.error(
        `[save] ${context}: failed to start IndexedDB database deletion for "${name}":`,
        error,
      );
      resolve(false);
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

/** Resolves true when no WalletConnect database survived the attempt. */
async function clearWalletConnectIndexedDb(): Promise<boolean> {
  if (typeof indexedDB === 'undefined') return true;
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
      const deleted = await Promise.all(
        toDelete.map((name) => deleteIndexedDb(name, 'WalletConnect IndexedDB cleanup')),
      );
      return deleted.every(Boolean);
    } catch {
      // Fall through to known database names.
    }
  }

  const deleted = await Promise.all(
    KNOWN_WALLETCONNECT_DB_NAMES.map((name) =>
      deleteIndexedDb(name, 'WalletConnect IndexedDB cleanup'),
    ),
  );
  return deleted.every(Boolean);
}

export async function clearWalletConnectStorage(): Promise<void> {
  clearWalletConnectLocalStorageKeys();
  await clearWalletConnectIndexedDb();
}

// A hard reset can be blocked from deleting the WalletConnect IndexedDB while a
// live client still holds it open. In that case we defer the wipe to the next
// boot, when nothing has opened the database yet, via this sessionStorage
// marker (per-tab, survives the reload — the tab whose connection was blocking).
const PENDING_WC_WIPE_KEY = 'appState_pendingWcWipe';

function markPendingWalletConnectWipe(): void {
  try {
    sessionStorage.setItem(PENDING_WC_WIPE_KEY, '1');
  } catch {
    /* ignore */
  }
}

function hasPendingWalletConnectWipe(): boolean {
  try {
    return sessionStorage.getItem(PENDING_WC_WIPE_KEY) !== null;
  } catch {
    return false;
  }
}

function clearPendingWalletConnectWipe(): void {
  try {
    sessionStorage.removeItem(PENDING_WC_WIPE_KEY);
  } catch {
    /* ignore */
  }
}

let pendingWalletConnectWipe: Promise<void> | null = null;

/**
 * If a prior hard reset left a WalletConnect IndexedDB wipe pending (its delete
 * was blocked by a live connection), complete it now — before any WalletConnect
 * client opens the database. Memoized so callers racing at boot share one wipe.
 */
export function startPendingWalletConnectWipe(): Promise<void> {
  if (pendingWalletConnectWipe) return pendingWalletConnectWipe;
  if (!hasPendingWalletConnectWipe()) return Promise.resolve();
  pendingWalletConnectWipe = clearWalletConnectIndexedDb().then((wiped) => {
    if (wiped) {
      clearPendingWalletConnectWipe();
      return;
    }
    // Something still holds the database open — another tab, since nothing in
    // this one has opened it yet. Keep the marker so the next boot retries, and
    // drop the memo so a later caller this boot doesn't inherit the failure.
    pendingWalletConnectWipe = null;
  });
  return pendingWalletConnectWipe;
}

/** @internal test-only: forget the memoized boot-time wipe. */
export function _resetPendingWalletConnectWipeForTests(): void {
  pendingWalletConnectWipe = null;
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
  // A live WalletConnect connection can block the WC IndexedDB deletion above,
  // in which case the database survives this reset. Mark it so the next boot
  // completes the wipe before any client reopens it. Set after sessionStorage
  // is cleared so this marker is the only survivor.
  markPendingWalletConnectWipe();
}
