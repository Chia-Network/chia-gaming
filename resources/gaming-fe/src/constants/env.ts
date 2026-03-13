export const PROJECT_ID = 'b919da6c796177dc819d12110ce22cc4';
export const RELAY_URL = 'wss://relay.walletconnect.com';
export const CHAIN_ID = 'chia:mainnet';

export const GENESIS_CHALLENGES: Record<string, string> = {
  'chia:mainnet': 'ccd5bb71183532bff220ba46c268991a3ff07eb358e8255a65c30a2dce0e5fbb',
  'chia:testnet10': 'ae83525ba8d1dd3f09b277de18ca3e43fc0af20d20c4b3e92ef2a48bd291ccb2',
};

// WalletConnect uses 'chia:testnet' but the genesis challenge is keyed under 'chia:testnet10'
const CHAIN_ID_TO_GENESIS_KEY: Record<string, string> = {
  'chia:mainnet': 'chia:mainnet',
  'chia:testnet': 'chia:testnet10',
};

export function getGenesisChallenge(chainId: string): string {
  const genesisKey = CHAIN_ID_TO_GENESIS_KEY[chainId];
  if (!genesisKey) {
    throw new Error(
      `Unknown chain ID "${chainId}". Expected one of: ${Object.keys(CHAIN_ID_TO_GENESIS_KEY).join(', ')}`
    );
  }
  const challenge = GENESIS_CHALLENGES[genesisKey];
  if (!challenge) {
    throw new Error(
      `No genesis challenge configured for "${genesisKey}" (chain ID: "${chainId}")`
    );
  }
  return challenge;
}

export function validateChainConfig(chainId: string): void {
  getGenesisChallenge(chainId);
}
