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
}
