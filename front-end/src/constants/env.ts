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
