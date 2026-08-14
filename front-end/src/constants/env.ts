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
