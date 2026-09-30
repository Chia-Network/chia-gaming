import { SESSION_DB_NAME, type DurableStorageAuthority } from '../lib/session/indexedDb';
import { signalHardResetToOtherTabs } from './saveCoordination';

const KNOWN_INDEXED_DB_NAMES = [
  SESSION_DB_NAME,
  'WALLET_CONNECT_V2_INDEXED_DB',
  'walletconnect',
  'walletconnect-v2',
] as const;

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

function clearStorage(
  name: 'localStorage' | 'sessionStorage',
  storage: Storage,
): HardResetFailure | null {
  try {
    storage.clear();
    return null;
  } catch (error) {
    console.error(`[save] failed to clear ${name} during hard reset:`, error);
    return {
      database: name,
      reason: 'error',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

function clearBrowserStorageForHardReset(): HardResetFailure[] {
  return [
    clearStorage('localStorage', localStorage),
    clearStorage('sessionStorage', sessionStorage),
  ].filter((failure): failure is HardResetFailure => failure !== null);
}

// A hard reset can be blocked while another context holds an IndexedDB open.
// Keep a marker after clearing browser storage so the next boot retries before
// starting any application services.
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
 * If a prior hard reset left an origin-wide wipe pending, complete it now
 * before any application service opens storage. Memoized so callers racing at
 * boot share one wipe.
 *
 * If this wipe is itself blocked (another tab still holds the database open) the
 * marker is left in place so the next boot tries again.
 */
export function startPendingWalletConnectWipe(): Promise<HardResetResult> {
  if (pendingWipe) return pendingWipe;
  if (!hasPendingWipe()) return Promise.resolve({ success: true });
  pendingWipe = wipeAllStorageForHardReset();
  return pendingWipe;
}

/** @internal test-only: forget the memoized boot-time wipe. */
export function _resetPendingWalletConnectWipeForTests(): void {
  pendingWipe = null;
}

async function clearAllIndexedDbForHardReset(): Promise<HardResetResult> {
  if (typeof indexedDB === 'undefined') return { success: true };

  let names: string[];
  try {
    const factory = indexedDB as IDBFactory & {
      databases?: () => Promise<Array<{ name?: string }>>;
    };
    names =
      typeof factory.databases === 'function'
        ? (await factory.databases())
            .map(({ name }) => name)
            .filter((name): name is string => typeof name === 'string')
        : [...KNOWN_INDEXED_DB_NAMES];
  } catch (error) {
    return {
      success: false,
      failures: [
        {
          database: 'indexedDB',
          reason: 'error',
          detail: error instanceof Error ? error.message : String(error),
        },
      ],
    };
  }

  const failures = (
    await Promise.all([...new Set(names)].map((name) => deleteIndexedDb(name, 'hard reset')))
  ).filter((failure): failure is HardResetFailure => failure !== null);
  return failures.length === 0 ? { success: true } : { success: false, failures };
}

async function wipeAllStorageForHardReset(): Promise<HardResetResult> {
  const browserFailures = clearBrowserStorageForHardReset();
  markPendingWipe();
  const databaseResult = await clearAllIndexedDbForHardReset();
  const failures = [...browserFailures, ...(databaseResult.success ? [] : databaseResult.failures)];
  if (failures.length === 0) failures.push(...clearPendingWipe());
  const result: HardResetResult =
    failures.length === 0 ? { success: true } : { success: false, failures };
  if (!result.success) markPendingWipe();
  return result;
}

/** Reset from the boot recovery dialog, before storage authority is claimed. */
export function hardResetUnclaimedStorage(): Promise<HardResetResult> {
  signalHardResetToOtherTabs();
  return wipeAllStorageForHardReset();
}

export function hardResetStorage(
  authority: DurableStorageAuthority,
  runValidatedReset: (
    authority: DurableStorageAuthority,
    reset: () => Promise<void>,
  ) => Promise<void>,
): Promise<HardResetResult> {
  signalHardResetToOtherTabs();
  let result: HardResetResult = { success: false, failures: [] };
  return runValidatedReset(authority, async () => {
    result = await wipeAllStorageForHardReset();
  }).then(() => result);
}
