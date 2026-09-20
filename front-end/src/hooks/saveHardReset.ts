import {
  enqueueHardResetStorageMutation,
  SESSION_DB_NAME,
  type DurableStorageAuthority,
} from '../lib/session/indexedDb';
import { isWalletConnectStorageKey, signalHardResetToOtherTabs } from './saveCoordination';

const KNOWN_WALLETCONNECT_DB_NAMES = [
  'WALLET_CONNECT_V2_INDEXED_DB',
  'walletconnect',
  'walletconnect-v2',
];
const KNOWN_HARD_RESET_DB_NAMES = [SESSION_DB_NAME, ...KNOWN_WALLETCONNECT_DB_NAMES];

export interface HardResetFailure {
  database: string;
  reason: 'blocked' | 'error';
  detail?: string;
}

export type HardResetResult = { success: true } | { success: false; failures: HardResetFailure[] };

export function reloadAfterSuccessfulHardReset(
  result: HardResetResult,
  reload: () => void,
): boolean {
  if (!result.success) return false;
  reload();
  return true;
}

function deleteIndexedDb(
  name: string,
  context = 'IndexedDB cleanup',
): Promise<HardResetFailure | null> {
  return new Promise((resolve) => {
    try {
      const request = indexedDB.deleteDatabase(name);
      request.onsuccess = () => resolve(null);
      request.onerror = () => {
        console.error(
          `[save] ${context}: failed to delete IndexedDB database "${name}":`,
          request.error,
        );
        resolve({
          database: name,
          reason: 'error',
          detail: request.error instanceof Error ? request.error.message : String(request.error),
        });
      };
      request.onblocked = () => {
        console.warn(
          `[save] ${context}: deletion blocked for IndexedDB database "${name}"; ` +
            'open connections will be wiped at next boot',
        );
        resolve({ database: name, reason: 'blocked' });
      };
    } catch (error) {
      console.error(
        `[save] ${context}: failed to start IndexedDB database deletion for "${name}":`,
        error,
      );
      resolve({
        database: name,
        reason: 'error',
        detail: error instanceof Error ? error.message : String(error),
      });
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

/** Resolves true when every WalletConnect database was actually deleted. */
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
      return deleted.every((failure) => failure === null);
    } catch {
      // Fall through to known database names.
    }
  }

  const deleted = await Promise.all(
    KNOWN_WALLETCONNECT_DB_NAMES.map((name) =>
      deleteIndexedDb(name, 'WalletConnect IndexedDB cleanup'),
    ),
  );
  return deleted.every((failure) => failure === null);
}

export async function clearWalletConnectStorage(): Promise<void> {
  clearWalletConnectLocalStorageKeys();
  await clearWalletConnectIndexedDb();
}

// A hard reset can be blocked from deleting the WalletConnect IndexedDB while a
// live client still holds it open. In that case we defer the wipe to the next
// boot, when nothing has opened the database yet, via this sessionStorage
// marker. It is deliberately recreated after localStorage is cleared because
// the app database metadata is itself deleted by a successful wipe.
const PENDING_WIPE_KEY = 'appState_pendingWipe';

function markPendingWipe(): void {
  try {
    localStorage.setItem(PENDING_WIPE_KEY, '1');
  } catch {
    try {
      sessionStorage.setItem(PENDING_WIPE_KEY, '1');
    } catch {
      /* ignore */
    }
  }
}

function hasPendingWipe(): boolean {
  try {
    return (
      localStorage.getItem(PENDING_WIPE_KEY) !== null ||
      sessionStorage.getItem(PENDING_WIPE_KEY) !== null
    );
  } catch {
    return false;
  }
}

function clearPendingWipe(): void {
  try {
    localStorage.removeItem(PENDING_WIPE_KEY);
    sessionStorage.removeItem(PENDING_WIPE_KEY);
  } catch {
    /* ignore */
  }
}

let pendingWipe: Promise<HardResetResult> | null = null;

/**
 * If a prior hard reset left a WalletConnect IndexedDB wipe pending (its delete
 * was blocked by a live connection), complete it now — before any WalletConnect
 * client opens the database. Memoized so callers racing at boot share one wipe.
 *
 * If this wipe is itself blocked (another tab still holds the database open) the
 * marker is left in place so the next boot tries again.
 */
export function startPendingWalletConnectWipe(): Promise<HardResetResult> {
  if (pendingWipe) return pendingWipe;
  if (!hasPendingWipe()) return Promise.resolve({ success: true });
  pendingWipe = clearAllIndexedDbForHardReset().then((result) => {
    if (result.success) clearPendingWipe();
    else markPendingWipe();
    return result;
  });
  return pendingWipe;
}

/** @internal test-only: forget the memoized boot-time wipe. */
export function _resetPendingWalletConnectWipeForTests(): void {
  pendingWipe = null;
}

async function clearAllIndexedDbForHardReset(): Promise<HardResetResult> {
  if (typeof indexedDB === 'undefined') return { success: true };

  const failures = (
    await Promise.all(KNOWN_HARD_RESET_DB_NAMES.map((name) => deleteIndexedDb(name, 'hard reset')))
  ).filter((failure): failure is HardResetFailure => failure !== null);

  const dynamicDatabaseLookup = indexedDB as IDBFactory & {
    databases?: () => Promise<Array<{ name?: string }>>;
  };
  if (typeof dynamicDatabaseLookup.databases !== 'function') {
    console.error(
      '[save] hard reset cannot enumerate IndexedDB databases: indexedDB.databases unavailable; known DB names already deleted',
    );
    return failures.length === 0 ? { success: true } : { success: false, failures };
  }

  try {
    const databases = await dynamicDatabaseLookup.databases();
    const known = new Set(KNOWN_HARD_RESET_DB_NAMES);
    const enumeratedFailures = (
      await Promise.all(
        databases
          .map((db) => db.name)
          .filter(
            (name): name is string =>
              typeof name === 'string' && name.length > 0 && !known.has(name),
          )
          .map((name) => deleteIndexedDb(name, 'hard reset')),
      )
    ).filter((failure): failure is HardResetFailure => failure !== null);
    failures.push(...enumeratedFailures);
  } catch (error) {
    console.error('[save] failed to enumerate IndexedDB during hard reset:', error);
    failures.push({
      database: '<enumeration>',
      reason: 'error',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return failures.length === 0 ? { success: true } : { success: false, failures };
}

export function hardResetStorage(authority: DurableStorageAuthority): Promise<HardResetResult> {
  signalHardResetToOtherTabs();
  let result: HardResetResult = { success: false, failures: [] };
  return enqueueHardResetStorageMutation(authority, async () => {
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
    result = await clearAllIndexedDbForHardReset();
    if (result.success) clearPendingWipe();
    else markPendingWipe();
  }).then(() => result);
}
