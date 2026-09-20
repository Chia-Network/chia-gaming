import { isElectronDistribution } from '../util/distribution';
import { type ClaimedStorageSnapshot } from '../lib/session/indexedDb';
import { storageCoordinator } from '../lib/session/storageCoordinator';

const SESSION_MARKER_KEY = 'appState_savedSession';
const AUTO_RESUME_ONCE_KEY = 'appState_autoResumeOnce';
const RESET_KEY = 'appState_hardReset';
const LEASE_KEY = 'appState_activeTab';
const TAB_ID_SESSION_KEY = 'appState_tabId';

let autoResumeLatch = false;
export type { StorageAuthorityLossReason } from '../lib/session/storageCoordinator';

export function randomHex(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const tabId: string = (() => {
  if (typeof sessionStorage !== 'undefined') {
    const existing = sessionStorage.getItem(TAB_ID_SESSION_KEY);
    if (existing) return existing;
  }
  const id =
    typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : randomHex();
  try {
    sessionStorage.setItem(TAB_ID_SESSION_KEY, id);
  } catch {
    /* ignore */
  }
  return id;
})();
export function getStorageTabId(): string {
  return tabId;
}

// The lease lives in localStorage but `tabId` lives in sessionStorage, so a
// quit orphans the lease. Electron enforces one app instance and one window,
// which means a foreign owner in the desktop build is always stale.
function leaseHasLivePeer(): boolean {
  const current = localStorage.getItem(LEASE_KEY);
  if (current === null || current === tabId) return false;
  return !isElectronDistribution();
}

export function isLeaseConflict(): boolean {
  try {
    return leaseHasLivePeer();
  } catch {
    return false;
  }
}

export function checkLease(): boolean {
  try {
    return !leaseHasLivePeer();
  } catch {
    return true;
  }
}

export async function claimLease(): Promise<ClaimedStorageSnapshot> {
  const claimed = await storageCoordinator.claimAndRead(tabId);
  try {
    localStorage.setItem(LEASE_KEY, tabId);
  } catch {
    /* ignore */
  }
  return claimed;
}

/** Drop the lease only if this tab still holds it, so a closed owner does not look like a live conflict. */
export function releaseLeaseIfOwner(): void {
  try {
    if (localStorage.getItem(LEASE_KEY) === tabId) {
      localStorage.removeItem(LEASE_KEY);
    }
  } catch {
    /* ignore */
  }
}

export function hasSavedSessionMarker(): boolean {
  try {
    return localStorage.getItem(SESSION_MARKER_KEY) !== null;
  } catch {
    return false;
  }
}

export function markSavedSession(): void {
  try {
    localStorage.setItem(SESSION_MARKER_KEY, '1');
  } catch {
    /* ignore */
  }
}

export function clearSavedSessionMarker(): void {
  try {
    localStorage.removeItem(SESSION_MARKER_KEY);
  } catch {
    /* ignore */
  }
}

export function markAutoResumeOnce(): void {
  try {
    sessionStorage.setItem(AUTO_RESUME_ONCE_KEY, '1');
  } catch {
    /* ignore */
  }
}

export function peekAutoResumeOnce(): boolean {
  if (autoResumeLatch) return true;
  try {
    if (sessionStorage.getItem(AUTO_RESUME_ONCE_KEY) !== null) {
      autoResumeLatch = true;
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export function clearAutoResumeOnce(): void {
  autoResumeLatch = false;
  try {
    sessionStorage.removeItem(AUTO_RESUME_ONCE_KEY);
  } catch {
    /* ignore */
  }
}

export function isWalletConnectStorageKey(key: string): boolean {
  const lower = key.toLowerCase();
  return (
    lower.startsWith('wc@') || lower.includes('walletconnect') || lower.includes('wallet_connect')
  );
}

export function hasWalletConnectStorage(): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (key && isWalletConnectStorageKey(key)) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export function signalHardResetToOtherTabs(): void {
  try {
    localStorage.setItem(RESET_KEY, `${Date.now()}:${randomHex()}`);
  } catch (error) {
    console.error('[save] failed to signal hard reset to other tabs:', error);
  }
}

export function installStorageCoordination(onHardReset: () => void): void {
  if (typeof window === 'undefined' || typeof window.addEventListener !== 'function') return;
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === RESET_KEY) {
      storageCoordinator.loseAuthority('sibling-reset');
      onHardReset();
      return;
    }
    if (event.key === LEASE_KEY && event.newValue !== tabId && !storageCoordinator.isFenced()) {
      storageCoordinator.loseAuthority('takeover');
    }
  });

  setInterval(() => {
    if (storageCoordinator.isFenced()) return;
    if (!checkLease()) {
      storageCoordinator.loseAuthority('takeover');
    }
  }, 3000);
}

export function resetStorageCoordinationForTests(): void {
  storageCoordinator.resetForTests();
  autoResumeLatch = false;
  try {
    localStorage.removeItem(LEASE_KEY);
  } catch {
    /* ignore */
  }
  try {
    localStorage.removeItem(RESET_KEY);
  } catch {
    /* ignore */
  }
  try {
    sessionStorage.removeItem(AUTO_RESUME_ONCE_KEY);
  } catch {
    /* ignore */
  }
}
