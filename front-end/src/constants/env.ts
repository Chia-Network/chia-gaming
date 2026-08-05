export const PROJECT_ID = 'b919da6c796177dc819d12110ce22cc4';
export const RELAY_URL = 'wss://relay.walletconnect.com';
export const CHAIN_ID = 'chia:mainnet';

const _win = typeof window !== 'undefined' ? (window as any) : {};
const _env = typeof process !== 'undefined' ? process.env : {};

/** Cloud Wallet API origin (authorize, token, graphql). */
export const CLOUD_WALLET_API_URL: string =
  _win.__CLOUD_WALLET_API_URL__ || _env.CHIA_GAMING_CLOUD_WALLET_API_URL || 'http://127.0.0.1:3001';

/** Cloud Wallet UI origin (consent, signature-request approve popup). */
export const CLOUD_WALLET_UI_URL: string =
  _win.__CLOUD_WALLET_UI_URL__ || _env.CHIA_GAMING_CLOUD_WALLET_UI_URL || 'http://127.0.0.1:3000';

/** OAuth client_id registered for Chia Gaming. */
export const CLOUD_WALLET_CLIENT_ID: string =
  _win.__CLOUD_WALLET_CLIENT_ID__ || _env.CHIA_GAMING_CLOUD_WALLET_CLIENT_ID || '';

/** Fixed OAuth redirect path on the gaming origin. */
export const CLOUD_WALLET_OAUTH_CALLBACK_PATH = '/oauth/callback';

export const CLOUD_WALLET_OAUTH_SCOPES =
  'wallet.read transfer.create signatureRequest.submit offline_access';
