import { ProposalTypes } from '@walletconnect/types';

import { CHAIN_ID_OVERRIDE, MAINNET_CHAIN_ID, TESTNET_CHAIN_ID } from './env';
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

export function getRequiredNamespaces(): ProposalTypes.RequiredNamespaces {
  return {
    chia: {
      methods: Object.values(ChiaMethod),
      chains: [getChainId()],
      events: [],
    },
  };
}
