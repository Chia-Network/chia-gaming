import { SESSION_DB_NAME, type DurableStorageAuthority } from '../lib/session/indexedDb';
import { isWalletConnectStorageKey, signalHardResetToOtherTabs } from './saveCoordination';

export const OWNED_INDEXED_DB_EXACT_NAMES = [
  SESSION_DB_NAME,
  'app-state',
  'WALLET_CONNECT_V2_INDEXED_DB',
  'walletconnect',
  'walletconnect-v2',
] as const;
export const OWNED_INDEXED_DB_PREFIXES = [
  'chia-gaming-',
  'WALLET_CONNECT_',
  'walletconnect-',
] as const;
export const OWNED_LOCAL_STORAGE_EXACT_KEYS = [
  'appState',
  'appState_savedSession',
  'appState_hardReset',
  'appState_activeTab',
  'appState_pendingWipe',
  'appState_cloudWalletConfig',
  'appState_cloudWalletAuth',
] as const;
export const OWNED_LOCAL_STORAGE_PREFIXES = [
  'appState_',
  'wc@',
  'WALLET_CONNECT_',
  'walletconnect',
] as const;
export const OWNED_SESSION_STORAGE_EXACT_KEYS = [
  'appState_autoResumeOnce',
  'appState_tabId',
  'appState_pendingWipe',
] as const;
export const OWNED_SESSION_STORAGE_PREFIXES = ['appState_'] as const;

export function isOwnedIndexedDbName(name: string): boolean {
  return (
    (OWNED_INDEXED_DB_EXACT_NAMES as readonly string[]).includes(name) ||
    OWNED_INDEXED_DB_PREFIXES.some((prefix) => name.startsWith(prefix))
  );
}

function isWalletConnectIndexedDbName(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.includes('walletconnect') || name.startsWith('WALLET_CONNECT_');
}

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

function clearOwnedStorageKeys(
  name: 'localStorage' | 'sessionStorage',
  storage: Storage,
  exactKeys: readonly string[],
  prefixes: readonly string[],
  preservePendingWipe: boolean,
): HardResetFailure | null {
  try {
    const toRemove = new Set(exactKeys);
    for (let index = 0; index < storage.length; index++) {
      const key = storage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) {
        toRemove.add(key);
      }
    }
    if (preservePendingWipe) toRemove.delete(PENDING_WIPE_KEY);
    for (const key of toRemove) storage.removeItem(key);
    return null;
  } catch (error) {
    console.error(`[save] failed to clear owned ${name} during hard reset:`, error);
    return {
      database: name,
      reason: 'error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function clearOwnedBrowserStorageForHardReset(): HardResetFailure[] {
  return [
    clearOwnedStorageKeys(
      'localStorage',
      localStorage,
      OWNED_LOCAL_STORAGE_EXACT_KEYS,
      OWNED_LOCAL_STORAGE_PREFIXES,
      true,
    ),
    clearOwnedStorageKeys(
      'sessionStorage',
      sessionStorage,
      OWNED_SESSION_STORAGE_EXACT_KEYS,
      OWNED_SESSION_STORAGE_PREFIXES,
      true,
    ),
  ].filter((failure): failure is HardResetFailure => failure !== null);
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
          (name): name is string => typeof name === 'string' && isWalletConnectIndexedDbName(name),
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
    OWNED_INDEXED_DB_EXACT_NAMES.filter(isWalletConnectIndexedDbName).map((name) =>
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
// marker. It is deliberately retained in the owned-key manifest because the
// app database metadata is itself deleted by a successful wipe.
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
  let localPending = false;
  try {
    localPending = localStorage.getItem(PENDING_WIPE_KEY) !== null;
  } catch {
    // The sessionStorage fallback may still be available.
  }
  let sessionPending = false;
  try {
    sessionPending = sessionStorage.getItem(PENDING_WIPE_KEY) !== null;
  } catch {
    // The localStorage marker may still be available.
  }
  return localPending || sessionPending;
}

function clearPendingWipe(): HardResetFailure[] {
  const failures: HardResetFailure[] = [];
  try {
    localStorage.removeItem(PENDING_WIPE_KEY);
  } catch (error) {
    failures.push({
      database: 'localStorage',
      reason: 'error',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  try {
    sessionStorage.removeItem(PENDING_WIPE_KEY);
  } catch (error) {
    failures.push({
      database: 'sessionStorage',
      reason: 'error',
      detail: error instanceof Error ? error.message : String(error),
    });
  }
  return failures;
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
  const browserFailures = clearOwnedBrowserStorageForHardReset();
  pendingWipe = clearAllIndexedDbForHardReset().then((databaseResult) => {
    const failures = [
      ...browserFailures,
      ...(databaseResult.success ? [] : databaseResult.failures),
    ];
    if (failures.length === 0) failures.push(...clearPendingWipe());
    if (failures.length > 0) {
      markPendingWipe();
      return { success: false, failures };
    }
    return { success: true };
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
    await Promise.all(
      OWNED_INDEXED_DB_EXACT_NAMES.map((name) => deleteIndexedDb(name, 'hard reset')),
    )
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
    const known = new Set<string>(OWNED_INDEXED_DB_EXACT_NAMES);
    const enumeratedFailures = (
      await Promise.all(
        databases
          .map((db) => db.name)
          .filter(
            (name): name is string =>
              typeof name === 'string' &&
              name.length > 0 &&
              !known.has(name) &&
              isOwnedIndexedDbName(name),
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

export function hardResetStorage(
  authority: DurableStorageAuthority,
  runValidatedReset: (
    authority: DurableStorageAuthority,
    reset: () => Promise<void>,
  ) => Promise<void>,
): Promise<HardResetResult> {
  signalHardResetToOtherTabs();
  markPendingWipe();
  let result: HardResetResult = { success: false, failures: [] };
  return runValidatedReset(authority, async () => {
    const browserFailures = clearOwnedBrowserStorageForHardReset();
    const databaseResult = await clearAllIndexedDbForHardReset();
    const failures = [
      ...browserFailures,
      ...(databaseResult.success ? [] : databaseResult.failures),
    ];
    if (failures.length === 0) failures.push(...clearPendingWipe());
    result = failures.length === 0 ? { success: true } : { success: false, failures };
    if (!result.success) markPendingWipe();
  }).then(() => result);
}
