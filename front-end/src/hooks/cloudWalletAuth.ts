/**
 * Persist Cloud Wallet OAuth tokens and selected walletId outside WalletConnect storage.
 */

const STORAGE_KEY = 'appState_cloudWalletAuth';

export interface CloudWalletAuthState {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  walletId: string;
}

export function loadCloudWalletAuth(): CloudWalletAuthState | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CloudWalletAuthState>;
    if (
      typeof parsed.accessToken !== 'string' ||
      typeof parsed.refreshToken !== 'string' ||
      typeof parsed.expiresAt !== 'number' ||
      typeof parsed.walletId !== 'string' ||
      !parsed.accessToken ||
      !parsed.refreshToken ||
      !parsed.walletId
    ) {
      return null;
    }
    return {
      accessToken: parsed.accessToken,
      refreshToken: parsed.refreshToken,
      expiresAt: parsed.expiresAt,
      walletId: parsed.walletId,
    };
  } catch {
    return null;
  }
}

export function saveCloudWalletAuth(state: CloudWalletAuthState): void {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

export function clearCloudWalletAuth(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
  try {
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
  } catch {
    // ignore
  }
}

const OAUTH_PENDING_KEY = 'appState_cloudWalletOAuthPending';

export interface CloudWalletOAuthPending {
  state: string;
  codeVerifier: string;
  createdAtMs: number;
}

export function saveOAuthPending(pending: CloudWalletOAuthPending): void {
  sessionStorage.setItem(OAUTH_PENDING_KEY, JSON.stringify(pending));
}

export function loadOAuthPending(): CloudWalletOAuthPending | null {
  try {
    const raw = sessionStorage.getItem(OAUTH_PENDING_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CloudWalletOAuthPending>;
    if (
      typeof parsed.state !== 'string' ||
      typeof parsed.codeVerifier !== 'string' ||
      typeof parsed.createdAtMs !== 'number'
    ) {
      return null;
    }
    return {
      state: parsed.state,
      codeVerifier: parsed.codeVerifier,
      createdAtMs: parsed.createdAtMs,
    };
  } catch {
    return null;
  }
}

export function clearOAuthPending(): void {
  try {
    sessionStorage.removeItem(OAUTH_PENDING_KEY);
  } catch {
    // ignore
  }
}
