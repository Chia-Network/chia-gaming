import { ProposalTypes } from '@walletconnect/types';

import {
  CHAIN_ID_OVERRIDE,
  MAINNET_CHAIN_ID,
  TESTNET_CHAIN_ID,
  GENESIS_CHALLENGE_OVERRIDE,
  MAINNET_GENESIS_CHALLENGE,
  TESTNET_GENESIS_CHALLENGE,
} from './env';
import { isTestnet } from './currency';
import { getNetwork } from '../hooks/save';

export enum ChiaMethod {
  GetWallets = 'chia_getWallets',
  GetWalletBalance = 'chia_getWalletBalance',
  GetNextAddress = 'chia_getNextAddress',
  GetHeightInfo = 'chia_getHeightInfo',
  SelectCoins = 'chia_selectCoins',
  CreateOfferForIds = 'chia_createOfferForIds',
  PushTransactions = 'chia_pushTransactions',
  CreateNewRemoteWallet = 'chia_createNewRemoteWallet',
  RegisterRemoteCoins = 'chia_registerRemoteCoins',
  GetCoinRecordsByNames = 'chia_getCoinRecordsByNames',
  GetPuzzleAndSolution = 'chia_getPuzzleAndSolution',
}

/**
 * WalletConnect CAIP-2 chain id for the currently-selected Chia network.
 * A build-time/window override wins over the persisted network preference.
 */
export function getChainId(): string {
  if (CHAIN_ID_OVERRIDE) return CHAIN_ID_OVERRIDE;
  return getNetwork() === 'testnet' ? TESTNET_CHAIN_ID : MAINNET_CHAIN_ID;
}

/**
 * Genesis challenge (AGG_SIG_ME additional data) hex for the currently-selected
 * Chia network. A build-time/window override wins over the persisted network
 * preference. This is threaded into the WASM game session so on-chain signatures
 * (channel funding, unroll, clean-shutdown payouts) match the connected network.
 *
 * Reads the preference via `isTestnet()` (a direct, read-only lookup) rather
 * than `getNetwork()`, which would seed the session-save cache with a
 * non-durable `preferences` record as a side effect — that seeding trips the
 * durability guard when this runs inside session creation.
 */
export function getGenesisChallenge(): string {
  if (GENESIS_CHALLENGE_OVERRIDE) return GENESIS_CHALLENGE_OVERRIDE;
  return isTestnet() ? TESTNET_GENESIS_CHALLENGE : MAINNET_GENESIS_CHALLENGE;
}

export function getRequiredNamespaces(): ProposalTypes.RequiredNamespaces {
  return {
    chia: {
      methods: Object.values(ChiaMethod),
      chains: [getChainId()],
      events: [],
    },
  };
}
