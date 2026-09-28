export const PROJECT_ID = 'b919da6c796177dc819d12110ce22cc4';
export const RELAY_URL = 'wss://relay.walletconnect.com';

const _win = typeof window !== 'undefined' ? (window as any) : {};
const _env = typeof process !== 'undefined' ? process.env : {};

/** WalletConnect CAIP-2 chain ids for each supported Chia network. */
export const MAINNET_CHAIN_ID = 'chia:mainnet';
export const TESTNET_CHAIN_ID = 'chia:testnet';

/**
 * Optional hard override for the WalletConnect chain id, for CI / testing.
 * When set it wins over the user-selected network preference.
 */
export const CHAIN_ID_OVERRIDE: string | undefined =
  _win.__CHIA_GAMING_CHAIN_ID__ || _env.CHIA_GAMING_CHAIN_ID || undefined;

/**
 * Genesis challenge (AGG_SIG_ME additional data) for each supported Chia
 * network, as 32-byte hex. This value is folded into every AGG_SIG_ME
 * signature, so it must match the network the connected wallet is on or the
 * node will reject the spend. Testnet target is testnet11.
 */
export const MAINNET_GENESIS_CHALLENGE =
  'ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb';
export const TESTNET_GENESIS_CHALLENGE =
  '37a90eb5185a9c4439a91ddc98bbadce7b4feba060d50116a067de66bf236615';

/**
 * Optional hard override for the genesis challenge, for CI / testing.
 * When set it wins over the user-selected network preference.
 */
export const GENESIS_CHALLENGE_OVERRIDE: string | undefined =
  _win.__CHIA_GAMING_GENESIS_CHALLENGE__ || _env.CHIA_GAMING_GENESIS_CHALLENGE || undefined;

export interface CloudWalletEndpoints {
  /** API origin (authorize, token, graphql). */
  apiUrl: string;
  /** UI origin (consent, signature-request approve popup). */
  uiUrl: string;
  /** OAuth client_id registered for Chia Gaming. */
  clientId: string;
}

export const MAINNET_CLOUD_WALLET: CloudWalletEndpoints = {
  apiUrl: 'https://api.vault.chia.net',
  uiUrl: 'https://vault.chia.net',
  clientId: 'vzgg2w46rv9qwrehkf7fqwrg',
};

export const TESTNET_CLOUD_WALLET: CloudWalletEndpoints = {
  apiUrl: 'https://api.vault.chiatest.net',
  uiUrl: 'https://vault.chiatest.net',
  clientId: 't65ikzv2xf838al5tk5v4fee',
};

/**
 * Optional hard overrides for the Cloud Wallet endpoints, for local
 * development. When set they win over the per-network defaults.
 */
export const CLOUD_WALLET_OVERRIDE: Partial<CloudWalletEndpoints> = {
  apiUrl: _win.__CLOUD_WALLET_API_URL__ || _env.CHIA_GAMING_CLOUD_WALLET_API_URL || undefined,
  uiUrl: _win.__CLOUD_WALLET_UI_URL__ || _env.CHIA_GAMING_CLOUD_WALLET_UI_URL || undefined,
  clientId: _win.__CLOUD_WALLET_CLIENT_ID__ || _env.CHIA_GAMING_CLOUD_WALLET_CLIENT_ID || undefined,
};

/** Fixed OAuth redirect path on the gaming origin. */
export const CLOUD_WALLET_OAUTH_CALLBACK_PATH = '/oauth/callback';

export const CLOUD_WALLET_OAUTH_SCOPES =
  'wallet.read offer.create offer.read offer.cancel signatureRequest.submit offline_access';
