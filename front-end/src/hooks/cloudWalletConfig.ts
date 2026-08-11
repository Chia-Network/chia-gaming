/**
 * User-editable Cloud Wallet connection config (OAuth client id + endpoints).
 *
 * Persisted separately from auth tokens so the whole OAuth flow can be set up
 * from the player UI. Values are resolved at call time in the following order:
 * persisted value -> window.__CLOUD_WALLET_* / process.env (via constants/env)
 * -> hardcoded default.
 */
import {
  CLOUD_WALLET_API_URL,
  CLOUD_WALLET_CLIENT_ID,
  CLOUD_WALLET_UI_URL,
} from '../constants/env';

const STORAGE_KEY = 'appState_cloudWalletConfig';

export interface CloudWalletConfig {
  clientId: string;
  apiUrl: string;
  uiUrl: string;
}

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

export function loadCloudWalletConfig(): Partial<CloudWalletConfig> | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<CloudWalletConfig>;
    const out: Partial<CloudWalletConfig> = {};
    if (typeof parsed.clientId === 'string') out.clientId = parsed.clientId;
    if (typeof parsed.apiUrl === 'string') out.apiUrl = parsed.apiUrl;
    if (typeof parsed.uiUrl === 'string') out.uiUrl = parsed.uiUrl;
    return out;
  } catch {
    return null;
  }
}

export function saveCloudWalletConfig(config: CloudWalletConfig): void {
  const normalized: CloudWalletConfig = {
    clientId: config.clientId.trim(),
    apiUrl: stripTrailingSlash(config.apiUrl.trim()),
    uiUrl: stripTrailingSlash(config.uiUrl.trim()),
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized));
}

export function clearCloudWalletConfig(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function getCloudWalletClientId(): string {
  const stored = loadCloudWalletConfig();
  return (stored?.clientId || CLOUD_WALLET_CLIENT_ID || '').trim();
}

export function getCloudWalletApiUrl(): string {
  const stored = loadCloudWalletConfig();
  return stripTrailingSlash((stored?.apiUrl || CLOUD_WALLET_API_URL).trim());
}

export function getCloudWalletUiUrl(): string {
  const stored = loadCloudWalletConfig();
  return stripTrailingSlash((stored?.uiUrl || CLOUD_WALLET_UI_URL).trim());
}
