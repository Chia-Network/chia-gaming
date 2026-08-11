const SESSION_MARKER_KEY = 'appState_savedSession';
const AUTO_RESUME_ONCE_KEY = 'appState_autoResumeOnce';
const RESET_KEY = 'appState_hardReset';
const LEASE_KEY = 'appState_activeTab';
const TAB_ID_SESSION_KEY = 'appState_tabId';

let autoResumeLatch = false;
let fenced = false;
const fencedListeners = new Set<() => void>();

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

function fireFenced(): void {
  for (const cb of fencedListeners) {
    try {
      cb();
    } catch {
      /* ignore */
    }
  }
}

export function onFenced(cb: () => void): void {
  fencedListeners.add(cb);
}

export function offFenced(cb: () => void): void {
  fencedListeners.delete(cb);
}

export function isLeaseConflict(): boolean {
  try {
    const current = localStorage.getItem(LEASE_KEY);
    return current !== null && current !== tabId;
  } catch {
    return false;
  }
}

export function checkLease(): boolean {
  try {
    const current = localStorage.getItem(LEASE_KEY);
    return current === null || current === tabId;
  } catch {
    return true;
  }
}

export function claimLease(): void {
  fenced = false;
  try {
    localStorage.setItem(LEASE_KEY, tabId);
  } catch {
    /* ignore */
  }
}

export function reclaimLease(): void {
  claimLease();
}

export function clearLease(): void {
  try {
    localStorage.removeItem(LEASE_KEY);
  } catch {
    /* ignore */
  }
}

export function isFenced(): boolean {
  return fenced;
}

export function fencePersistence(): void {
  fenced = true;
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
  if (typeof window === 'undefined') return;
  window.addEventListener('storage', (event: StorageEvent) => {
    if (event.key === RESET_KEY) {
      onHardReset();
      window.location.reload();
      return;
    }
    if (event.key === LEASE_KEY && event.newValue !== tabId && !fenced) {
      fenced = true;
      fireFenced();
    }
  });

  setInterval(() => {
    if (fenced) return;
    if (!checkLease()) {
      fenced = true;
      fireFenced();
    }
  }, 3000);
}

export function resetStorageCoordinationForTests(): void {
  fenced = false;
  fencedListeners.clear();
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
