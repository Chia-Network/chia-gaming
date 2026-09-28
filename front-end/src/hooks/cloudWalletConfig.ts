/**
 * Cloud Wallet connection config (OAuth client id + endpoints).
 *
 * Fixed per build and resolved at call time for the selected network:
 * window.__CLOUD_WALLET_* / process.env overrides (via constants/env) ->
 * hardcoded per-network default.
 */
import { isTestnet } from '../constants/currency';
import {
  CLOUD_WALLET_OVERRIDE,
  MAINNET_CLOUD_WALLET,
  TESTNET_CLOUD_WALLET,
  type CloudWalletEndpoints,
} from '../constants/env';

function stripTrailingSlash(value: string): string {
  return value.replace(/\/$/, '');
}

function resolve(key: keyof CloudWalletEndpoints): string {
  const defaults = isTestnet() ? TESTNET_CLOUD_WALLET : MAINNET_CLOUD_WALLET;
  return (CLOUD_WALLET_OVERRIDE[key] || defaults[key]).trim();
}

export function getCloudWalletClientId(): string {
  return resolve('clientId');
}

export function getCloudWalletApiUrl(): string {
  return stripTrailingSlash(resolve('apiUrl'));
}

export function getCloudWalletUiUrl(): string {
  return stripTrailingSlash(resolve('uiUrl'));
}
